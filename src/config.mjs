/**
 * dsh-laodi 全局配置。
 *
 * 默认值对齐 docs/SPEC.md 的「少说规则」：
 *   - 周期识屏默认 90–120s      -> captureIntervalSec = 100
 *   - 自动开口 >= 3min           -> minSpeakGapSec = 180
 *   - 开口概率 <= 30%            -> speakProbability = 0.3
 *   - 同建议冷却 30min           -> policy.cooldownSec = 1800
 *   - 气泡 <= 40 字              -> bubbleMaxChars = 40
 *
 * 本文件只做「配置 + 校验 + 设置落盘」，不含业务逻辑。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMagpieVision } from './vision/magpie.mjs';

/** @type {Readonly<object>} 出厂默认值（不可变，调用方请复制后再改） */
export const DEFAULT_CONFIG = Object.freeze({
  /** 周期识屏间隔（秒） */
  captureIntervalSec: 100,
  /** 两次主动开口之间的最小间隔（秒） */
  minSpeakGapSec: 180,
  /** 主动开口概率（0–1） */
  speakProbability: 0.3,
  /** 气泡最大字数 */
  bubbleMaxChars: 40,

  /** 全局热键（文案占位，Batch 4 真正接线） */
  hotkey: Object.freeze({
    ask: 'Ctrl+Shift+Space',
    calibrate: 'Ctrl+Shift+D',
    toggle: 'Ctrl+Shift+O',
  }),

  /** P5R 前台窗口白名单：标题关键字 / 进程名，可配置 */
  gameWindow: Object.freeze({
    titleKeywords: Object.freeze([
      'Persona 5 Royal',
      'Persona5 Royal',
      'Persona5',
      'P5R',
      'PERSONA5 ROYAL',
      '女神异闻录',
      '女神異聞錄',
    ]),
    processNames: Object.freeze([
      'Persona5Royal.exe',
      'PERSONA5 ROYAL.exe',
      'Persona5.exe',
    ]),
  }),

  /** 视觉 API（OpenAI 兼容） */
  vision: Object.freeze({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    timeoutMs: 30000,
    /** 送给视觉模型的提示词；要求输出 JSON */
    prompt:
      '你是「老弟」，小时候家里看着用户玩电脑的弟弟，陪玩、找攻略、帮忙记事。根据这张游戏截图判断场景，并输出 JSON：' +
      '{"scene":"street|dialog|battle|menu|shop|unknown",' +
      '"summary":"一句话画面描述",' +
      '"suggestion":"给玩家的一句建议，不超过 40 字",' +
      '"spoilerLevel":0|1|2|3}。没有依据时不要编造。',
    /** 强制 mock（无 API Key 时自动启用） */
    mock: false,
  }),

  /** 策略引擎默认值 */
  policy: Object.freeze({
    /** 同一建议的冷却（秒） */
    cooldownSec: 1800,
    /** 场景静音关键字：命中即不主动开口 */
    mutedSceneKeywords: Object.freeze([
      '对话',
      '选项',
      '字幕',
      '过场',
      '剧情动画',
      '主菜单',
      '菜单',
      '商店',
      '结算',
      'battle',
      'dialog',
      'cutscene',
      'menu',
      'shop',
      'results',
    ]),
    /** 默认剧透档：light | medium | full */
    spoilerDefault: 'light',
  }),

  /** 悬浮窗 */
  overlay: Object.freeze({
    enabled: true,
    alwaysOnTop: true,
    width: 460,
    height: 260,
    opacity: 0.92,
    /** 可拖动（占位实现） */
    draggable: true,
  }),

  /** 日志 */
  logLevel: 'info',
});

