/**
 * 陪玩 Session 专用工具：screen_look / glossary_lookup。
 *
 * 在 agents.create / resume 的 setup(agentCtx) 里注册到 agent.ctx.tools，
 * 只对这一条陪玩 Session 可见（类似 web_search，但是游戏专用）。
 *
 * defineTool 从宿主软载 @deepseek-ai/dsh-tools；拿不到则跳过注册并记 trace，
 * 宿主提问路径仍可走 inject。
 */
import { lookupGlossary } from '../ask/ask.mjs';

export const TOOL_SCREEN_LOOK = 'screen_look';
export const TOOL_GLOSSARY_LOOKUP = 'glossary_lookup';

const SCREEN_LOOK_DESCRIPTION =
  '游戏在前台时识一屏，返回结构化摘要（scene/summary/suggestion/spoilerLevel）。' +
  '需要了解玩家眼前在干什么、或宿主没注入画面时使用。' +
  '桌面闲聊阶段宿主会拒绝识屏（reason=desktop-no-screen-look），不要反复调用。' +
  '遵守剧透档：没有依据不要编造；本工具不负责主动开口（少说策略由宿主管）。';

const GLOSSARY_LOOKUP_DESCRIPTION =
  '在陪玩知识包里查名词（Persona、地点、道具等），返回 brief 释义。' +
  '回答游戏专有名词前应优先调用，避免瞎编。' +
  '结果已按当前剧透档过滤；没有命中时明确说查不到。';

/** 软载 defineTool；失败返回 null。 */
export async function resolveDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    // 插件仓 / 冒烟环境可能没有该包
  }
  return null;
}

/**
 * 执行识屏（供工具与冒烟复用）。
 * @param {object} deps
 * @param {() => Promise<object>} deps.lookScreen  host.lookScreen()
 */
