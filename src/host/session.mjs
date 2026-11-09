/**
 * 陪玩固定 DSH Session：ensure / resume / followup / inject。
 *
 * agents 用软取（ctx.get('agents', false)），不硬 inject，避免 Magpie 加载顺序导致插件起不来。
 * agents 不可用时明确降级，由 ask 层回退 askOnce。
 */
import { randomUUID } from 'node:crypto';

import {
  attachSessionToWorkspace,
  readWorkspaceStore,
} from './workspace.mjs';

export const SESSION_SOURCE = Object.freeze({ kind: 'dsh-laodi' });
export const USER_SOURCE = Object.freeze({ kind: 'user' });

/** 软取 Cordis 服务：缺失返回 undefined，不抛。 */
export function optionalService(ctx, name) {
  if (!ctx || !name) return undefined;
  const get = ctx.get;
  if (typeof get === 'function') {
    try {
      return get.call(ctx, name, false);
    } catch {
      return undefined;
    }
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

export function getAgents(ctx) {
  return optionalService(ctx, 'agents');
}

/** 画面摘要 → 注入 Session 的纯文字（默认不带图）。 */
export function buildScreenInjectText(options = {}) {
  const {
    vision = null,
    gameDate = '',
    timeSlot = '',
    captureOk = false,
  } = options;
  const lines = ['[陪玩识屏摘要]'];
  if (gameDate) {
    lines.push(`游戏日期：${gameDate}${timeSlot ? ` · ${timeSlot}` : ''}`);
  }
  if (!captureOk && !vision) {
    lines.push('本轮未能截到游戏画面。');
    return lines.join('\n');
  }
  const scene = String(vision?.scene ?? '').trim();
  const summary = String(vision?.summary ?? '').trim();
  const suggestion = String(vision?.suggestion ?? '').trim();
  if (scene) lines.push(`场景：${scene}`);
  if (summary) lines.push(`画面：${summary}`);
  if (suggestion) lines.push(`画面线索：${suggestion}`);
  if (vision?.error) lines.push(`识屏备注：${vision.error}`);
  if (lines.length === 1) lines.push('画面信息不足。');
  return lines.join('\n');
}

/** glossary 命中 → 注入文字，避免模型瞎编。 */
export function buildGlossaryInjectText(hit) {
  if (!hit) return '';
  const term = String(hit.term ?? hit.name ?? hit.title ?? '').trim();
  const brief = String(hit.brief ?? hit.detail ?? '').trim();
  if (!term && !brief) return '';
  return `[陪玩知识包]\n词条：${term || '（未命名）'}\n释义：${brief || '（无）'}`;
}

function textMessage(text, source) {
  return {
    content: [{ type: 'text', text: String(text ?? '') }],
    source,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 尝试从 agent / handle 里抠本轮助手短句（尽力而为，拿不到就返回 ''）。
 */
export function extractAssistantReply(agent, handle = null) {
  const candidates = [
    agent?.lastAssistantText,
    agent?.lastReply,
    handle?.lastAssistantText,
    typeof agent?.getLastAssistantText === 'function'
      ? agent.getLastAssistantText()
      : null,
  ];
  for (const value of candidates) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * @param {object} options
 * @param {() => unknown} options.getAgents
 * @param {() => object} options.getSettings
 * @param {(patch: object) => object} options.persistSettings  写入并返回最新 settings
 * @param {(line: string) => void} [options.trace]
 * @param {number} [options.idleTimeoutMs]
 */
export function createCompanionSessionManager(options = {}) {
  const {
    getAgents: resolveAgents = () => undefined,
    getSettings = () => ({}),
    persistSettings = () => ({}),
    trace = () => {},
    idleTimeoutMs = 90_000,
  } = options;

  /** @type {any} */
  let handle = null;
  let lastError = '';
  let lastMode = 'unknown';
  let lastAskAt = '';

  function currentId() {
    return String(getSettings()?.companionSessionId || '').trim();
  }

  function describe() {
    const settings = getSettings() || {};
    const id = currentId();
    const agents = resolveAgents();
    const live = id && agents && typeof agents.get === 'function' ? agents.get(id) : null;
    return {
      companionSessionId: id || '',
      agentsAvailable: Boolean(agents),
      live: Boolean(live || handle?.agent),
      status: live?.status || handle?.agent?.status || (id ? 'detached' : 'none'),
      lastError: lastError || '',
      lastMode,
      lastAskAt,
      attachImages: Boolean(settings.sessionAttachImages),
      workspaceId: String(settings.workspaceId || '').trim(),
    };
  }

  function persistId(sessionId) {
    const next = persistSettings({ companionSessionId: String(sessionId || '') });
    return String(next?.companionSessionId || sessionId || '').trim();
  }

  function linkWorkspace(sessionId) {
    const settings = getSettings() || {};
    const workspaceId = String(settings.workspaceId || '').trim();
    if (!workspaceId || !sessionId) {
      return { ok: false, reason: 'workspace-or-session-missing' };
    }
    try {
      return attachSessionToWorkspace({
        workspaceId,
        sessionId,
        env: process.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`attach session failed: ${message}`);
      return { ok: false, reason: 'attach-failed', message };
    }
  }

  async function disposeHandle() {
    if (!handle) return;
    const current = handle;
    handle = null;
    try {
      if (typeof current.dispose === 'function') await current.dispose();
    } catch (error) {
      trace(`session dispose: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 确保有一条陪玩 Session：优先活 agent → resume → create。
   */
  async function ensure(optionsEnsure = {}) {
    const forceNew = Boolean(optionsEnsure.forceNew);
    const agents = resolveAgents();
    if (!agents || typeof agents.create !== 'function') {
      lastMode = 'askOnce';
      lastError = 'agents-unavailable';
      return {
        ok: false,
        reason: 'agents-unavailable',
        mode: 'askOnce',
        message: 'ctx.agents 不可用，将回退 askOnce',
        ...describe(),
      };
    }

    if (forceNew) {
      await disposeHandle();
      persistId('');
    }

    let sessionId = currentId();

    try {
      if (sessionId && typeof agents.get === 'function') {
        const live = agents.get(sessionId);
        if (live) {
          handle = handle && handle.agent === live ? handle : { agent: live, dispose: async () => {} };
          lastError = '';
          lastMode = 'session';
          linkWorkspace(sessionId);
          return { ok: true, mode: 'session', sessionId, created: false, resumed: false, live: true };
        }
      }

      if (sessionId && typeof agents.resume === 'function') {
        try {
          handle = await agents.resume({ sessionId });
          lastError = '';
          lastMode = 'session';
          linkWorkspace(sessionId);
          trace(`session resumed ${sessionId}`);
          return {
            ok: true,
            mode: 'session',
            sessionId,
            created: false,
            resumed: true,
            live: true,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          trace(`session resume failed (${sessionId}): ${message}`);
          lastError = message;
          // 损坏或找不到时新建
          sessionId = '';
          persistId('');
        }
      }

      sessionId = randomUUID();
      const createOpts = {
        sessionId,
        agentOptions: {},
      };
      handle = await agents.create(createOpts);
      const resolvedId =
        handle?.agent?.id ||
        handle?.agent?.session?.id ||
        sessionId;
      persistId(resolvedId);
      linkWorkspace(resolvedId);
      lastError = '';
      lastMode = 'session';
      trace(`session created ${resolvedId}`);
      return {
        ok: true,
        mode: 'session',
        sessionId: resolvedId,
        created: true,
        resumed: false,
        live: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      lastMode = 'askOnce';
      trace(`session ensure failed: ${message}`);
      return {
        ok: false,
        reason: 'ensure-failed',
        mode: 'askOnce',
        message,
        ...describe(),
      };
    }
  }

  /**
   * 向 Session inject 文字上下文（不唤醒），再 followup 用户问题。
   */
  async function followupAsk(question, context = {}) {
    const q = String(question ?? '').trim();
    if (!q) return { ok: false, reason: 'empty-question' };

    const ensured = await ensure();
    if (!ensured.ok) {
      return {
        ok: false,
        reason: ensured.reason || 'agents-unavailable',
        mode: 'askOnce',
        message: ensured.message || lastError,
        session: describe(),
      };
    }

    const agent = handle?.agent;
    if (!agent || typeof agent.followup !== 'function') {
      lastMode = 'askOnce';
      lastError = 'agent-followup-missing';
      return {
        ok: false,
        reason: 'agent-followup-missing',
        mode: 'askOnce',
        message: 'agent.followup 不可用',
        session: describe(),
      };
    }

    const injectTexts = [];
    if (context.screenText) injectTexts.push(String(context.screenText));
    if (context.glossaryText) injectTexts.push(String(context.glossaryText));
    if (Array.isArray(context.extraInjects)) {
      for (const item of context.extraInjects) {
        const text = String(item ?? '').trim();
        if (text) injectTexts.push(text);
      }
    }

    try {
      if (typeof agent.inject === 'function') {
        for (const text of injectTexts) {
          agent.inject(textMessage(text, SESSION_SOURCE));
        }
      } else if (injectTexts.length > 0) {
        // 无 inject 时把上下文拼进 followup，避免丢画面
        const prefixed = `${injectTexts.join('\n\n')}\n\n[用户提问]\n${q}`;
        agent.followup(textMessage(prefixed, USER_SOURCE));
        lastAskAt = new Date().toISOString();
        lastMode = 'session';
        lastError = '';
        if (typeof agent.whenIdle === 'function') {
          await Promise.race([agent.whenIdle(), sleep(idleTimeoutMs)]);
        }
        const reply = extractAssistantReply(agent, handle);
        return {
          ok: true,
          mode: 'session',
          sessionId: ensured.sessionId || currentId(),
          reply,
          injected: injectTexts.length,
          session: describe(),
        };
      }

      agent.followup(textMessage(q, USER_SOURCE));
      lastAskAt = new Date().toISOString();
      lastMode = 'session';
      lastError = '';

      if (typeof agent.whenIdle === 'function') {
        await Promise.race([agent.whenIdle(), sleep(idleTimeoutMs)]);
      }

      const reply = extractAssistantReply(agent, handle);
      return {
        ok: true,
        mode: 'session',
        sessionId: ensured.sessionId || currentId(),
        reply,
        injected: injectTexts.length,
        session: describe(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      lastMode = 'askOnce';
      return {
        ok: false,
        reason: 'followup-failed',
        mode: 'askOnce',
        message,
        session: describe(),
      };
    }
  }

  async function reset() {
    await disposeHandle();
    const oldId = currentId();
    persistId('');
    lastError = '';
    lastMode = 'unknown';
    const ensured = await ensure({ forceNew: true });
    return {
      ok: Boolean(ensured.ok),
      previousSessionId: oldId,
      ...ensured,
      session: describe(),
    };
  }

  /** 只读：工作区里挂了多少 session（含本条）。 */
  function workspaceSessionCount() {
    const settings = getSettings() || {};
    const workspaceId = String(settings.workspaceId || '').trim();
    if (!workspaceId) return 0;
    const { store } = readWorkspaceStore(process.env);
    const row = store.tables.workspaces[workspaceId];
    return Array.isArray(row?.sessionIds) ? row.sessionIds.length : 0;
  }

  return {
    ensure,
    followupAsk,
    reset,
    dispose: disposeHandle,
    describe,
    currentId,
    workspaceSessionCount,
    buildScreenInjectText,
    buildGlossaryInjectText,
  };
}

export default {
  optionalService,
  getAgents,
  buildScreenInjectText,
  buildGlossaryInjectText,
  extractAssistantReply,
  createCompanionSessionManager,
  SESSION_SOURCE,
  USER_SOURCE,
};
