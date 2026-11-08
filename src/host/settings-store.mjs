/**
 * 用户设置落盘（与 cordis row config 叠加）。
 * 文件：$DSH_HOME/dsh-laodi.json（没有则 ~/.dsh/dsh-laodi.json）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  captureIntervalSec: 100,
  minSpeakGapSec: 180,
  speakProbability: 0.3,
  bubbleMaxChars: 40,
  visionBaseURL: '',
  visionModel: '',
  visionApiKey: '',
  visionMock: false,
  calibrateDate: '',
  /** 用哪个 DSH provider（llm-pi-ai.providers.<id>）跑视觉；留空 = 用 DSH 默认 provider */
  visionProviderId: '',
  /** 视觉密钥取自哪个环境变量名（留空 = 用 provider 自己的 apiKeyEnv） */
  visionApiKeyEnv: '',
});

export function settingsFile(env = process.env) {
  const home = (env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-laodi.json');
}

export function readUserSettings(env = process.env) {
  const file = settingsFile(env);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, file, settings: normalizeSettings(raw) };
  } catch (err) {
    return {
      ok: false,
      file,
      settings: { ...DEFAULT_SETTINGS },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function writeUserSettings(patch, env = process.env) {
  const file = settingsFile(env);
  const current = readUserSettings(env).settings;
  const next = normalizeSettings({ ...current, ...patch });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { file, settings: next };
}

export function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const str = (value, fallback = '') =>
    typeof value === 'string' ? value.trim() : fallback;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    captureIntervalSec: num(source.captureIntervalSec, DEFAULT_SETTINGS.captureIntervalSec, 60, 300),
    minSpeakGapSec: num(source.minSpeakGapSec, DEFAULT_SETTINGS.minSpeakGapSec, 180, 86400),
    speakProbability: num(source.speakProbability, DEFAULT_SETTINGS.speakProbability, 0, 0.3),
    bubbleMaxChars: num(source.bubbleMaxChars, DEFAULT_SETTINGS.bubbleMaxChars, 5, 40),
    visionBaseURL: str(source.visionBaseURL).replace(/\/+$/, ''),
    visionModel: str(source.visionModel),
    visionApiKey: str(source.visionApiKey),
    visionMock: Boolean(source.visionMock),
    calibrateDate: str(source.calibrateDate),
    visionProviderId: str(source.visionProviderId),
    visionApiKeyEnv: str(source.visionApiKeyEnv),
  };
}

export function publicSettings(settings) {
  return {
    ...settings,
    visionApiKey: settings.visionApiKey ? '__SET__' : '',
    hasVisionApiKey: Boolean(settings.visionApiKey),
  };
}

export default {
  DEFAULT_SETTINGS,
  settingsFile,
  readUserSettings,
  writeUserSettings,
  normalizeSettings,
  publicSettings,
};
