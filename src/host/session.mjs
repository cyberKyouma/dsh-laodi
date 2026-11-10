/**
 * 陪玩固定 DSH Session：ensure / resume / followup / inject。
 *
 * agents 用软取（ctx.get('agents', false)），不硬 inject，避免 Magpie 加载顺序导致插件起不来。
 * agents 不可用时明确降级，由 ask 层回退 askOnce。
 *
 * 关键约束（DSH 侧）：
 * - 会话的 cwd 写进不可变的 SessionHeader，落盘目录由它决定；没有 cwd 的会话会进
 *   ~/.dsh/sessions/_no-cwd/，侧边栏也认不出来。
 * - 工作区成员资格要拿 header.cwd 与工作区目录比对（canonical path），
 *   所以建会话时必须把 cwd 设成工作区目录，再 attach。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  attachSessionToWorkspaceViaHost,
  detachSessionFromWorkspaceViaHost,
  ensureCompanionWorkspaceViaHost,
  readWorkspaceStore,
  resolveCompanionWorkspaceState,
} from './workspace.mjs';
import { registerCompanionTools } from './companion-tools.mjs';

export const SESSION_SOURCE = Object.freeze({ kind: 'dsh-laodi' });
export const USER_SOURCE = Object.freeze({ kind: 'user' });
export const DEFAULT_SESSION_TITLE = '陪玩';
/** 点「确保 Session」时发的开场，让 DSH 把空白会话从侧栏里显示出来。 */
export const SESSION_UNVEIL_PROMPT = '先打个招呼，我在玩 P5R。';

