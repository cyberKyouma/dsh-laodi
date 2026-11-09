/**
 * 人格预设：内置包在 data/personas/<id>/，默认「老弟」。
 * 选中后写入陪玩工作区的 persona/SOUL.md，供 Session / 人设插件读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PERSONAS_DIR = path.resolve(HERE, '../../data/personas');
export const DEFAULT_PERSONA_ID = 'laodi';

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listPresetDirs(root = PERSONAS_DIR) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** @returns {{id:string,name:string,description:string,isDefault:boolean,dir:string,soulPath:string,soul:string}[]} */
export function listPersonaPresets(options = {}) {
  const root = options.root || PERSONAS_DIR;
  const items = [];
  for (const id of listPresetDirs(root)) {
    const dir = path.join(root, id);
    const meta = readJson(path.join(dir, 'preset.json'), null) || {};
    const soulPath = path.join(dir, 'SOUL.md');
    let soul = '';
    try {
      soul = fs.readFileSync(soulPath, 'utf8');
    } catch {
      soul = '';
    }
    const presetId = String(meta.id || id).trim() || id;
    items.push({
      id: presetId,
      name: String(meta.name || presetId).trim() || presetId,
      description: String(meta.description || '').trim(),
      isDefault: Boolean(meta.default) || presetId === DEFAULT_PERSONA_ID,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      dir,
      soulPath,
      soul,
    });
  }
  items.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return items;
}

export function getPersonaPreset(id, options = {}) {
  const wanted = String(id || '').trim() || DEFAULT_PERSONA_ID;
  const all = listPersonaPresets(options);
  return (
    all.find((item) => item.id === wanted) ||
    all.find((item) => item.isDefault) ||
    all[0] ||
    null
  );
}

export function resolvePersonaPresetId(id, options = {}) {
  const preset = getPersonaPreset(id, options);
  return preset?.id || DEFAULT_PERSONA_ID;
}

/** 视觉 / 主动开口用的短提示（从 SOUL 抽前几行，去掉标题） */
export function personaVisionHint(preset) {
  if (!preset?.soul) {
    return '你是陪玩助手：少说话、短句、不剧透；找攻略、帮忙记事。';
  }
  const lines = String(preset.soul)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('>'));
  const picked = lines.slice(0, 4).join(' ');
  return picked || `你是「${preset.name}」。少说话、短句、不剧透。`;
}

/**
 * 把预设写进工作区 persona/（SOUL.md + active.json），不覆盖 MEMORY.md。
 */
export function applyPersonaPreset(wsPath, presetId, options = {}) {
  const preset = getPersonaPreset(presetId, options);
  if (!preset) {
    throw new Error(`未知人格预设: ${presetId || '(empty)'}`);
  }
  if (!wsPath) throw new Error('applyPersonaPreset: 缺少 workspacePath');

  const personaDir = path.join(wsPath, 'persona');
  fs.mkdirSync(personaDir, { recursive: true });

  const soulFile = path.join(personaDir, 'SOUL.md');
  fs.writeFileSync(soulFile, preset.soul.endsWith('\n') ? preset.soul : `${preset.soul}\n`, 'utf8');

  const activeFile = path.join(personaDir, 'active.json');
  const active = {
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
    appliedAt: new Date().toISOString(),
    source: 'dsh-laodi',
  };
  fs.writeFileSync(activeFile, `${JSON.stringify(active, null, 2)}\n`, 'utf8');

  const memoryFile = path.join(personaDir, 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(
      memoryFile,
      ['# MEMORY', '', '（长期记忆占位：偏好、约定、已提醒事项摘要）', ''].join('\n'),
      'utf8',
    );
  }

  return { preset, soulFile, activeFile, personaDir };
}

export function readActivePersona(wsPath) {
  if (!wsPath) return null;
  const activeFile = path.join(wsPath, 'persona', 'active.json');
  const active = readJson(activeFile, null);
  if (!active?.presetId) return null;
  const preset = getPersonaPreset(active.presetId);
  return preset
    ? { ...preset, appliedAt: active.appliedAt || '', activeFile }
    : { id: active.presetId, name: active.name || active.presetId, description: active.description || '', appliedAt: active.appliedAt || '' };
}

export default {
  PERSONAS_DIR,
  DEFAULT_PERSONA_ID,
  listPersonaPresets,
  getPersonaPreset,
  resolvePersonaPresetId,
  personaVisionHint,
  applyPersonaPreset,
  readActivePersona,
};
