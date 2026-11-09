/**
 * 陪玩专用 DSH 工作区：在侧边栏「工作区」里占一格，相关对话归到这里。
 *
 * DSH 桌面版把工作区登记在 `$DSH_HOME/storages/workspace.json`
 * （global.workspaceIds + tables.workspaces.<id>）。本模块读写这份登记，
 * 并在磁盘上建好目录；不伪造 session.v4（会话由 DSH UI / agent 创建）。
 *
 * 后续人设 / 桌宠插件可读写工作区里的 persona/ 与标记文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERSONA_ID,
  applyPersonaPreset,
  resolvePersonaPresetId,
} from './persona.mjs';

export const WORKSPACE_STORE_FILE = 'workspace.json';
export const WORKSPACE_MARKER = '.dsh-laodi-workspace.json';
export const DEFAULT_WORKSPACE_TITLE = '陪玩';

/** DSH home：DSH_HOME 或 ~/.dsh */
export function resolveDshHome(env = process.env) {
  const explicit = (env.DSH_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.dsh');
}

/** 默认工作区路径：Documents/deepseek-harness/dsh-laodi */
export function defaultWorkspacePath(env = process.env) {
  const home = os.homedir();
  const documents =
    process.platform === 'win32'
      ? path.join(home, 'Documents')
      : path.join(home, 'Documents');
  return path.join(documents, 'deepseek-harness', 'dsh-laodi');
}

export function workspaceStorePath(env = process.env) {
  return path.join(resolveDshHome(env), 'storages', WORKSPACE_STORE_FILE);
}

function emptyStore() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: '',
    },
    tables: { workspaces: {} },
  };
}

