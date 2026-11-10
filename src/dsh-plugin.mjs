/**
 * Cordis 宿主入口：主循环 + 设置页 HTTP API。
 *
 * 路由前缀 /dsh-laodi-9101：
 *   GET  /config         当前设置 + DSH 状态（dsh / dshProviders / dshModels）+ workspace
 *   POST /config         保存设置；body.dshProviderEdit 可新增/编辑 DSH provider
 *   GET  /workspace      专用工作区状态
 *   POST /workspace/ensure  创建目录并登记到 DSH 工作区列表
 *   GET  /session        陪玩 Session 状态
 *   POST /session/ensure 确保 create/resume
 *   POST /session/reset  重置并新建 Session
 *   POST /ask            提问（优先 Session followup）
 *   POST /once           立刻跑一轮
 *   GET  /probe          只探一屏
 *   POST /vision/test    测一下视觉
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { createVisionClient } from './vision/client.mjs';
import { resolveVisionTarget } from './vision/magpie.mjs';
import { createHost } from './index.mjs';
import { loadElectronModule } from './overlay/overlay.mjs';
import { detectDshPet } from './overlay/pet-conflict.mjs';
import {
  normalizeProviderSpec,
  providerKeyStatus,
  readDshState,
  upsertDshProvider,
} from './host/dsh-settings.mjs';

/** 陪玩 Session 用的对话模型：优先 DSH 默认，再退回第一个可用 provider/model */
function resolveCompanionAgentOptions(env = process.env) {
  const state = readDshState(env);
  const provider = String(state.defaultProvider || '').trim();
  const model = String(state.defaultModel || '').trim();
  if (provider && model) return { provider, model };
  const first = state.providers?.[0];
  const firstModel = first?.models?.[0];
  if (first?.id && firstModel?.id) {
    return { provider: String(first.id), model: String(firstModel.id) };
  }
  return {};
}
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  publicSettings,
  readUserSettings,
  writeUserSettings,
} from './host/settings-store.mjs';
import {
  describeCompanionWorkspace,
  ensureCompanionWorkspaceViaHost,
} from './host/workspace.mjs';
import {
  getPersonaPreset,
  listPersonaPresets,
  personaVisionHint,
  resolvePersonaPresetId,
} from './host/persona.mjs';
import {
  createCompanionSessionManager,
  getAgents,
  optionalService,
} from './host/session.mjs';

export const name = 'dsh-laodi';
/** agents 软取，不硬 inject，避免加载顺序把插件卡死 */
export const inject = ['webServer'];

export const ROUTE_PREFIX = '/dsh-laodi-9101';

function trace(line) {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    mkdirSync(home, { recursive: true });
    appendFileSync(path.join(home, 'dsh-laodi.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? null), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function mergeLiveSettings(rowConfig = {}, userSettings = {}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...rowConfig,
    ...userSettings,
  });
}

/* ------------------------------------------------------------------ *
 * DSH 状态（对外只给元信息，不回显密钥明文）
 * ------------------------------------------------------------------ */

/** 密钥来源的中文说明（设置页直接显示，不回显明文） */
function keySourceLabel(source) {
  switch (source) {
    case 'process.env':
      return '进程环境变量';
    case '.env':
      return '~/.dsh/.env';
    case 'explicit':
      return '设置页手填';
    case 'explicit-empty':
      return '设置页手填（已清空）';
    case 'local-gateway':
      return '本机网关占位（不校验）';
    case 'missing':
      return '未找到';
    case 'none':
      return '未设置 apiKeyEnv';
    default:
      return source || '未知';
  }
}

/** provider 的对外信息（密钥只给状态，不给明文） */
function publicProvider(provider, env = process.env) {
  const status = providerKeyStatus(provider, env);
  return {
    id: provider.id,
    providerId: provider.providerId,
    name: provider.name,
    api: provider.api,
    apiKeyEnv: status.apiKeyEnv,
    baseURL: provider.baseURL,
    supportsImage: provider.supportsImage,
    hasApiKey: status.hasApiKey,
    keySource: status.keySource,
    keySourceLabel: keySourceLabel(status.keySource),
    localGateway: status.localGateway,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name,
      input: model.input,
      supportsImage: model.supportsImage,
    })),
  };
}

