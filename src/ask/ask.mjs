/**
 * 问答：热键/CLI 触发 → 强制识一屏 → 知识包名词优先 → Session followup（有 agents 时）/ askOnce 降级。
 * MVP 不做 ASR；打字输入即可。热键由宿主注册（可缺省）。
 */

import { filterBySpoiler, buildBubble } from '../policy/speak.mjs';
import {
  buildGlossaryInjectText,
  buildScreenInjectText,
} from '../host/session.mjs';

function normalizeTerm(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 在 glossary 里找最相关词条 */
export function lookupGlossary(question, glossary = [], spoilerTier = 'light') {
  const q = normalizeTerm(question);
  if (!q) return null;
  const pool = filterBySpoiler(glossary, spoilerTier);
  let best = null;
  let bestScore = 0;
  for (const item of pool) {
    const term = normalizeTerm(item?.term ?? item?.name ?? item?.title);
    if (!term) continue;
    let score = 0;
    if (q === term) score = 100;
    else if (q.includes(term) || term.includes(q)) score = 80;
    else {
      const rawTerm = String(item?.term ?? '');
      if (rawTerm && String(question).includes(rawTerm)) score = 70;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 70 ? best : null;
}

/** 组装回答文案（≤ maxChars 给气泡；full 给收藏）。 */
export function composeAnswer(options = {}) {
  const {
    question = '',
    glossaryHit = null,
    vision = null,
    maxChars = 40,
    sessionReply = '',
  } = options;

  const fromSession = String(sessionReply ?? '').trim();
  if (fromSession) {
    return {
      source: 'session',
      full: fromSession,
      bubble: buildBubble(fromSession, maxChars),
      id: null,
    };
  }

  if (glossaryHit) {
    const brief = String(glossaryHit.brief ?? glossaryHit.detail ?? '').trim();
    const term = String(glossaryHit.term ?? glossaryHit.name ?? '').trim();
    const full = term ? `${term}：${brief}` : brief;
    return {
      source: 'glossary',
      full,
      bubble: buildBubble(full, maxChars),
      id: glossaryHit.id,
    };
  }

  const suggestion = String(vision?.suggestion ?? '').trim();
  const summary = String(vision?.summary ?? '').trim();
  const full =
    suggestion ||
    summary ||
    `暂时没查到「${question}」，标定日期后再问问看。`;
  return {
    source: suggestion || summary ? 'vision' : 'fallback',
    full,
    bubble: buildBubble(full, maxChars),
    id: null,
  };
}

async function captureVision(ctx = {}) {
  const { capture, probe, vision, bufferToBase64 } = ctx;
  let visionResult = null;
  let captureOk = false;
  try {
    const windowInfo = probe ? await probe() : null;
    if (capture && windowInfo) {
      const shot = await capture(windowInfo);
      const imageBase64 = bufferToBase64
        ? bufferToBase64(shot.buffer)
        : Buffer.from(shot.buffer).toString('base64');
      visionResult = await vision.describe({
        imageBase64,
        mimeType: shot.mimeType ?? 'image/png',
      });
      captureOk = true;
    } else if (vision?.describe) {
      visionResult = await vision.describe({
        imageBase64: 'AA==',
        mimeType: 'image/png',
      });
    }
  } catch (err) {
    visionResult = {
      scene: 'unknown',
      summary: '',
      suggestion: '',
      spoilerLevel: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { visionResult, captureOk };
}

function finishAsk(ctx, payload) {
  const { overlay, favorites, state = {}, config = {} } = ctx;
  const { question, answer, visionResult, captureOk, mode, session = null, sessionError = '' } =
    payload;

  overlay?.speak?.(answer.bubble, { at: Date.now() / 1000, source: 'ask' });

  let favorite = null;
  if (favorites && answer.full) {
    favorite = favorites.add({
      text: answer.full,
      question,
      source: answer.source,
      gameDate: state.calibration?.gameDate ?? '',
    });
  }

  return {
    ok: true,
    question,
    answer,
    vision: visionResult,
    captureOk,
    favorite,
    mode: mode || 'askOnce',
    session,
    sessionError: sessionError || '',
    bubbleMaxChars: config.bubbleMaxChars ?? 40,
  };
}

/**
 * 执行一次问答（强制识屏）。无 Session，孤立 askOnce。
 */
export async function askOnce(ctx = {}, question = '') {
  const q = String(question ?? '').trim();
  if (!q) return { ok: false, reason: 'empty-question' };

  const { knowledge, config = {}, state = {} } = ctx;
  const { visionResult, captureOk } = await captureVision(ctx);

  const pack = knowledge ?? { glossary: [] };
  const hit = lookupGlossary(
    q,
    pack.glossary ?? [],
    config.policy?.spoilerDefault ?? 'light',
  );
  const answer = composeAnswer({
    question: q,
    glossaryHit: hit,
    vision: visionResult,
    maxChars: config.bubbleMaxChars ?? 40,
  });

  return finishAsk(ctx, {
    question: q,
    answer,
    visionResult,
    captureOk,
    mode: 'askOnce',
  });
}

/**
 * 陪玩提问：游戏前台时识屏 → glossary → 尽量走 DSH Session followup；失败则 askOnce。
 * 桌面闲聊传 skipScreenLook：不截屏、不 inject 画面摘要，仍走同一条 Session。
 *
 * @param {object} ctx
 * @param {string} question
 * @param {{ forceAskOnce?: boolean, skipScreenLook?: boolean, forceScreenLook?: boolean }} [options]
 */
export async function askCompanion(ctx = {}, question = '', options = {}) {
  const q = String(question ?? '').trim();
  if (!q) return { ok: false, reason: 'empty-question' };

  const skipScreenLook = options.skipScreenLook === true && options.forceScreenLook !== true;

  if (options.forceAskOnce || (!ctx.session && !skipScreenLook)) {
    const once = await askOnce(ctx, q);
    if (once.ok) once.mode = options.forceAskOnce ? 'askOnce-forced' : 'askOnce';
    return once;
  }

  const { knowledge, config = {}, state = {}, session } = ctx;
  const captured = skipScreenLook
    ? { visionResult: null, captureOk: false }
    : await captureVision(ctx);
  const { visionResult, captureOk } = captured;

  const pack = knowledge ?? { glossary: [] };
  const hit = lookupGlossary(
    q,
    pack.glossary ?? [],
    config.policy?.spoilerDefault ?? 'light',
  );

  const screenText = skipScreenLook
    ? ''
    : buildScreenInjectText({
        vision: visionResult,
        gameDate: state.calibration?.gameDate ?? '',
        timeSlot: state.calibration?.timeSlot ?? '',
        captureOk,
      });
  const glossaryText = buildGlossaryInjectText(hit);

  if (!session) {
    const answer = composeAnswer({
      question: q,
      glossaryHit: hit,
      vision: visionResult,
      maxChars: config.bubbleMaxChars ?? 40,
    });
    return finishAsk(ctx, {
      question: q,
      answer,
      visionResult,
      captureOk,
      mode: 'askOnce',
    });
  }

  let sessionResult = null;
  try {
    sessionResult = await session.followupAsk(q, {
      screenText,
      glossaryText,
    });
  } catch (error) {
    sessionResult = {
      ok: false,
      reason: 'followup-threw',
      mode: 'askOnce',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (sessionResult?.ok && sessionResult.mode === 'session') {
    const answer = composeAnswer({
      question: q,
      glossaryHit: hit,
      vision: visionResult,
      sessionReply: sessionResult.reply,
      maxChars: config.bubbleMaxChars ?? 40,
    });
    // Session 没抠到助手原文时，用 glossary/vision 本地组装气泡，但 mode 仍标 session
    return finishAsk(ctx, {
      question: q,
      answer,
      visionResult,
      captureOk,
      mode: 'session',
      session: sessionResult.session || session.describe?.() || null,
    });
  }

  const answer = composeAnswer({
    question: q,
    glossaryHit: hit,
    vision: visionResult,
    maxChars: config.bubbleMaxChars ?? 40,
  });
  return finishAsk(ctx, {
    question: q,
    answer,
    visionResult,
    captureOk,
    mode: 'askOnce',
    session: sessionResult?.session || session.describe?.() || null,
    sessionError:
      sessionResult?.message ||
      sessionResult?.reason ||
      'session-unavailable',
  });
}

export default { askOnce, askCompanion, lookupGlossary, composeAnswer };