/** 比较两个目录是不是同一个（Windows 大小写不敏感）。 */
export function samePath(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/**
 * 读一条会话真实的 cwd（SessionHeader）。
 * DSH 把 cwd 放在 session.header.cwd；不同版本位置略有差异，这里多试几处。
 */
export function readSessionCwd(agent) {
  const candidates = [
    agent?.session?.header?.cwd,
    agent?.session?.meta?.cwd,
    agent?.header?.cwd,
    agent?.cwd,
  ];
  for (const value of candidates) {
    const cwd = String(value ?? '').trim();
    if (cwd) return cwd;
  }
  return '';
}

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
 * @param {() => any} [options.getWorkspaceRegistry]  ctx.workspaceRegistry（可空）
 * @param {() => any} [options.getSessionTitle]       ctx.sessionTitle（可空）
 * @param {() => object} [options.getToolDeps]         screen_look / glossary_lookup 依赖
 * @param {() => { provider?: string, model?: string }} [options.getAgentOptions]
 * @param {() => any} [options.getAgentDefaultModel]  ctx.agentDefaultModel（可空）
 * @param {string} [options.sessionTitle]              会话标题，默认「陪玩」
 * @param {(line: string) => void} [options.trace]
 * @param {number} [options.idleTimeoutMs]
 */
export function createCompanionSessionManager(options = {}) {
  const {
    getAgents: resolveAgents = () => undefined,
    getSettings = () => ({}),
    persistSettings = () => ({}),
    getWorkspaceRegistry: resolveWorkspaceRegistry = () => undefined,
    getSessionTitle: resolveSessionTitle = () => undefined,
    getToolDeps: resolveToolDeps = () => ({}),
    getAgentOptions: resolveAgentOptionsCb = () => ({}),
    getAgentDefaultModel: resolveAgentDefaultModel = () => undefined,
    sessionTitle = DEFAULT_SESSION_TITLE,
    trace = () => {},
    idleTimeoutMs = 90_000,
  } = options;

  /** @type {any} */
  let handle = null;
  let lastError = '';
  let lastMode = 'unknown';
  let lastAskAt = '';
  let lastCwd = '';
  let lastTargetCwd = '';
  let lastAttach = null;
  let lastTools = null;

  function currentId() {
    return String(getSettings()?.companionSessionId || '').trim();
  }

  /** create/resume setup，或活 agent.ctx：挂 screen_look / glossary_lookup */
  async function installTools(agentCtx) {
    try {
      const result = await registerCompanionTools(agentCtx, resolveToolDeps, { trace });
      lastTools = result;
      if (result?.ok) {
        trace(`companion tools registered: ${(result.registered || []).join(',')}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastTools = { ok: false, reason: 'install-threw', message, registered: [] };
      trace(`companion tools install failed: ${message}`);
      return lastTools;
    }
  }

  async function setupAgent(agentCtx) {
    // setup 允许返回 Promise；工厂会 await。
    // 注意：返回值若是普通对象，DSH 会当成 AgentSetupCommit 并调 .commit()，
    // 于是出现 setupCommit?.commit is not a function —— 这里必须不返回结果。
    await installTools(agentCtx);
  }

  /**
   * 建/恢复 agent 时必须带 provider+model，否则 followup/unveil 会报：
   *   has no provider/model: set AgentOptions.provider and AgentOptions.model
   */
  function resolveAgentOptions() {
    try {
      const fromCb = resolveAgentOptionsCb?.() || {};
      const provider = String(fromCb.provider || '').trim();
      const model = String(fromCb.model || '').trim();
      if (provider && model) return { provider, model };
    } catch (error) {
      trace(`getAgentOptions failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const adm = resolveAgentDefaultModel?.();
      const sel = adm?.currentSelection?.();
      const provider = String(sel?.provider || '').trim();
      const model = String(sel?.model || '').trim();
      if (provider && model) return { provider, model };
    } catch (error) {
      trace(
        `agentDefaultModel.currentSelection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {};
  }

  function resolveWorkspaceState() {
    const settings = getSettings() || {};
    return resolveCompanionWorkspaceState(
      settings,
      process.env,
      resolveWorkspaceRegistry() || null,
    );
  }

  function describe() {
    const settings = getSettings() || {};
    const id = currentId();
    const agents = resolveAgents();
    const live = id && agents && typeof agents.get === 'function' ? agents.get(id) : null;
    const workspace = resolveWorkspaceState();
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
      workspacePath: String(workspace?.path || ''),
      workspaceRegistered: Boolean(workspace?.registered),
      // 会话落盘目录由 SessionHeader.cwd 决定；没有 cwd 的会话会落到 ~/.dsh/sessions/_no-cwd
      cwd: readSessionCwd(live || handle?.agent) || lastCwd || '',
      targetCwd: lastTargetCwd || String(workspace?.path || ''),
      attached: Boolean(id && (workspace?.sessionIds || []).includes(id)),
      revealed: Boolean(id && currentRevealedId() === id),
      title: sessionTitle,
      lastAttach: lastAttach || null,
      tools: lastTools,
    };
  }

  function persistId(sessionId) {
    const id = String(sessionId || '').trim();
    const patch = { companionSessionId: id };
    if (!id) patch.companionSessionRevealedId = '';
    const next = persistSettings(patch);
    return String(next?.companionSessionId || id).trim();
  }

  function currentRevealedId() {
    return String(getSettings()?.companionSessionRevealedId || '').trim();
  }

  function persistRevealedId(sessionId) {
    const id = String(sessionId || '').trim();
    const next = persistSettings({ companionSessionRevealedId: id });
    return String(next?.companionSessionRevealedId || id).trim();
  }

  /**
   * DSH 侧栏会藏掉空白会话（sessionListMetadata.blank=true）。
   * 发一句用户开场让它可见；已揭晓的会话不重复。
   * 不要从 ensure() 里调，否则 /ask 的 ensure 也会冒打招呼。
   */
  async function unveil(sessionId = currentId()) {
    const id = String(sessionId || currentId() || '').trim();
    if (!id) {
      return { ok: false, unveiled: false, reason: 'no-session' };
    }
    if (currentRevealedId() === id) {
      return { ok: true, unveiled: false, skipped: true, sessionId: id };
    }
    const agent = handle?.agent;
    if (!agent || typeof agent.followup !== 'function') {
      trace('session unveil skipped: agent.followup missing');
      return { ok: false, unveiled: false, reason: 'agent-followup-missing', sessionId: id };
    }
    try {
      agent.followup(textMessage(SESSION_UNVEIL_PROMPT, USER_SOURCE));
      lastAskAt = new Date().toISOString();
      lastMode = 'session';
      lastError = '';
      if (typeof agent.whenIdle === 'function') {
        await Promise.race([agent.whenIdle(), sleep(idleTimeoutMs)]);
      }
      persistRevealedId(id);
      const reply = extractAssistantReply(agent, handle);
      trace(`session unveiled ${id}`);
      return { ok: true, unveiled: true, sessionId: id, reply };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`session unveil failed: ${message}`);
      return { ok: false, unveiled: false, reason: 'unveil-failed', message, sessionId: id };
    }
  }

  /**
   * 确保「陪玩」工作区已登记：宿主里有官方注册表就走注册表，否则写 workspace.json。
   * 返回 { id, path }；目录会被建出来（DSH 校验 cwd 必须是存在的绝对目录）。
   */
  async function ensureWorkspace() {
    const settings = getSettings() || {};
    const registry = resolveWorkspaceRegistry() || null;
    const state = resolveWorkspaceState();
    const registryKnows =
      registry && typeof registry.get === 'function' && state.id
        ? Boolean(registry.get(state.id))
        : false;

    if (state.registered && state.id && (registryKnows || !registry)) {
      // cwd 目录必须存在（DSH 会校验）
      try {
        fs.mkdirSync(state.path, { recursive: true });
      } catch (error) {
        trace(`workspace mkdir failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return state;
    }

    // 还没登记，或 DSH 的注册表里没有这份登记（老版本插件写过 workspace.json）：登记一次
    const ensured = await ensureCompanionWorkspaceViaHost({
      registry,
      env: process.env,
      // 已经登记过就别再覆盖工作区里的 persona 文件
      skipSeed: state.registered,
      workspacePath: state.path,
      workspaceTitle: state.title,
      workspaceId: state.id,
      setAsDefault: Boolean(settings.setWorkspaceDefault),
      personaPresetId: settings.personaPresetId,
      personaPluginId: settings.personaPluginId,
      petPluginId: settings.petPluginId,
    });
    if (!ensured?.ok) {
      trace(`workspace ensure failed: ${ensured?.reason || 'unknown'} ${ensured?.message || ''}`);
      return { ...state, registered: false, error: ensured?.message || ensured?.reason || '' };
    }
    persistSettings({
      workspaceId: ensured.workspace.id,
      workspacePath: ensured.workspace.path,
      workspaceTitle: ensured.workspace.title,
    });
    return {
      id: ensured.workspace.id,
      path: ensured.workspace.path,
      title: ensured.workspace.title,
      registered: true,
      source: ensured.via || 'file',
      sessionIds: [],
    };
  }

  async function linkWorkspace(sessionId) {
    const settings = getSettings() || {};
    const workspaceId = String(settings.workspaceId || '').trim();
    if (!workspaceId || !sessionId) {
      return { ok: false, reason: 'workspace-or-session-missing' };
    }
    try {
      const result = await attachSessionToWorkspaceViaHost({
        registry: resolveWorkspaceRegistry() || null,
        workspaceId,
        sessionId,
        env: process.env,
      });
      lastAttach = result?.ok
        ? { ok: true, via: result.via || 'file', added: Boolean(result.added) }
        : {
            ok: false,
            reason: result?.reason || 'attach-failed',
            message: result?.message || '',
          };
      if (!result?.ok) {
        trace(`attach session failed: ${result?.reason || 'unknown'} ${result?.message || ''}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`attach session failed: ${message}`);
      lastAttach = { ok: false, reason: 'attach-failed', message };
      return { ok: false, reason: 'attach-failed', message };
    }
  }

  /** 会话作废时把它从工作区摘掉（免得侧边栏留着废会话）。 */
  async function detachWorkspace(sessionId) {
    const settings = getSettings() || {};
    const workspaceId = String(settings.workspaceId || '').trim();
    if (!workspaceId || !sessionId) return { ok: false, reason: 'workspace-or-session-missing' };
    try {
      return await detachSessionFromWorkspaceViaHost({
        registry: resolveWorkspaceRegistry() || null,
        workspaceId,
        sessionId,
        env: process.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`detach session failed: ${message}`);
      return { ok: false, reason: 'detach-failed', message };
    }
  }

  /** 给会话起个固定标题（ctx.sessionTitle.rename 会 pin 住标题）。 */
  function applyTitle(agent) {
    const titleService = resolveSessionTitle();
    if (!titleService || typeof titleService.rename !== 'function') return false;
    const session = agent?.session;
    if (!session) return false;
    try {
      if (typeof titleService.get === 'function') {
        const existing = titleService.get(session);
        if (existing && existing.title) return false;
      }
      titleService.rename(session, sessionTitle);
      return true;
    } catch (error) {
      trace(`session title failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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
   *
   * 三条硬约束（DSH 侧）：
   * 1. 建会话必须带 cwd（meta.cwd = 工作区目录），否则落进 ~/.dsh/sessions/_no-cwd；
   * 2. resume 的参数名是 resumeSessionId；
   * 3. cwd 与工作区对不上（老会话没有 cwd，或在别的目录）时不能硬用，
   *    只能丢掉旧会话另建一条落在工作区目录里的。
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

    // 工作区先就位：会话的 cwd 与挂载都要用它
    const workspace = await ensureWorkspace();
    const cwd = String(workspace?.path || '').trim();
    lastTargetCwd = cwd;

    if (forceNew) {
      await disposeHandle();
      persistId('');
    }

    let sessionId = currentId();

    try {
      if (sessionId && typeof agents.get === 'function') {
        const live = agents.get(sessionId);
        if (live) {
          const liveCwd = readSessionCwd(live);
          if (!cwd || !liveCwd || samePath(liveCwd, cwd)) {
            handle = handle && handle.agent === live ? handle : { agent: live, dispose: async () => {} };
            lastError = '';
            lastMode = 'session';
            lastCwd = liveCwd;
            const attached = await linkWorkspace(sessionId);
            if (attached?.ok || !cwd || liveCwd) {
              applyTitle(live);
              if (live?.ctx) await installTools(live.ctx);
              return {
                ok: true,
                mode: 'session',
                sessionId,
                created: false,
                resumed: false,
                live: true,
                cwd: lastCwd,
              };
            }
            // 活着的会话没有 cwd，DSH 不认它属于这个工作区：另建一条
            trace('live session has no cwd and attach was rejected; recreating');
            await disposeHandle();
            await detachWorkspace(sessionId);
            sessionId = '';
            persistId('');
          } else {
            // 活着的会话 cwd 对不上工作区：换一条
            trace(`live session cwd mismatch (${liveCwd} != ${cwd}); recreating`);
            await disposeHandle();
            await detachWorkspace(sessionId);
            sessionId = '';
            persistId('');
          }
        }
      }

      if (sessionId && typeof agents.resume === 'function') {
        try {
          // DSH 的 resume 参数叫 resumeSessionId；sessionId 只是兼容旧写法
          handle = await agents.resume({
            resumeSessionId: sessionId,
            sessionId,
            agentOptions: resolveAgentOptions(),
            setup: setupAgent,
          });
          const resumedCwd = readSessionCwd(handle?.agent);
          if (cwd && !samePath(resumedCwd, cwd)) {
            // 老会话没有 cwd（_no-cwd）或落在别的目录：侧边栏认不出来，只能另建
            trace(
              `resumed session cwd ${resumedCwd || '(none)'} != ${cwd}; recreating with workspace cwd`,
            );
            await disposeHandle();
            await detachWorkspace(sessionId);
            sessionId = '';
            persistId('');
          } else {
            lastError = '';
            lastMode = 'session';
            lastCwd = resumedCwd;
            await linkWorkspace(sessionId);
            applyTitle(handle?.agent);
            if (handle?.agent?.ctx) await installTools(handle.agent.ctx);
            trace(`session resumed ${sessionId}`);
            return {
              ok: true,
              mode: 'session',
              sessionId,
              created: false,
              resumed: true,
              live: true,
              cwd: lastCwd,
            };
          }
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
      const agentOptions = resolveAgentOptions();
      if (!agentOptions.provider || !agentOptions.model) {
        lastError = 'missing-provider-model';
        lastMode = 'askOnce';
        return {
          ok: false,
          reason: 'missing-provider-model',
          mode: 'askOnce',
          message:
            '无法创建陪玩 Session：未找到默认 provider/model。请先在 DSH 设置里选好对话模型。',
          ...describe(),
        };
      }
      const createOpts = {
        sessionId,
        agentOptions,
        setup: setupAgent,
      };
      if (cwd) {
        // cwd 会写进不可变的 SessionHeader：落盘目录与工作区成员资格都靠它
        createOpts.meta = { cwd };
      }
      trace(`session create with ${agentOptions.provider}/${agentOptions.model}`);
      handle = await agents.create(createOpts);
      const resolvedId =
        handle?.agent?.id ||
        handle?.agent?.session?.id ||
        sessionId;
      persistId(resolvedId);
      await linkWorkspace(resolvedId);
      applyTitle(handle?.agent);
      lastError = '';
      lastMode = 'session';
      lastCwd = readSessionCwd(handle?.agent);
      trace(`session created ${resolvedId} cwd=${lastCwd || '(none)'}`);
      return {
        ok: true,
        mode: 'session',
        sessionId: resolvedId,
        created: true,
        resumed: false,
        live: true,
        cwd: lastCwd,
        targetCwd: cwd,
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
        persistRevealedId(ensured.sessionId || currentId());
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
      persistRevealedId(ensured.sessionId || currentId());
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
    const registry = resolveWorkspaceRegistry() || null;
    if (registry && typeof registry.get === 'function') {
      const workspace = registry.get(workspaceId);
      if (workspace) {
        return Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0;
      }
    }
    const { store } = readWorkspaceStore(process.env);
    const row = store.tables.workspaces[workspaceId];
    return Array.isArray(row?.sessionIds) ? row.sessionIds.length : 0;
  }

  return {
    ensure,
    followupAsk,
    unveil,
    reset,
    dispose: disposeHandle,
    describe,
    currentId,
    workspaceSessionCount,
    installTools,
    buildScreenInjectText,
    buildGlossaryInjectText,
  };
}

export default {
  optionalService,
  getAgents,
  samePath,
  readSessionCwd,
  buildScreenInjectText,
  buildGlossaryInjectText,
  extractAssistantReply,
  createCompanionSessionManager,
  DEFAULT_SESSION_TITLE,
  SESSION_UNVEIL_PROMPT,
  SESSION_SOURCE,
  USER_SOURCE,
};