/**
 * 一次性读完 DSH 状态，摊平成设置页要用的两张表。
 *
 * （以前 /config 会各读一遍 settings.yaml 和 .env：publicDshState 一次、
 * flattenDshModels 又一次。现在只读一次。）
 *
 * @returns {{dsh: object, dshProviders: object[], dshModels: object[]}}
 */
function describeDsh(env = process.env) {
  const state = readDshState(env);
  const dshProviders = state.providers.map((provider) => publicProvider(provider, env));
  const dshModels = [];
  for (const provider of dshProviders) {
    for (const model of provider.models) {
      dshModels.push({
        providerId: provider.id,
        providerName: provider.name,
        id: model.id,
        name: model.name,
        input: model.input,
        supportsImage: model.supportsImage,
        baseURL: provider.baseURL,
        apiKeyEnv: provider.apiKeyEnv,
        hasApiKey: provider.hasApiKey,
        keySource: provider.keySource,
        keySourceLabel: provider.keySourceLabel,
        localGateway: provider.localGateway,
      });
    }
  }
  const dsh = {
    home: state.home,
    settingsFile: state.settingsFile,
    envFile: state.envFile,
    settingsOk: state.settingsOk,
    settingsError: state.settingsError,
    source: state.source,
    defaultProvider: state.defaultProvider,
    defaultModel: state.defaultModel,
    providers: dshProviders,
  };
  return { dsh, dshProviders, dshModels };
}

/* ------------------------------------------------------------------ *
 * 宿主
 * ------------------------------------------------------------------ */

function buildHostParts(live, logger, session = null, extras = {}) {
  const target = resolveVisionTarget({
    providerId: live.visionProviderId,
    model: live.visionModel,
    baseURL: live.visionBaseURL,
    // 空串 = 用 DSH provider 自己的密钥；不要把 '' 当成「显式清空」
    apiKey: live.visionApiKey || undefined,
    apiKeyEnv: live.visionApiKeyEnv,
  });
  const personaPresetId = resolvePersonaPresetId(live.personaPresetId);
  const hostConfig = loadConfig({
    overrides: {
      captureIntervalSec: live.captureIntervalSec,
      minSpeakGapSec: live.minSpeakGapSec,
      speakProbability: live.speakProbability,
      bubbleMaxChars: live.bubbleMaxChars,
      vision: {
        baseURL: target.baseURL,
        model: target.model,
        apiKey: live.visionMock ? '' : target.apiKey,
        mock: live.visionMock,
        prompt:
          `${personaVisionHint(getPersonaPreset(personaPresetId))}根据这张游戏截图判断场景，并输出 JSON：` +
          '{"scene":"street|dialog|battle|menu|shop|unknown",' +
          '"summary":"一句话画面描述",' +
          '"suggestion":"给玩家的一句建议，不超过 40 字",' +
          '"spoilerLevel":0|1|2|3}。没有依据时不要编造。',
      },
    },
  });
  const vision = createVisionClient(hostConfig);
  const host = createHost({
    config: hostConfig,
    vision,
    session,
    electron: extras.electron ?? null,
    petConflict: extras.petConflict ?? null,
    logger: {
      info: (...args) => (logger.info ? logger.info(...args) : console.log(...args)),
      warn: (...args) => (logger.warn ? logger.warn(...args) : console.warn(...args)),
      error: (...args) => (logger.error ? logger.error(...args) : console.error(...args)),
      log: (...args) => console.log(...args),
    },
  });
  return { host, hostConfig, vision, target, session };
}

