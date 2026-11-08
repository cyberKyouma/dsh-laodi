/**
 * 「少说规则」策略引擎（纯函数，方便单测）。
 *
 * 规则来自 docs/SPEC.md：
 *   - 自动开口 >= 3min              -> minSpeakGapSec
 *   - 开口概率 <= 30%               -> speakProbability
 *   - 对话/过场/主菜单/商店结算不主动说 -> detectScene
 *   - 同建议冷却 30min              -> policy.cooldownSec
 *   - 气泡 <= 40 字                 -> bubbleMaxChars
 *
 * 这里不做 IO、不读时钟、不发请求；所有外部输入都作为参数传入。
 */

/** 场景分类 */
export const SCENE = Object.freeze({
  /** 命中静音关键字：绝不主动开口 */
  MUTED: 'muted',
  /** 明确安全场景 */
  ALLOWED: 'allowed',
  /** 认不准：允许但走正常概率 */
  UNKNOWN: 'unknown',
});

/** 默认静音关键字 */
export const DEFAULT_MUTED_SCENE_KEYWORDS = Object.freeze([
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
]);

/** 明确安全场景关键字 */
export const DEFAULT_ALLOWED_SCENE_KEYWORDS = Object.freeze([
  '街道',
  '大街',
  '花坛',
  '教室',
  '放学',
  '地铁',
  '咖啡厅',
  'street',
  'station',
  'school',
  'cafe',
]);

/** 剧透档 -> 允许的最大 spoilerLevel */
export const SPOILER_TIER_MAX = Object.freeze({
  light: 1,
  medium: 2,
  full: 3,
});

export function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 判断当前场景是否应该静音。
 * @returns {string} SCENE.MUTED | SCENE.ALLOWED | SCENE.UNKNOWN
 */
export function detectScene(description, options = {}) {
  const {
    mutedKeywords = DEFAULT_MUTED_SCENE_KEYWORDS,
    allowedKeywords = DEFAULT_ALLOWED_SCENE_KEYWORDS,
  } = options;

  const text = normalizeText(description);
  if (!text) return SCENE.UNKNOWN;

  for (const keyword of mutedKeywords) {
    const needle = normalizeText(keyword);
    if (needle && text.includes(needle)) return SCENE.MUTED;
  }
  for (const keyword of allowedKeywords) {
    const needle = normalizeText(keyword);
    if (needle && text.includes(needle)) return SCENE.ALLOWED;
  }
  return SCENE.UNKNOWN;
}

/** 场景是否静音 */
export function isMutedScene(description, options = {}) {
  return detectScene(description, options) === SCENE.MUTED;
}

/**
 * 生成气泡文案：去空白、截断到 maxChars 字（含省略号）。
 */
export function buildBubble(text, maxChars = 40) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const limit = Math.max(1, Math.floor(maxChars));
  const chars = Array.from(clean);
  if (chars.length <= limit) return clean;
  if (limit === 1) return chars[0];
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * 建议冷却键：同一条建议（忽略大小写/空白）在冷却期内不重复。
 */