/** 去掉值为 undefined / null 的键，避免覆盖默认值 */
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = compact(value);
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else {
      // 数组复制一份，避免把被冻结的默认数组直接交给调用方
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

/** 深合并（override 优先） */
export function deepMerge(base, override) {
  const out = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    // 数组和普通对象都要复制：否则调用方拿到的还是 DEFAULT_CONFIG 里
    // 被冻结的引用，一 push 就 TypeError。
    out[key] = Array.isArray(value)
      ? [...value]
      : (value && typeof value === 'object' ? deepMerge(value, {}) : value);
  }
  for (const [key, value] of Object.entries(compact(override))) {
    const current = out[key];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

export function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 环境变量 -> 配置覆盖 */
export function configFromEnv(env = process.env) {
  return compact({
    captureIntervalSec: env.DSH_CAPTURE_INTERVAL_SEC
      ? Number(env.DSH_CAPTURE_INTERVAL_SEC)
      : undefined,
    minSpeakGapSec: env.DSH_MIN_SPEAK_GAP_SEC
      ? Number(env.DSH_MIN_SPEAK_GAP_SEC)
      : undefined,
    speakProbability: env.DSH_SPEAK_PROBABILITY
      ? Number(env.DSH_SPEAK_PROBABILITY)
      : undefined,
    bubbleMaxChars: env.DSH_BUBBLE_MAX_CHARS
      ? Number(env.DSH_BUBBLE_MAX_CHARS)
      : undefined,
    hotkey: {
      ask: env.DSH_HOTKEY_ASK,
      calibrate: env.DSH_HOTKEY_CALIBRATE,
      toggle: env.DSH_HOTKEY_TOGGLE,
    },
    vision: {
      baseURL: env.DSH_VISION_BASE_URL,
      model: env.DSH_VISION_MODEL,
      apiKey: env.DSH_VISION_API_KEY,
      mock:
        env.DSH_VISION_MOCK === '1' || env.DSH_VISION_MOCK === 'true'
          ? true
          : undefined,
    },
  });
}

/**
 * 校验并规整配置：越界值回落到安全区间，同时记录告警。
 * @returns {{config: object, warnings: string[]}}
 */
export function validateConfig(input = {}) {
  const warnings = [];
  const config = deepMerge(DEFAULT_CONFIG, input);

  const clampNumber = (key, value, min, max) => {
    const original = config[key];
    if (typeof original !== 'number' || Number.isNaN(original)) {
      warnings.push(`${key} 不是有效数字，已回落到 ${value}`);
      config[key] = value;
      return;
    }
    if (original < min || original > max) {
      warnings.push(`${key}=${original} 超出 [${min}, ${max}]，已收敛`);
      config[key] = clamp(original, min, max);
    }
  };

  // 周期识屏：SPEC 允许 90–120s
  clampNumber('captureIntervalSec', DEFAULT_CONFIG.captureIntervalSec, 60, 300);
  // 自动开口间隔：SPEC 要求 >= 180s
  clampNumber('minSpeakGapSec', DEFAULT_CONFIG.minSpeakGapSec, 180, 86400);
  // 开口概率：SPEC 要求 <= 0.3
  clampNumber('speakProbability', DEFAULT_CONFIG.speakProbability, 0, 0.3);
  // 气泡字数：SPEC 要求 <= 40
  clampNumber('bubbleMaxChars', DEFAULT_CONFIG.bubbleMaxChars, 5, 40);

  const policy = deepMerge(DEFAULT_CONFIG.policy, config.policy ?? {});
  const cooldown = Number(policy.cooldownSec);
  if (!Number.isFinite(cooldown) || cooldown < 0) {
    warnings.push('policy.cooldownSec 无效，已回落到 1800');
    policy.cooldownSec = DEFAULT_CONFIG.policy.cooldownSec;
  } else if (cooldown < 1800) {
    warnings.push(`policy.cooldownSec=${cooldown} 低于 SPEC 的 30min，已提升到 1800`);
    policy.cooldownSec = 1800;
  }
  if (!['light', 'medium', 'full'].includes(policy.spoilerDefault)) {
    warnings.push('policy.spoilerDefault 非法，已回落到 light');
    policy.spoilerDefault = 'light';
  }
  config.policy = policy;

  const vision = deepMerge(DEFAULT_CONFIG.vision, config.vision ?? {});
  vision.baseURL = String(vision.baseURL || DEFAULT_CONFIG.vision.baseURL).replace(/\/+$/, '');
  vision.model = String(vision.model || DEFAULT_CONFIG.vision.model);
  vision.apiKey = String(vision.apiKey || '');
  vision.mock = Boolean(vision.mock) || vision.apiKey.length === 0;
  config.vision = vision;

  // 这三段会被调用方改（比如 config.overlay.enabled = false），
  // 必须复制成新对象，否则会写到被冻结的 DEFAULT_CONFIG 上。
  config.hotkey = deepMerge(DEFAULT_CONFIG.hotkey, config.hotkey ?? {});
  config.overlay = deepMerge(DEFAULT_CONFIG.overlay, config.overlay ?? {});
  config.gameWindow = deepMerge(DEFAULT_CONFIG.gameWindow, config.gameWindow ?? {});

  config.warnings = warnings;
  return { config, warnings };
}

/**
 * 载入最终配置。
 * @param {{env?: object, overrides?: object}} [options]
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};
  const fromEnv = configFromEnv(env);
  // 没显式配视觉时，自动接本机 DSH Magpie（可识图的那几个模型）
  let magpieOverlay = {};
  const hasExplicitVision =
    Boolean(fromEnv.vision?.baseURL) ||
    Boolean(fromEnv.vision?.apiKey) ||
    Boolean(fromEnv.vision?.model) ||
    Boolean(overrides.vision?.baseURL) ||
    Boolean(overrides.vision?.apiKey) ||
    Boolean(overrides.vision?.model) ||
    env.DSH_VISION_MOCK === '1' ||
    env.DSH_VISION_MOCK === 'true';
  if (!hasExplicitVision) {
    try {
      const magpie = resolveMagpieVision({ env });
      if (magpie?.baseURL && magpie?.apiKey) {
        magpieOverlay = {
          vision: {
            baseURL: magpie.baseURL,
            model: magpie.model,
            apiKey: magpie.apiKey,
            mock: false,
          },
        };
      }
    } catch {
      // Magpie 不可用就保持默认（最终会因无 key 走 mock）
    }
  }
  const merged = deepMerge(
    deepMerge(deepMerge(DEFAULT_CONFIG, magpieOverlay), overrides),
    fromEnv,
  );
  return validateConfig(merged).config;
}

/** 插件数据目录（设置落盘位置） */
export function resolveDataDir(env = process.env) {
  const explicit = (env.DSH_LAODI_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32') {
    const base =
      (env.LOCALAPPDATA || '').trim() ||
      path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dsh-laodi');
  }
  return path.join(os.homedir(), '.local', 'share', 'dsh-laodi');
}

/** 设置文件路径 */
export function settingsPath(env = process.env) {
  return path.join(resolveDataDir(env), 'settings.json');
}

/**
 * 读取设置（读不到不算错，返回空设置）。
 * @returns {{ok: boolean, settings: object, path: string, error?: string}}
 */
export function loadSettings(options = {}) {
  const env = options.env ?? process.env;
  const file = options.file ?? settingsPath(env);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, settings: JSON.parse(raw), path: file };
  } catch (err) {
    return {
      ok: false,
      settings: {},
      path: file,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 原子写入设置到插件数据目录。
 * @returns {string} 写入路径
 */
export function saveSettings(settings, options = {}) {
  const env = options.env ?? process.env;
  const file = options.file ?? settingsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export default {
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
  deepMerge,
  configFromEnv,
  resolveDataDir,
  settingsPath,
  loadSettings,
  saveSettings,
};
