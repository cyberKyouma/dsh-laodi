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

  const seeded = seedWorkspaceFiles(wsPath, {
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

/** 只读状态：设置是否指向一个已存在的登记 */
export function describeCompanionWorkspace(settings = {}, env = process.env) {
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
    registered: Boolean(current),
    directoryExists: dirExists,
    markerExists: fs.existsSync(markerPath),
    workspace: current,
    all: listed.items,
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
  attachSessionToWorkspace,
  describeCompanionWorkspace,
};