export async function executeScreenLook(deps = {}) {
  if (typeof deps.lookScreen !== 'function') {
    return {
      ok: false,
      reason: 'lookScreen-unavailable',
      scene: 'unknown',
      summary: '',
      suggestion: '',
      spoilerLevel: 0,
      captureOk: false,
      gameDate: '',
      timeSlot: '',
      windowTitle: '',
      isGame: false,
      message: '识屏能力未就绪',
    };
  }

  try {
    const shot = await deps.lookScreen();
    const vision = shot?.vision || {};
    return {
      ok: Boolean(shot?.ok !== false),
      reason: shot?.reason || '',
      scene: String(vision.scene ?? 'unknown'),
      summary: String(vision.summary ?? ''),
      suggestion: String(vision.suggestion ?? ''),
      spoilerLevel: Number(vision.spoilerLevel ?? 0) || 0,
      captureOk: Boolean(shot?.captureOk),
      gameDate: String(shot?.gameDate ?? deps.getGameDate?.() ?? ''),
      timeSlot: String(shot?.timeSlot ?? deps.getTimeSlot?.() ?? ''),
      windowTitle: String(shot?.windowTitle ?? ''),
      isGame: Boolean(shot?.isGame),
      error: vision.error ? String(vision.error) : '',
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'lookScreen-failed',
      scene: 'unknown',
      summary: '',
      suggestion: '',
      spoilerLevel: 0,
      captureOk: false,
      gameDate: String(deps.getGameDate?.() ?? ''),
      timeSlot: String(deps.getTimeSlot?.() ?? ''),
      windowTitle: '',
      isGame: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 执行 glossary 查询。
 * @param {object} deps
 * @param {string} query
 */
export function executeGlossaryLookup(deps = {}, query = '') {
  const q = String(query ?? '').trim();
  if (!q) {
    return { ok: false, reason: 'empty-query', found: false, query: '', message: '缺少 query' };
  }

  const pack = typeof deps.getKnowledge === 'function' ? deps.getKnowledge() : null;
  const glossary = pack?.glossary ?? [];
  const spoilerTier =
    (typeof deps.getSpoilerTier === 'function' && deps.getSpoilerTier()) || 'light';
  const hit = lookupGlossary(q, glossary, spoilerTier);

  if (!hit) {
    return {
      ok: true,
      found: false,
      query: q,
      spoilerTier,
      message: `知识包里没找到「${q}」（剧透档 ${spoilerTier}）`,
    };
  }

  return {
    ok: true,
    found: true,
    query: q,
    spoilerTier,
    id: hit.id ?? null,
    term: String(hit.term ?? hit.name ?? hit.title ?? ''),
    brief: String(hit.brief ?? hit.detail ?? ''),
    spoilerLevel: Number(hit.spoilerLevel ?? 0) || 0,
    tags: Array.isArray(hit.tags) ? hit.tags.map(String) : [],
  };
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }];
}

/**
 * 用 defineTool 构造两条工具定义。
 * @param {Function} defineTool
 * @param {() => object} getDeps  每次 execute 时取最新依赖
 */
export function buildCompanionToolDefinitions(defineTool, getDeps) {
  if (typeof defineTool !== 'function') return [];
  const depsOf = () => (typeof getDeps === 'function' ? getDeps() || {} : {});

  return [
    defineTool({
      name: TOOL_SCREEN_LOOK,
      description: SCREEN_LOOK_DESCRIPTION,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string' },
            scene: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            suggestion: { type: 'string', required: true },
            spoilerLevel: { type: 'number', required: true },
            captureOk: { type: 'boolean', required: true },
            gameDate: { type: 'string' },
            timeSlot: { type: 'string' },
            windowTitle: { type: 'string' },
            isGame: { type: 'boolean' },
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(_args) {
        return executeScreenLook(depsOf());
      },
    }),
    defineTool({
      name: TOOL_GLOSSARY_LOOKUP,
      description: GLOSSARY_LOOKUP_DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '要查的名词或短语，例如 Persona、鸭志田',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            found: { type: 'boolean', required: true },
            query: { type: 'string', required: true },
            spoilerTier: { type: 'string' },
            id: { type: 'string' },
            term: { type: 'string' },
            brief: { type: 'string' },
            spoilerLevel: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: renderJson,
      },
      timeoutMs: 5_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        return executeGlossaryLookup(depsOf(), args?.query);
      },
    }),
  ];
}

/**
 * 在 agent 作用域上下文注册陪玩工具。
 * @param {any} agentCtx  setup 的 agentCtx，或 agent.ctx
 * @param {() => object} getDeps
 * @param {{ defineTool?: Function, trace?: (s: string) => void }} [options]
 */
export async function registerCompanionTools(agentCtx, getDeps, options = {}) {
  const trace = options.trace || (() => {});
  if (!agentCtx?.tools || typeof agentCtx.tools.register !== 'function') {
    return { ok: false, reason: 'tools-unavailable', registered: [] };
  }

  const defineTool =
    typeof options.defineTool === 'function'
      ? options.defineTool
      : await resolveDefineTool();
  if (!defineTool) {
    trace('companion tools skipped: @deepseek-ai/dsh-tools defineTool unavailable');
    return { ok: false, reason: 'defineTool-unavailable', registered: [] };
  }

  const defs = buildCompanionToolDefinitions(defineTool, getDeps);
  const registered = [];
  for (const def of defs) {
    try {
      // 同名已存在时覆盖/跳过：不同 DSH 版本行为不一，包一层
      agentCtx.tools.register(def);
      registered.push(def.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace(`register ${def.name} failed: ${message}`);
    }
  }

  return {
    ok: registered.length > 0,
    reason: registered.length > 0 ? '' : 'register-failed',
    registered,
  };
}

export default {
  TOOL_SCREEN_LOOK,
  TOOL_GLOSSARY_LOOKUP,
  resolveDefineTool,
  executeScreenLook,
  executeGlossaryLookup,
  buildCompanionToolDefinitions,
  registerCompanionTools,
};
