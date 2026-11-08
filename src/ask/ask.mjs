/**
 * 问答：热键/CLI 触发 → 强制识一屏 → 知识包名词优先 → 视觉兜底。
 * MVP 不做 ASR；打字输入即可。热键由宿主注册（可缺省）。
 */

import { filterBySpoiler, buildBubble } from '../policy/speak.mjs';

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
  } = options;

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

/**
 * 执行一次问答（强制识屏）。
 */
export async function askOnce(ctx = {}, question = '') {
  const q = String(question ?? '').trim();
  if (!q) return { ok: false, reason: 'empty-question' };

  const {
    capture,
    probe,
    vision,
    knowledge,
    config = {},
    state = {},
    overlay,
    favorites,
    bufferToBase64,
  } = ctx;

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

  overlay?.speak?.(answer.bubble, { at: Date.now() / 1000, source: 'ask' });

  let favorite = null;
  if (favorites && answer.full) {
    favorite = favorites.add({
      text: answer.full,
      question: q,
      source: answer.source,
      gameDate: state.calibration?.gameDate ?? '',
    });
  }

  return {
    ok: true,
    question: q,
    answer,
    vision: visionResult,
    captureOk,
    favorite,
  };
}

export default { askOnce, lookupGlossary, composeAnswer };