export function suggestionKey(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * 该建议是否还在冷却中。
 * @param {string} key
 * @param {Array<{key: string, atSec: number}>} recent
 */
export function isSuggestionCoolingDown(key, recent = [], cooldownSec = 1800, nowSec = 0) {
  const normalized = suggestionKey(key);
  if (!normalized) return false;
  return recent.some((entry) => {
    if (!entry) return false;
    if (suggestionKey(entry.key) !== normalized) return false;
    const age = nowSec - Number(entry.atSec ?? 0);
    return age < cooldownSec;
  });
}

/**
 * 核心决策：这一轮要不要主动开口？
 *
 * @param {object} input
 * @param {number} input.nowSec             当前时间（秒）
 * @param {number|null} [input.lastSpeakAtSec] 上次开口时间
 * @param {string} [input.scene]             场景（SCENE.*）
 * @param {string} [input.suggestion]        候选建议文案
 * @param {Array<{key: string, atSec: number}>} [input.recentSuggestions]
 * @param {number} [input.probability]
 * @param {number} [input.minGapSec]
 * @param {number} [input.cooldownSec]
 * @param {() => number} [input.rng]
 * @returns {{speak: boolean, reason: string, roll?: number, waitSec?: number}}
 */
export function evaluateSpeak(input = {}) {
  const {
    nowSec = 0,
    lastSpeakAtSec = null,
    scene = SCENE.UNKNOWN,
    suggestion = '',
    recentSuggestions = [],
    probability = 0.3,
    minGapSec = 180,
    cooldownSec = 1800,
    rng = Math.random,
  } = input;

  if (scene === SCENE.MUTED) {
    return { speak: false, reason: 'scene-muted' };
  }

  const text = String(suggestion ?? '').trim();
  if (!text) {
    return { speak: false, reason: 'no-candidate' };
  }

  if (lastSpeakAtSec !== null && lastSpeakAtSec !== undefined) {
    const elapsed = nowSec - Number(lastSpeakAtSec);
    if (elapsed < minGapSec) {
      return {
        speak: false,
        reason: 'gap-not-elapsed',
        waitSec: Math.ceil(minGapSec - elapsed),
      };
    }
  }

  const key = suggestionKey(text);
  if (isSuggestionCoolingDown(key, recentSuggestions, cooldownSec, nowSec)) {
    return { speak: false, reason: 'cooldown' };
  }

  const roll = rng();
  if (roll >= probability) {
    return { speak: false, reason: 'probability-roll', roll };
  }

  return { speak: true, reason: 'ok', roll };
}

/**
 * 从候选里随机挑一条（先过滤剧透档）。
 */
export function pickSuggestion(candidates = [], options = {}) {
  const { rng = Math.random, spoilerTier = 'light' } = options;
  const allowed = filterBySpoiler(candidates, spoilerTier);
  if (allowed.length === 0) return null;
  const index = Math.min(
    allowed.length - 1,
    Math.max(0, Math.floor(rng() * allowed.length)),
  );
  return allowed[index];
}

/** 按剧透档过滤条目 */
export function filterBySpoiler(items = [], spoilerTier = 'light') {
  const max = SPOILER_TIER_MAX[spoilerTier] ?? SPOILER_TIER_MAX.light;
  return items.filter((item) => Number(item?.spoilerLevel ?? 0) <= max);
}

/**
 * 归一化游戏内日期为 MM/DD。
 */
export function normalizeGameDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // 取最后两段数字：兼容 4/1、04/01、2026/04/01、2026年4月1日
  const parts = text.match(/\d+/g);
  if (!parts || parts.length < 2) return text;
  const month = String(Number(parts[parts.length - 2])).padStart(2, '0');
  const day = String(Number(parts[parts.length - 1])).padStart(2, '0');
  return `${month}/${day}`;
}

/**
 * 挑出当天相关条目（含跨天区间）。
 */
export function selectByDate(items = [], gameDate) {
  const date = normalizeGameDate(gameDate);
  if (!date) return [];
  return items.filter((item) => {
    const start = normalizeGameDate(item?.date);
    if (!start) return false;
    if (start === date) return true;
    const end = normalizeGameDate(item?.endDate);
    if (!end) return false;
    return date >= start && date <= end;
  });
}

/**
 * 记录一条已说过的建议（返回新的 recentSuggestions 副本）。
 */
export function rememberSuggestion(recentSuggestions = [], text, atSec = 0) {
  return [
    ...recentSuggestions,
    { key: suggestionKey(text), atSec: Number(atSec ?? 0) },
  ];
}

export default {
  SCENE,
  DEFAULT_MUTED_SCENE_KEYWORDS,
  DEFAULT_ALLOWED_SCENE_KEYWORDS,
  SPOILER_TIER_MAX,
  detectScene,
  isMutedScene,
  buildBubble,
  suggestionKey,
  isSuggestionCoolingDown,
  evaluateSpeak,
  pickSuggestion,
  filterBySpoiler,
  normalizeGameDate,
  selectByDate,
  rememberSuggestion,
};