export function apply(ctx, config = {}) {
  trace(`apply() entered (pid ${process.pid})`);
  const logger = ctx?.logger ?? console;
  const user = readUserSettings();
  let live = mergeLiveSettings(config, user.settings);

  // DSH 官方工作区注册表（可空）：有就走官方 API，侧边栏立刻能看到
  const workspaceRegistry = () => optionalService(ctx, 'workspaceRegistry');

  /** 先占位，buildHostParts 之后 parts 才有宿主能力；工具 execute 时再读。 */
  let parts = null;

  const sessionManager = createCompanionSessionManager({
    getAgents: () => getAgents(ctx),
    getSettings: () => live,
    persistSettings: (patch) => {
      const written = writeUserSettings(patch);
      live = mergeLiveSettings(config, written.settings);
      return live;
    },
    // 官方工作区注册表：有就用它（侧边栏立刻可见，且不会被 DSH 覆盖掉）
    getWorkspaceRegistry: () => optionalService(ctx, 'workspaceRegistry'),
    // 官方会话标题服务：给陪玩会话固定一个标题
    getSessionTitle: () => optionalService(ctx, 'sessionTitle'),
    // 对话模型：避免 create 时空 agentOptions → unveil/followup 报 no provider/model
    getAgentOptions: () => resolveCompanionAgentOptions(),
    getAgentDefaultModel: () => optionalService(ctx, 'agentDefaultModel'),
    getToolDeps: () => {
      const host = parts?.host;
      return {
        lookScreen: () =>
          host?.lookScreen?.() ??
          Promise.resolve({
            ok: false,
            reason: 'host-unavailable',
            captureOk: false,
            vision: { scene: 'unknown', summary: '', suggestion: '', spoilerLevel: 0 },
          }),
        getKnowledge: () => host?.getKnowledge?.() ?? { glossary: [] },
        getSpoilerTier: () =>
          host?.config?.policy?.spoilerDefault || live?.spoilerDefault || 'light',
        getGameDate: () => host?.state?.calibration?.gameDate || live?.calibrateDate || '',
        getTimeSlot: () => host?.state?.calibration?.timeSlot || '',
      };
    },
    trace: (line) => trace(line),
  });

  const electron = loadElectronModule();
  const petFor = (settings) => {
    const found = detectDshPet({
      ctx,
      electron,
      petPluginId: settings?.petPluginId,
    });
    if (found.notice) trace(found.notice);
    else if (found.installedHint) trace(found.installedHint);
    return found;
  };

  parts = buildHostParts(live, logger, sessionManager, {
    electron,
    petConflict: petFor(live),
  });

  const runtimeBody = () => ({
    enabled: live.enabled,
    visionModel: parts.hostConfig.vision.model,
    visionBaseURL: parts.hostConfig.vision.baseURL,
    visionProviderId: parts.target.providerId,
    mock: parts.vision.isMock,
    pet: parts.host.petStatus?.() || null,
  });

  const restartHost = (nextLive) => {
    try {
      parts.host.stop();
    } catch {
      // ignore
    }
    live = nextLive;
    parts = buildHostParts(live, logger, sessionManager, {
      electron,
      petConflict: petFor(live),
    });
    if (live.enabled) {
      parts.host.start();
      if (live.calibrateDate) {
        try {
          parts.host.setCalibration?.(live.calibrateDate);
        } catch {
          // ignore
        }
      }
      trace(`host restarted model=${parts.hostConfig.vision.model} mock=${parts.vision.isMock}`);
    } else {
      trace('host not started (enabled=false)');
    }
  };

  if (live.enabled) {
    parts.host.start();
    if (live.calibrateDate) {
      try {
        parts.host.setCalibration?.(live.calibrateDate);
      } catch {
        // ignore
      }
    }
    trace(`host started model=${parts.hostConfig.vision.model} mock=${parts.vision.isMock}`);
  } else {
    trace('host not started (enabled=false)');
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => () => {
        try {
          parts.host.stop();
          trace('host stopped');
        } catch (err) {
          trace(`host stop error: ${err?.message || err}`);
        }
        try {
          void sessionManager.dispose?.();
        } catch {
          // ignore
        }
      },
      'dsh-laodi: host loop',
    );

    if (ctx.webServer && typeof ctx.webServer.register === 'function') {
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: async (req, res) => {
              try {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                await handleRoute(req, res, url);
              } catch (error) {
                sendJson(res, 500, {
                  ok: false,
                  reason: 'internal',
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            },
          }),
        'dsh-laodi: settings routes',
      );
    } else {
      trace('webServer missing; settings card API not registered');
    }
  }

  async function handleRoute(req, res, url) {
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && (route === '/' || route === '/config')) {
      const { dsh, dshProviders, dshModels } = describeDsh();
      sendJson(
        res,
        200,
        {
          ok: true,
          config: publicSettings(live),
          defaults: DEFAULT_SETTINGS,
          magpie: {
            baseURL: parts.target.baseURL,
            model: parts.target.model,
            models: parts.target.models,
            source: parts.target.source,
            providerId: parts.target.providerId,
            providerName: parts.target.providerName,
            apiKeyEnv: parts.target.apiKeyEnv,
            hasApiKey: parts.target.hasApiKey,
            keySource: parts.target.keySource,
            keySourceLabel: keySourceLabel(parts.target.keySource),
            localGateway: parts.target.localGateway,
          },
          dsh,
          dshProviders,
          dshModels,
          workspace: describeCompanionWorkspace(live, process.env, workspaceRegistry()),
          personas: listPersonaPresets().map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            isDefault: item.isDefault,
            tags: item.tags,
          })),
          persona: (() => {
            const preset = getPersonaPreset(live.personaPresetId);
            return preset
              ? {
                  id: preset.id,
                  name: preset.name,
                  description: preset.description,
                  isDefault: preset.isDefault,
                }
              : null;
          })(),
          session: sessionManager.describe(),
          runtime: runtimeBody(),
        },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (method === 'GET' && route === '/session') {
      sendJson(
        res,
        200,
        { ok: true, session: sessionManager.describe() },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (method === 'POST' && route === '/session/ensure') {
      try {
        const ensured = await sessionManager.ensure();
        const unveiled = ensured.ok ? await sessionManager.unveil() : null;
        sendJson(res, 200, {
          ok: Boolean(ensured.ok),
          ...ensured,
          unveiled,
          session: sessionManager.describe(),
          config: publicSettings(live),
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reason: 'session-ensure-failed',
          message: error instanceof Error ? error.message : String(error),
          session: sessionManager.describe(),
        });
      }
      return;
    }

    if (method === 'POST' && route === '/session/reset') {
      try {
        const reset = await sessionManager.reset();
        const unveiled = reset.ok ? await sessionManager.unveil() : null;
        sendJson(res, 200, {
          ok: Boolean(reset.ok),
          ...reset,
          unveiled,
          session: sessionManager.describe(),
          config: publicSettings(live),
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reason: 'session-reset-failed',
          message: error instanceof Error ? error.message : String(error),
          session: sessionManager.describe(),
        });
      }
      return;
    }

    if (method === 'POST' && route === '/ask') {
      const body = (await readJson(req)) ?? {};
      const question = String(body.question ?? body.q ?? '').trim();
      if (!question) {
        sendJson(res, 400, { ok: false, reason: 'empty-question', message: '缺少 question' });
        return;
      }
      try {
        const result = await parts.host.ask(question, {
          forceAskOnce: Boolean(body.forceAskOnce || body.askOnce),
        });
        sendJson(res, 200, {
          ok: Boolean(result?.ok),
          result,
          session: sessionManager.describe(),
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reason: 'ask-failed',
          message: error instanceof Error ? error.message : String(error),
          session: sessionManager.describe(),
        });
      }
      return;
    }

    if (method === 'GET' && route === '/workspace') {
      sendJson(
        res,
        200,
        { ok: true, workspace: describeCompanionWorkspace(live, process.env, workspaceRegistry()) },
        { 'cache-control': 'no-store' },
      );
      return;
    }

    if (method === 'POST' && route === '/workspace/ensure') {
      const body = (await readJson(req)) ?? {};
      try {
        const personaPresetId = resolvePersonaPresetId(
          body.personaPresetId || live.personaPresetId,
        );
        const ensured = await ensureCompanionWorkspaceViaHost({
          registry: workspaceRegistry(),
          workspacePath: body.workspacePath || live.workspacePath,
          workspaceTitle: body.workspaceTitle || live.workspaceTitle,
          workspaceId: body.workspaceId || live.workspaceId,
          setAsDefault:
            typeof body.setWorkspaceDefault === 'boolean'
              ? body.setWorkspaceDefault
              : live.setWorkspaceDefault,
          personaPresetId,
          personaPluginId: body.personaPluginId || live.personaPluginId,
          petPluginId: body.petPluginId || live.petPluginId,
        });
        if (!ensured?.ok) {
          sendJson(res, 200, {
            ok: false,
            reason: ensured?.reason || 'workspace-ensure-failed',
            message: ensured?.message || '工作区登记失败',
            file: ensured?.file || '',
          });
          return;
        }
        const written = writeUserSettings({
          workspacePath: ensured.workspace.path,
          workspaceTitle: ensured.workspace.title,
          workspaceId: ensured.workspace.id,
          setWorkspaceDefault:
            typeof body.setWorkspaceDefault === 'boolean'
              ? body.setWorkspaceDefault
              : live.setWorkspaceDefault,
          personaPresetId,
          personaPluginId:
            typeof body.personaPluginId === 'string'
              ? body.personaPluginId
              : live.personaPluginId,
          petPluginId:
            typeof body.petPluginId === 'string' ? body.petPluginId : live.petPluginId,
        });
        restartHost(mergeLiveSettings(config, written.settings));
        sendJson(res, 200, {
          ok: true,
          created: ensured.created,
          hint: ensured.hint,
          file: ensured.file,
          ensured: ensured.workspace,
          persona: ensured.persona,
          seeded: ensured.seeded,
          config: publicSettings(live),
          workspace: describeCompanionWorkspace(live, process.env, workspaceRegistry()),
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reason: 'workspace-ensure-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && route === '/config') {
      const body = (await readJson(req)) ?? {};
      const accepted = {};
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(body, key)) accepted[key] = body[key];
      }
      // 设置页不回传明文 Key：空字符串表示不改；特殊哨兵清空
      if (accepted.visionApiKey === '__KEEP__' || accepted.visionApiKey === '__SET__') {
        delete accepted.visionApiKey;
      } else if (accepted.visionApiKey === '__CLEAR__') {
        accepted.visionApiKey = '';
      }

      // 新增 / 编辑 DSH provider：写回 ~/.dsh/settings.yaml 的 llm-pi-ai.providers.*
      let dshWrite = null;
      if (body.dshProviderEdit && typeof body.dshProviderEdit === 'object') {
        try {
          const state = readDshState();
          const wantedId = String(
            body.dshProviderEdit.id ?? body.dshProviderEdit.providerId ?? '',
          ).trim();
          const existing = state.providers.find((provider) => provider.id === wantedId) ?? null;
          const spec = normalizeProviderSpec(body.dshProviderEdit, existing);
          const written = upsertDshProvider(spec);
          dshWrite = { ok: true, id: spec.id, file: written.file, backup: written.backup };
          trace(`dsh provider saved: ${spec.id}`);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            reason: 'dsh-provider-invalid',
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      if (Object.prototype.hasOwnProperty.call(accepted, 'personaPresetId')) {
        accepted.personaPresetId = resolvePersonaPresetId(accepted.personaPresetId);
      }

      const written = writeUserSettings(accepted);
      restartHost(mergeLiveSettings(config, written.settings));

      // 人格变更且工作区已有路径时，同步写回 persona/SOUL.md
      let personaApply = null;
      if (
        Object.prototype.hasOwnProperty.call(accepted, 'personaPresetId') &&
        written.settings.workspacePath
      ) {
        try {
          const { applyPersonaPreset } = await import('./host/persona.mjs');
          personaApply = applyPersonaPreset(
            written.settings.workspacePath,
            written.settings.personaPresetId,
          ).preset;
        } catch (error) {
          personaApply = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const { dsh, dshProviders, dshModels } = describeDsh();
      const persona = getPersonaPreset(live.personaPresetId);
      sendJson(res, 200, {
        ok: true,
        persisted: true,
        file: written.file,
        dshWrite,
        personaApply: personaApply
          ? { id: personaApply.id, name: personaApply.name, error: personaApply.error }
          : null,
        config: publicSettings(live),
        dsh,
        dshProviders,
        dshModels,
        personas: listPersonaPresets().map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          isDefault: item.isDefault,
          tags: item.tags,
        })),
        persona: persona
          ? {
              id: persona.id,
              name: persona.name,
              description: persona.description,
              isDefault: persona.isDefault,
            }
          : null,
        workspace: describeCompanionWorkspace(live, process.env, workspaceRegistry()),
        session: sessionManager.describe(),
        runtime: runtimeBody(),
      });
      return;
    }

    if (method === 'POST' && route === '/once') {
      try {
        const result = await parts.host.runOnce?.();
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reason: 'once-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'GET' && route === '/probe') {
      try {
        const result = await parts.host.tick?.();
        sendJson(res, 200, { ok: true, result }, { 'cache-control': 'no-store' });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && route === '/vision/test') {
      const body = (await readJson(req)) ?? {};
      const sentKey = typeof body.visionApiKey === 'string' ? body.visionApiKey : '';
      const apiKey =
        sentKey && sentKey !== '__KEEP__' && sentKey !== '__SET__' && sentKey !== '__CLEAR__'
          ? sentKey
          : live.visionApiKey || undefined;
      const target = resolveVisionTarget({
        providerId: body.visionProviderId || live.visionProviderId,
        model: body.visionModel || live.visionModel,
        baseURL: body.visionBaseURL || live.visionBaseURL,
        apiKey,
        apiKeyEnv: body.visionApiKeyEnv || live.visionApiKeyEnv,
      });
      const client = createVisionClient({
        vision: { baseURL: target.baseURL, model: target.model, apiKey: target.apiKey, mock: false },
      });
      const pixel =
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACESURBVFhH7dFBCsAgDETRHsz7n6J3SclCkPKjpi1oYRZv6eSDx1mKraQABSggHWB2DNG7SCqAjkXoPZkKoAOzaK+1fwCNZtFu1Q2gsado3ylg3wAaeYNuOH2BAroBjsayaLcaBjganUV7rX8EVHQgQu9JKsDRsTt6F0kHfE0BClgcUOwCO5sXy45ZFqUAAAAASUVORK5CYII=';
      try {
        const result = await client.describe({
          imageBase64: pixel,
          mimeType: 'image/png',
          prompt:
            '这是一张测试图。用不超过 10 个字描述，并输出 JSON：{"scene":"unknown","summary":"...","suggestion":"测试通过","spoilerLevel":0}',
        });
        sendJson(res, 200, {
          ok: true,
          mode: 'image',
          result,
          baseURL: target.baseURL,
          model: target.model,
          providerId: target.providerId,
          providerName: target.providerName,
          apiKeyEnv: target.apiKeyEnv,
          keySource: target.keySource,
          keySourceLabel: keySourceLabel(target.keySource),
          hasApiKey: target.hasApiKey,
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          baseURL: target.baseURL,
          model: target.model,
          providerId: target.providerId,
          apiKeyEnv: target.apiKeyEnv,
          keySource: target.keySource,
          keySourceLabel: keySourceLabel(target.keySource),
        });
      }
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'not-found', message: `no such route: ${route}` });
  }

  trace('apply() done');
  return parts.host;
}

export default { name, inject, apply, ROUTE_PREFIX };