function normalizePathKey(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

export function readWorkspaceStore(env = process.env) {
  const file = workspaceStorePath(env);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return { ok: false, file, store: emptyStore(), error: 'invalid-json' };
    }
    const store = {
      ...emptyStore(),
      ...raw,
      global: { ...emptyStore().global, ...(raw.global || {}) },
      tables: {
        workspaces: {
          ...(raw.tables && typeof raw.tables.workspaces === 'object'
            ? raw.tables.workspaces
            : {}),
        },
      },
    };
    if (!Array.isArray(store.global.workspaceIds)) store.global.workspaceIds = [];
    return { ok: true, file, store };
  } catch (err) {
    return {
      ok: false,
      file,
      store: emptyStore(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeWorkspaceStoreAtomic(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 列出已登记工作区（给设置页选已有目录用） */
export function listWorkspaces(env = process.env) {
  const { file, store } = readWorkspaceStore(env);
  const items = [];
  for (const id of store.global.workspaceIds) {
    const row = store.tables.workspaces[id];
    if (!row || typeof row !== 'object') continue;
    items.push({
      id,
      path: String(row.path || ''),
      title: String(row.title || ''),
      sessionCount: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0,
      isDefault: store.global.defaultWorkspaceId === id,
      createdAt: row.createdAt || '',
      updatedAt: row.updatedAt || '',
    });
  }
  return { file, defaultWorkspaceId: store.global.defaultWorkspaceId || '', items };
}

function findWorkspaceByPath(store, wsPath) {
  const key = normalizePathKey(wsPath);
  for (const id of Object.keys(store.tables.workspaces)) {
    const row = store.tables.workspaces[id];
    if (!row?.path) continue;
    if (normalizePathKey(row.path) === key) return { id, row };
  }
  return null;
}

function findWorkspaceById(store, id) {
  const row = store.tables.workspaces[id];
  if (!row) return null;
  return { id, row };
}

/** 在工作区目录写入标记 + 应用人格预设（默认「老弟」） */
export function seedWorkspaceFiles(wsPath, meta = {}) {
  fs.mkdirSync(wsPath, { recursive: true });
  const personaPresetId = resolvePersonaPresetId(meta.personaPresetId || DEFAULT_PERSONA_ID);

  const marker = {
    plugin: 'dsh-laodi',
    kind: 'companion-workspace',
    version: 1,
    title: meta.title || DEFAULT_WORKSPACE_TITLE,
    workspaceId: meta.workspaceId || '',
    createdAt: meta.createdAt || new Date().toISOString(),
    personaPresetId,
    bridges: {
      /** 预留：人设插件包名，如 dsh-companion / dsh-assist */
      personaPluginId: meta.personaPluginId || '',
      /** 预留：桌宠插件包名 */
      petPluginId: meta.petPluginId || '',
    },
  };
  const markerFile = path.join(wsPath, WORKSPACE_MARKER);
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const readme = path.join(wsPath, 'README.md');
  fs.writeFileSync(
    readme,
    [
      '# 陪玩工作区',
      '',
      '这是 `dsh-laodi` 在 DeepSeek Harness 侧边栏登记的专用工作区。',
      '',
      '- 请在本工作区里开陪玩相关对话（Session 会归到这里）。',
      '- `persona/` 为人设与长期记忆；默认人格预设是「老弟」，可在设置里切换。',
      '- 桌宠 / 外人设插件可约定读 `.dsh-laodi-workspace.json` 与 `persona/active.json`。',
      '',
    ].join('\n'),
    'utf8',
  );

  const applied = applyPersonaPreset(wsPath, personaPresetId);
  return { markerFile, readme, personaDir: applied.personaDir, persona: applied.preset };
}

/**
 * 确保专用工作区存在并已写入 DSH 登记表。
 *
 * @param {object} options
 * @param {string} [options.workspacePath]
 * @param {string} [options.workspaceTitle]
 * @param {string} [options.workspaceId] 已有 id 时优先复用
 * @param {boolean} [options.setAsDefault] 是否设为侧边栏默认工作区
 * @param {string} [options.personaPresetId]
 * @param {string} [options.personaPluginId]
 * @param {string} [options.petPluginId]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function ensureCompanionWorkspace(options = {}) {
  const env = options.env ?? process.env;
  const title = String(options.workspaceTitle || DEFAULT_WORKSPACE_TITLE).trim() || DEFAULT_WORKSPACE_TITLE;
  const wsPath = path.resolve(
    String(options.workspacePath || defaultWorkspacePath(env)).trim() || defaultWorkspacePath(env),
  );
  const setAsDefault = Boolean(options.setAsDefault);
  const personaPresetId = resolvePersonaPresetId(options.personaPresetId || DEFAULT_PERSONA_ID);
  const now = new Date().toISOString();

  fs.mkdirSync(wsPath, { recursive: true });

  const { file, store } = readWorkspaceStore(env);
  let hit =
    (options.workspaceId && findWorkspaceById(store, String(options.workspaceId).trim())) ||
    findWorkspaceByPath(store, wsPath);

  let created = false;
  let id;
  if (hit) {
    id = hit.id;
    const prev = hit.row;
    store.tables.workspaces[id] = {
      ...prev,
      path: wsPath,
      title,
      sessionIds: Array.isArray(prev.sessionIds) ? prev.sessionIds : [],
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
  } else {
    id = randomUUID();
    created = true;
    store.tables.workspaces[id] = {
      path: wsPath,
      title,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!store.global.workspaceIds.includes(id)) {
      store.global.workspaceIds.push(id);
    }
  }

  if (setAsDefault || !store.global.defaultWorkspaceId) {
    store.global.defaultWorkspaceId = id;
  }
  store.global.initialized = true;

  writeWorkspaceStoreAtomic(file, store);

  // skipSeed：只想登记 id / 目录时不要覆盖工作区里的 persona 文件
  const seeded = options.skipSeed
    ? { skipped: true, persona: null }
    : seedWorkspaceFiles(wsPath, {
        title,
        workspaceId: id,
        createdAt: now,
        personaPresetId,
        personaPluginId: options.personaPluginId || '',
        petPluginId: options.petPluginId || '',
      });

  const row = store.tables.workspaces[id];
  return {
    ok: true,
    created,
    file,
    workspace: {
      id,
      path: wsPath,
      title,
      sessionCount: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0,
      isDefault: store.global.defaultWorkspaceId === id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    persona: seeded.persona || null,
    seeded,
    hint: created
      ? '已登记到 DSH 工作区列表。若侧边栏还没出现，切换一下工作区视图或重启 DeepSeek Harness。'
      : '已更新现有工作区登记。相关对话请在该工作区下新建/继续。',
  };
}

/**
 * 把 Session id 挂到「陪玩」工作区的 sessionIds，侧边栏才能看见。
 * @param {{ workspaceId: string, sessionId: string, env?: NodeJS.ProcessEnv }} options
 */
export function attachSessionToWorkspace(options = {}) {
  const env = options.env ?? process.env;
  const workspaceId = String(options.workspaceId || '').trim();
  const sessionId = String(options.sessionId || '').trim();
  if (!workspaceId || !sessionId) {
    return { ok: false, reason: 'workspace-or-session-missing' };
  }
  const { file, store } = readWorkspaceStore(env);
  const row = store.tables.workspaces[workspaceId];
  if (!row || typeof row !== 'object') {
    return { ok: false, reason: 'workspace-missing', file };
  }
  const ids = Array.isArray(row.sessionIds) ? [...row.sessionIds] : [];
  let added = false;
  if (!ids.includes(sessionId)) {
    ids.push(sessionId);
    added = true;
  }
  const now = new Date().toISOString();
  store.tables.workspaces[workspaceId] = {
    ...row,
    sessionIds: ids,
    updatedAt: now,
  };
  writeWorkspaceStoreAtomic(file, store);
  return {
    ok: true,
    added,
    file,
    workspaceId,
    sessionId,
    sessionCount: ids.length,
  };
}

/**
 * 解析「陪玩」工作区当前该用哪个 id / 目录。
 *
 * 优先级：settings.workspaceId → settings.workspacePath → 默认目录。
 * 先看 DSH 的 workspaceRegistry（在 DSH 宿主里才有），再看 workspace.json；
 * 都没有就返回默认目录（registered=false），由调用方去登记。
 *
 * @param {object} settings
 * @param {NodeJS.ProcessEnv} [env]
 * @param {any} [registry] ctx.workspaceRegistry（可空）
 */
export function resolveCompanionWorkspaceState(settings = {}, env = process.env, registry = null) {
  const wantedId = String(settings.workspaceId || '').trim();
  const wantedPath = String(settings.workspacePath || '').trim();
  const title = String(settings.workspaceTitle || DEFAULT_WORKSPACE_TITLE).trim() || DEFAULT_WORKSPACE_TITLE;

  const fromEntity = (entity, source) => ({
    id: String(entity?.id || wantedId),
    path: String(entity?.path || wantedPath),
    title: String(entity?.title || title),
    registered: true,
    source,
    sessionIds: Array.isArray(entity?.sessionIds) ? [...entity.sessionIds] : [],
  });

  // 1) DSH 注册表（宿主里最准：id 与 canonical path 都是 DSH 自己认的）
  if (registry && typeof registry.get === 'function' && wantedId) {
    const workspace = registry.get(wantedId);
    if (workspace) return fromEntity(workspace, 'registry');
  }

  // 2) workspace.json
  const { store, file } = readWorkspaceStore(env);
  if (wantedId && store.tables.workspaces[wantedId]) {
    return { ...fromEntity(store.tables.workspaces[wantedId], 'file'), file };
  }
  if (wantedPath) {
    const hit = findWorkspaceByPath(store, wantedPath);
    if (hit) return { ...fromEntity(hit.row, 'file'), id: hit.id, file };
  }

  // 3) 注册表里按路径找（registry.list 是同步缓存读）
  if (registry && typeof registry.list === 'function' && wantedPath) {
    const key = normalizePathKey(wantedPath);
    const hit = registry.list().find((item) => normalizePathKey(String(item?.path || '')) === key);
    if (hit) return fromEntity(hit, 'registry');
  }

  // 4) 还没登记：给出打算用的目录
  return {
    id: '',
    path: path.resolve(wantedPath || defaultWorkspacePath(env)),
    title,
    registered: false,
    source: wantedPath ? 'settings' : 'default',
    sessionIds: [],
    file,
  };
}

/**
 * 登记工作区：宿主里有 ctx.workspaceRegistry 就走官方注册表，否则退回写 workspace.json。
 *
 * 官方注册表的好处：工作区 id 与 canonical path 由 DSH 自己维护，侧边栏能立刻看到，
 * 也不会被 DSH 自己的写入覆盖掉。
 *
 * @param {object} options
 * @param {any} [options.registry] ctx.workspaceRegistry（可空）
 * @returns {Promise<object>}
 */
export async function ensureCompanionWorkspaceViaHost(options = {}) {
  const env = options.env ?? process.env;
  const registry = options.registry || null;
  const title =
    String(options.workspaceTitle || DEFAULT_WORKSPACE_TITLE).trim() || DEFAULT_WORKSPACE_TITLE;
  const wsPath = path.resolve(
    String(options.workspacePath || defaultWorkspacePath(env)).trim() || defaultWorkspacePath(env),
  );
  const personaPresetId = resolvePersonaPresetId(options.personaPresetId || DEFAULT_PERSONA_ID);
  const now = new Date().toISOString();

  fs.mkdirSync(wsPath, { recursive: true });

  if (!registry || typeof registry.create !== 'function') {
    const ensured = ensureCompanionWorkspace({ ...options, env, workspacePath: wsPath, workspaceTitle: title });
    return { ...ensured, via: 'file' };
  }

  let existing = null;
  if (typeof registry.resolveByPath === 'function') {
    try {
      existing = await registry.resolveByPath(wsPath);
    } catch {
      existing = null;
    }
  }

  let workspace = null;
  try {
    workspace = await registry.create(wsPath, title);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: 'workspace-registry-failed',
      message,
      file: workspaceStorePath(env),
    };
  }

  const id = String(workspace?.id || '');
  const resolvedPath = String(workspace?.path || wsPath);
  // create() 对已存在的记录不改标题，这里显式改一次
  if (workspace && typeof workspace.setTitle === 'function' && String(workspace.title || '') !== title) {
    try {
      await workspace.setTitle(title);
    } catch {
      // ignore：标题改不了不影响登记
    }
  }

  const seeded = options.skipSeed
    ? { skipped: true, persona: null }
    : seedWorkspaceFiles(resolvedPath, {
        title,
        workspaceId: id,
        createdAt: now,
        personaPresetId,
        personaPluginId: options.personaPluginId || '',
        petPluginId: options.petPluginId || '',
      });

  const created = !existing;
  return {
    ok: true,
    created,
    via: 'registry',
    file: workspaceStorePath(env),
    workspace: {
      id,
      path: resolvedPath,
      title,
      sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
      isDefault: false,
      createdAt: workspace?.createdAt || now,
      updatedAt: workspace?.updatedAt || now,
    },
    persona: seeded.persona || null,
    seeded,
    hint: created
      ? '已登记到 DSH 工作区列表。若侧边栏还没出现，切换一下工作区视图或重启 DeepSeek Harness。'
      : '已更新现有工作区登记。相关对话请在该工作区下新建/继续。',
  };
}

/**
 * 把 Session 挂到工作区：宿主里有 ctx.workspaceRegistry 就走官方 attachSession，
 * 否则退回写 workspace.json。
 *
 * 官方 attachSession 会校验 Session header 的 cwd 与工作区目录一致——
 * 所以会话必须先带着正确的 cwd 建出来（见 src/host/session.mjs）。
 *
 * @param {{ workspaceId: string, sessionId: string, env?: NodeJS.ProcessEnv, registry?: any }} options
 */
export async function attachSessionToWorkspaceViaHost(options = {}) {
  const env = options.env ?? process.env;
  const registry = options.registry || null;
  const workspaceId = String(options.workspaceId || '').trim();
  const sessionId = String(options.sessionId || '').trim();
  if (!workspaceId || !sessionId) {
    return { ok: false, reason: 'workspace-or-session-missing' };
  }

  if (registry && typeof registry.get === 'function') {
    const workspace = registry.get(workspaceId);
    if (!workspace) {
      return { ok: false, reason: 'workspace-missing', file: workspaceStorePath(env) };
    }
    const before = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0;
    try {
      await workspace.attachSession(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: 'attach-rejected',
        message,
        file: workspaceStorePath(env),
        workspaceId,
        sessionId,
      };
    }
    const after = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0;
    return {
      ok: true,
      added: after > before,
      via: 'registry',
      file: workspaceStorePath(env),
      workspaceId,
      sessionId,
      sessionCount: after,
    };
  }

  const attached = attachSessionToWorkspace({ workspaceId, sessionId, env });
  return { ...attached, via: 'file' };
}

/** 把 Session 从工作区摘掉（换会话时用，免得侧边栏留着废会话）。 */
export async function detachSessionFromWorkspaceViaHost(options = {}) {
  const env = options.env ?? process.env;
  const registry = options.registry || null;
  const workspaceId = String(options.workspaceId || '').trim();
  const sessionId = String(options.sessionId || '').trim();
  if (!workspaceId || !sessionId) {
    return { ok: false, reason: 'workspace-or-session-missing' };
  }

  if (registry && typeof registry.get === 'function') {
    const workspace = registry.get(workspaceId);
    if (!workspace) {
      return { ok: false, reason: 'workspace-missing', file: workspaceStorePath(env) };
    }
    try {
      if (typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId);
      }
      return { ok: true, via: 'registry', workspaceId, sessionId };
    } catch (error) {
      return {
        ok: false,
        reason: 'detach-failed',
        message: error instanceof Error ? error.message : String(error),
        workspaceId,
        sessionId,
      };
    }
  }

  const { file, store } = readWorkspaceStore(env);
  const row = store.tables.workspaces[workspaceId];
  if (!row || typeof row !== 'object') {
    return { ok: false, reason: 'workspace-missing', file };
  }
  const ids = Array.isArray(row.sessionIds) ? [...row.sessionIds] : [];
  const next = ids.filter((id) => id !== sessionId);
  if (next.length === ids.length) {
    return { ok: true, removed: false, via: 'file', file, workspaceId, sessionId };
  }
  store.tables.workspaces[workspaceId] = {
    ...row,
    sessionIds: next,
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceStoreAtomic(file, store);
  return { ok: true, removed: true, via: 'file', file, workspaceId, sessionId };
}

/** 只读状态：设置是否指向一个已存在的登记 */
export function describeCompanionWorkspace(settings = {}, env = process.env, registry = null) {
  const listed = listWorkspaces(env);
  const wantedId = String(settings.workspaceId || '').trim();
  const wantedPath = String(settings.workspacePath || '').trim() || defaultWorkspacePath(env);
  const byId = wantedId ? listed.items.find((item) => item.id === wantedId) : null;
  const byPath = listed.items.find(
    (item) => normalizePathKey(item.path) === normalizePathKey(wantedPath),
  );
  const current = byId || byPath || null;
  const dirExists = fs.existsSync(wantedPath);
  const markerPath = path.join(current?.path || wantedPath, WORKSPACE_MARKER);

  // 宿主里有官方注册表时，以注册表为准（DSH 自己认的 id / canonical path / 会话账本）
  let registryView = null;
  if (registry && typeof registry.list === 'function') {
    const items = registry.list().map((item) => ({
      id: String(item?.id || ''),
      path: String(item?.path || ''),
      title: String(item?.title || ''),
      sessionCount: Array.isArray(item?.sessionIds) ? item.sessionIds.length : 0,
      isDefault: false,
      createdAt: item?.createdAt || '',
      updatedAt: item?.updatedAt || '',
    }));
    const hit =
      (wantedId ? items.find((item) => item.id === wantedId) : null) ||
      items.find((item) => normalizePathKey(item.path) === normalizePathKey(wantedPath)) ||
      null;
    registryView = { items, current: hit };
  }

  const resolved = registryView?.current || current;
  return {
    defaultPath: defaultWorkspacePath(env),
    storeFile: listed.file,
    configured: {
      workspaceId: wantedId,
      workspacePath: wantedPath,
      workspaceTitle: String(settings.workspaceTitle || DEFAULT_WORKSPACE_TITLE),
      setWorkspaceDefault: Boolean(settings.setWorkspaceDefault),
      personaPresetId: resolvePersonaPresetId(settings.personaPresetId),
      personaPluginId: String(settings.personaPluginId || ''),
      petPluginId: String(settings.petPluginId || ''),
    },
    registered: Boolean(resolved),
    directoryExists: dirExists,
    markerExists: fs.existsSync(markerPath),
    workspace: resolved,
    all: registryView?.items || listed.items,
    via: registryView ? 'registry' : 'file',
  };
}

export default {
  DEFAULT_WORKSPACE_TITLE,
  WORKSPACE_MARKER,
  resolveDshHome,
  defaultWorkspacePath,
  workspaceStorePath,
  readWorkspaceStore,
  listWorkspaces,
  seedWorkspaceFiles,
  ensureCompanionWorkspace,
  ensureCompanionWorkspaceViaHost,
  attachSessionToWorkspace,
  attachSessionToWorkspaceViaHost,
  detachSessionFromWorkspaceViaHost,
  resolveCompanionWorkspaceState,
  describeCompanionWorkspace,
};
