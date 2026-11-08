/**
 * 从本机 DSH / Magpie 配置里解析可用的视觉模型与 provider。
 *
 * 数据来源（优先级从高到低）：
 *   1. 显式环境变量 DSH_VISION_*
 *   2. ~/.dsh/settings.yaml  -> llm-pi-ai.providers.*
 *   3. ~/.dsh/profiles/<name>/cordis.patch.yml（settings.yaml 里没有时兜底）
 *   4. ~/.dsh/.env（按 provider 的 apiKeyEnv 取密钥）
 *
 * Magpie 本地网关默认：http://127.0.0.1:3425/v1
 * 识图优先选 input 里含 image 的模型。
 *
 * 密钥：provider 的 apiKeyEnv（进程环境变量 -> ~/.dsh/.env）；
 *       本机网关（loopback）不校验 key，用占位串即可；
 *       远端 provider 拿不到 key 就不编造，直接留空让视觉走 mock。
 */

import {
  DEFAULT_MAGPIE_BASE,
  DEFAULT_MAGPIE_MODEL,
  LOCAL_GATEWAY_KEY,
  dshHome,
  extractDshState,
  findProvider,
  isLoopbackURL,
  readDshState,
  readDotEnv,
  resolveKeyByEnvName,
} from '../host/dsh-settings.mjs';

export { dshHome, readDotEnv, DEFAULT_MAGPIE_BASE, DEFAULT_MAGPIE_MODEL };

/** 老名字：解析出 Magpie 段（保留给外部调用） */
export function parseMagpieFromSettingsYaml(text) {
  const state = extractDshState(text);
  const provider = state.providers.find((item) => item.id === 'magpie') ?? state.providers[0] ?? null;
  if (!provider) return null;
  return {
    baseURL: provider.baseURL || DEFAULT_MAGPIE_BASE,
    apiKeyEnv: provider.apiKeyEnv || 'MAGPIE_GATEWAY_KEY',
    models: provider.models.map((model) => ({ id: model.id, supportsImage: model.supportsImage })),
    defaultModel: state.defaultModel || '',
  };
}

/**
 * 选模型：
 *   - 显式指定就用显式的
 *   - 否则优先 DSH 默认模型（前提是它能识图）
 *   - 再否则优先 flash / MiniMax 这类可识图模型
 */
export function pickVisionModel(models = [], options = {}) {
  const explicit = String(options.model ?? '').trim();
  if (explicit) return explicit;

  const list = Array.isArray(models) ? models : [];
  const imageModels = list.filter((model) => model.supportsImage);
  const defaultModel = String(options.defaultModel ?? '').trim();
  if (defaultModel && imageModels.some((model) => model.id === defaultModel)) return defaultModel;

  const preferred = imageModels.find(
    (model) => /minimax|flash/i.test(model.id) && !/v4-pro/i.test(model.id),
  );
  if (preferred) return preferred.id;
  if (imageModels[0]) return imageModels[0].id;
  if (list[0]) return list[0].id;
  return '';
}

/**
 * 解析视觉目标（provider + baseURL + model + key）。
 *
 * 密钥来源（优先级从高到低）：
 *   1. 调用方显式给的 apiKey（设置页里手填的那把）
 *   2. provider 的 apiKeyEnv（先进程环境变量，再 ~/.dsh/.env）
 *   3. 本机网关（loopback）占位串——Magpie 这类网关不校验 key
 *   4. 都没有 -> 空 key -> 视觉走 mock
 *
 * @param {{env?: object, providerId?: string, model?: string, baseURL?: string, apiKey?: string, apiKeyEnv?: string, state?: object}} [options]
 */
export function resolveVisionTarget(options = {}) {
  const env = options.env ?? process.env;
  const state = options.state ?? readDshState(env);
  const provider = findProvider(state, options.providerId);
  // 密钥来源：显式指定的 apiKeyEnv > provider 自己的 apiKeyEnv
  const keyName = String(options.apiKeyEnv || provider?.apiKeyEnv || '').trim();
  const key = resolveKeyByEnvName(keyName, env);

  const models = provider?.models ?? [];
  const baseURL = String(
    options.baseURL || provider?.baseURL || DEFAULT_MAGPIE_BASE,
  ).replace(/\/+$/, '');

  // 只有本机网关才允许「没有 key 也能通」，远端 provider 必须真的拿到密钥
  const localGateway = isLoopbackURL(baseURL);

  const model =
    pickVisionModel(models, {
      model: options.model,
      defaultModel: state.defaultModel,
    }) ||
    (localGateway ? DEFAULT_MAGPIE_MODEL : '');

  // 显式给了 apiKey（哪怕是空串）就用它；没给才回落到 provider 的密钥
  const explicitKey =
    options.apiKey === undefined || options.apiKey === null ? null : String(options.apiKey);

  let apiKey = '';
  let keySource = key.source;
  if (explicitKey !== null) {
    apiKey = explicitKey.trim();
    keySource = explicitKey.trim() ? 'explicit' : 'explicit-empty';
  } else if (key.value) {
    apiKey = String(key.value).trim();
    keySource = key.source;
  } else if (provider && localGateway) {
    apiKey = LOCAL_GATEWAY_KEY;
    keySource = 'local-gateway';
  }

  return {
    providerId: provider?.id ?? '',
    providerName: provider?.name ?? '',
    apiKeyEnv: key.env || provider?.apiKeyEnv || '',
    keySource,
    hasApiKey: Boolean(apiKey),
    baseURL,
    model,
    apiKey,
    supportsImage: models.some((item) => item.supportsImage),
    models: models.map((item) => item.id),
    localGateway,
    source: provider ? state.source || 'dsh-settings' : 'magpie-default',
    state,
  };
}

/**
 * 解析最终视觉配置（老接口，字段保持兼容）。
 * @returns {{baseURL: string, model: string, apiKey: string, source: string, models: string[]}}
 */
export function resolveMagpieVision(options = {}) {
  const env = options.env ?? process.env;
  const target = resolveVisionTarget({
    env,
    providerId: options.providerId,
    model: options.model,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
  });

  return {
    baseURL: target.baseURL,
    model: target.model,
    apiKey: target.apiKey,
    source: target.source,
    models: target.models,
    providerId: target.providerId,
    providerName: target.providerName,
    apiKeyEnv: target.apiKeyEnv,
    keySource: target.keySource,
    hasApiKey: target.hasApiKey,
    localGateway: target.localGateway,
    supportsImage: target.supportsImage,
  };
}

export default {
  resolveMagpieVision,
  resolveVisionTarget,
  pickVisionModel,
  parseMagpieFromSettingsYaml,
  dshHome,
  readDotEnv,
  isLoopbackURL,
  DEFAULT_MAGPIE_BASE,
  DEFAULT_MAGPIE_MODEL,
};
