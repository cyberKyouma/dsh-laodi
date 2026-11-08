/**
 * 读写本机 DSH（DeepSeek Harness）的配置：~/.dsh/settings.yaml + ~/.dsh/.env。
 *
 * 关注的是 llm-pi-ai.providers.* 这一段：
 *
 *   llm-pi-ai:
 *     providers:
 *       magpie:
 *         displayName: Magpie
 *         apiKeyEnv: MAGPIE_GATEWAY_KEY
 *         api: openai-completions
 *         baseURL: http://127.0.0.1:3425/v1
 *         models:
 *           - id: deepseek/deepseek-flash
 *             name: DeepSeek-V4.1-Flash · DeepSeek
 *             input: [text, image]
 *
 * 本仓库不带运行时依赖，所以这里自带一套「够用就好」的 YAML 子集解析/输出：
 * 只处理映射、序列、行内数组/对象和标量，不追求完整 YAML 兼容。
 *
 * 写回策略：只在文本层面改「我们自己管的那几行」，
 * 宿主文件里其它 provider / 其它段落 / 注释都原样保留；改之前先备份。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DSH_SETTINGS_FILE = 'settings.yaml';
export const DSH_ENV_FILE = '.env';
export const DEFAULT_MAGPIE_BASE = 'http://127.0.0.1:3425/v1';
export const DEFAULT_API_KEY_ENV = 'MAGPIE_GATEWAY_KEY';
export const DEFAULT_API_KIND = 'openai-completions';
/** 本地网关（Magpie）兜底模型：provider 里一个模型都没写时用 */
export const DEFAULT_MAGPIE_MODEL = 'deepseek/deepseek-flash';
/** 本地网关不校验密钥时的占位串（只对 loopback 网关用） */
export const LOCAL_GATEWAY_KEY = 'magpie';

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/** DSH 主目录：DSH_HOME 或 ~/.dsh */
export function dshHome(env = process.env) {
  const explicit = (env.DSH_HOME || '').trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), '.dsh');
}

export function dshSettingsFile(env = process.env) {
  return path.join(dshHome(env), DSH_SETTINGS_FILE);
}

export function dshEnvFile(env = process.env) {
  return path.join(dshHome(env), DSH_ENV_FILE);
}

/**
 * 是不是本机网关（127.0.0.1 / localhost / ::1）。
 *
 * Magpie 这类本地网关不校验 Authorization 头，给不给 key 都通；
 * 远端 provider 则必须真的拿到密钥，否则整条链路会带着假 key 去请求。
 */
export function isLoopbackURL(baseURL) {
  const raw = String(baseURL ?? '').trim();
  if (!raw) return false;
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // 不是完整 URL：退回正则，容忍 "127.0.0.1:3425/v1" 这种写法
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^/:?#]+)/i.exec(raw);
    host = String(match?.[1] ?? '').toLowerCase();
  }
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/* ------------------------------------------------------------------ *
 * YAML 子集：解析
 * ------------------------------------------------------------------ */

function unquote(text) {
  const s = String(text ?? '');
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** 去掉行尾注释（# 前面必须是空白，且不在引号里） */
export function stripComment(text) {
  const s = String(text ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/**
 * 把 "key: value" 拆开。冒号必须是行尾或后面跟空白才算分隔符，
 * 这样 baseURL: http://127.0.0.1:3425/v1 不会被拆错。
 * @returns {{key: string, raw: string}|null}
 */
export function splitKey(text) {
  const s = String(text ?? '');
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      return { key: unquote(s.slice(0, i).trim()), raw: s.slice(i + 1).trim() };
    }
  }
  return null;
}

function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += body[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** 标量解析（YAML 1.2 core 语义：只有 true/false 是布尔） */
export function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitFlow(s.slice(1, -1)).map((part) => parseScalar(part));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const parsed = splitKey(part);
      if (!parsed) continue;
      obj[parsed.key] = parseScalar(parsed.raw);
    }
    return obj;
  }
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === '~') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

function indentOf(line) {
  return String(line ?? '').length - String(line ?? '').trimStart().length;
}

/**
 * 把文本切成 token 流：
 *   { kind: 'map', indent, key, raw }  —— key: value
 *   { kind: 'seq', indent }            —— "-"
 *   { kind: 'scalar', indent, value }  —— "- 裸值"
 */
function tokenize(text) {
  const tokens = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const indent = indentOf(rawLine);
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('#')) continue;
    const noComment = stripComment(trimmed).trim();
    if (noComment === '') continue;

    if (noComment === '-') {
      tokens.push({ kind: 'seq', indent });
      continue;
    }
    if (noComment.startsWith('- ')) {
      const content = noComment.slice(2).trim();
      const extra = /^\s*/.exec(noComment.slice(2))[0].length;
      const childIndent = indent + 2 + extra;
      tokens.push({ kind: 'seq', indent });
      const parsed = splitKey(content);
      if (parsed) {
        tokens.push({ kind: 'map', indent: childIndent, key: parsed.key, raw: parsed.raw });
      } else {
        tokens.push({ kind: 'scalar', indent: childIndent, value: parseScalar(content) });
      }
      continue;
    }

    const parsed = splitKey(noComment);
    if (parsed) {
      tokens.push({ kind: 'map', indent, key: parsed.key, raw: parsed.raw });
    } else {
      tokens.push({ kind: 'scalar', indent, value: parseScalar(noComment) });
    }
  }
  return tokens;
}

function parseNode(tokens, index, indent) {
  const token = tokens[index];
  if (!token) return [null, index];
  if (token.kind === 'seq') return parseSequence(tokens, index, indent);
  return parseMapping(tokens, index, indent);
}

function parseSequence(tokens, index, indent) {
  const items = [];
  let i = index;
  while (i < tokens.length && tokens[i].kind === 'seq' && tokens[i].indent === indent) {
    const next = tokens[i + 1];
    if (!next || next.indent <= indent) {
      items.push(null);
      i += 1;
      continue;
    }
    if (next.kind === 'scalar') {
      items.push(next.value);
      i += 2;
      continue;
    }
    const [item, consumed] = parseNode(tokens, i + 1, next.indent);
    items.push(item);
    i = consumed;
  }
  return [items, i];
}

function parseMapping(tokens, index, indent) {
  const obj = {};
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind !== 'map' || token.indent !== indent) break;
    if (token.raw === '') {
      const next = tokens[i + 1];
      if (next && next.indent > indent) {
        const [value, consumed] = parseNode(tokens, i + 1, next.indent);
        obj[token.key] = value;
        i = consumed;
      } else {
        obj[token.key] = null;
        i += 1;
      }
      continue;
    }
    obj[token.key] = parseScalar(token.raw);
    i += 1;
  }
  return [obj, i];
}

/**
 * 解析 YAML 子集。够用就好：映射 / 序列 / 行内数组 / 标量。
 * @returns {any}
 */
export function parseYamlSubset(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const [value] = parseNode(tokens, 0, tokens[0].indent);
  return value;
}

/* ------------------------------------------------------------------ *
 * YAML 子集：输出
 * ------------------------------------------------------------------ */

/** 标量是否可以直接裸写 */
export function yamlScalar(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  const safe =
    !/^\s/.test(s) &&
    !/\s$/.test(s) &&
    !/[\r\n]/.test(s) &&
    !/[:#]\s/.test(s) &&
    !/:\s/.test(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s);
  if (safe) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlKey(key) {
  const s = String(key ?? '');
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/* ------------------------------------------------------------------ *
 * 文本层面的块定位 / 改写
 * ------------------------------------------------------------------ */

function isBlankLine(line) {
  return !String(line ?? '').trim();
}

/**
 * 按路径找一段：['llm-pi-ai','providers']。
 * @returns {Array<{index: number, indent: number}>|null}
 */
export function findPath(lines, segments) {
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  const found = [];
  for (const segment of segments) {
    let childIndent = -1;
    for (let i = start; i < end; i += 1) {
      if (isBlankLine(lines[i]) || lines[i].trim().startsWith('#')) continue;
      childIndent = indentOf(lines[i]);
      break;
    }
    if (childIndent < 0) childIndent = Math.max(parentIndent + 2, 0);
    let hit = -1;
    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      if (isBlankLine(line) || line.trim().startsWith('#')) continue;
      if (indentOf(line) !== childIndent) continue;
      const parsed = splitKey(line.trim());
      if (!parsed || parsed.key !== segment) continue;
      hit = i;
      break;
    }
    if (hit < 0) return null;
    let stop = end;
    for (let i = hit + 1; i < end; i += 1) {
      if (isBlankLine(lines[i])) continue;
      if (indentOf(lines[i]) <= childIndent) {
        stop = i;
        break;
      }
    }
    found.push({ index: hit, indent: childIndent });
    start = hit + 1;
    end = stop;
    parentIndent = childIndent;
  }
  return found;
}

/** 一段内容的结束行号（下一个缩进 <= indent 的非空行） */
function blockEnd(lines, from, indent, limit = lines.length) {
  for (let i = from; i < limit; i += 1) {
    if (isBlankLine(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return limit;
}

function modelBlockLines(models, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const model of models) {
    lines.push(`${pad}- id: ${yamlScalar(model.id)}`);
    lines.push(`${pad}  name: ${yamlScalar(model.name || model.id)}`);
    if (model.contextWindow) lines.push(`${pad}  contextWindow: ${model.contextWindow}`);
    if (model.maxTokens) lines.push(`${pad}  maxTokens: ${model.maxTokens}`);
    const input = Array.isArray(model.input) && model.input.length
      ? model.input
      : (model.supportsImage ? ['text', 'image'] : ['text']);
    lines.push(`${pad}  input: [${input.map((item) => yamlScalar(item)).join(', ')}]`);
    if (model.reasoningEfforts && typeof model.reasoningEfforts === 'object') {
      lines.push(`${pad}  reasoningEfforts:`);
      for (const [key, value] of Object.entries(model.reasoningEfforts)) {
        lines.push(`${pad}    ${yamlKey(key)}: ${yamlScalar(value)}`);
      }
    }
  }
  return lines;
}

/**
 * 把一个 provider 写进 settings.yaml 文本。
 * 已存在的 provider 做「按键合并」：只改 displayName / apiKeyEnv / api / baseURL / models，
 * 其它键（例如 streamIdleTimeoutMs）和注释原样保留。
 *
 * @param {string} text 原始 settings.yaml 文本
 * @param {object} provider { id, name, apiKeyEnv, api, baseURL, models[] }
 * @returns {string} 新的文本
 */
export function upsertProviderInText(text, provider) {
  const id = String(provider?.id ?? '').trim();
  if (!id) throw new Error('provider id 不能为空');
  const source = String(text ?? '');
  const hadTrailingNewline = source.endsWith('\n');
  let lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const models = Array.isArray(provider.models) ? provider.models : [];
  const scalars = [
    ['displayName', provider.name || provider.displayName || id],
    ['apiKeyEnv', provider.apiKeyEnv || DEFAULT_API_KEY_ENV],
    ['api', provider.api || DEFAULT_API_KIND],
    ['baseURL', provider.baseURL || DEFAULT_MAGPIE_BASE],
  ];

  const found = findPath(lines, ['llm-pi-ai', 'providers']);
  let providerIndex = -1;
  let providerIndent = 4;
  let insertAt = lines.length;

  if (found) {
    const providers = found[found.length - 1];
    const providersIndent = providers.indent;
    const childIndent = providersIndent + 2;
    const providersEnd = blockEnd(lines, providers.index + 1, providersIndent);
    for (let i = providers.index + 1; i < providersEnd; i += 1) {
      if (isBlankLine(lines[i]) || lines[i].trim().startsWith('#')) continue;
      if (indentOf(lines[i]) !== childIndent) continue;
      const parsed = splitKey(lines[i].trim());
      if (!parsed || parsed.key !== id) continue;
      providerIndex = i;
      providerIndent = childIndent;
      break;
    }
    if (providerIndex < 0) insertAt = providersEnd;
  }

  if (providerIndex >= 0) {
    const end = blockEnd(lines, providerIndex + 1, providerIndent);
    const body = lines.slice(providerIndex + 1, end);
    const next = [];

    // 1) 合并标量键
    for (const [key, value] of scalars) {
      let replaced = false;
      for (let i = 0; i < body.length; i += 1) {
        const line = body[i];
        if (isBlankLine(line) || line.trim().startsWith('#')) continue;
        if (indentOf(line) !== providerIndent + 2) continue;
        const parsed = splitKey(line.trim());
        if (!parsed || parsed.key !== key) continue;
        body[i] = `${' '.repeat(providerIndent + 2)}${key}: ${yamlScalar(value)}`;
        replaced = true;
        break;
      }
      if (!replaced) {
        body.push(`${' '.repeat(providerIndent + 2)}${key}: ${yamlScalar(value)}`);
      }
    }

    // 2) 替换 models 段
    let modelsIndex = -1;
    for (let i = 0; i < body.length; i += 1) {
      const line = body[i];
      if (isBlankLine(line) || line.trim().startsWith('#')) continue;
      if (indentOf(line) !== providerIndent + 2) continue;
      const parsed = splitKey(line.trim());
      if (!parsed || parsed.key !== 'models') continue;
      modelsIndex = i;
      break;
    }
    const modelLines = modelBlockLines(models, providerIndent + 4);
    if (modelsIndex >= 0) {
      const modelsEnd = blockEnd(body, modelsIndex + 1, providerIndent + 2, body.length);
      body.splice(modelsIndex, modelsEnd - modelsIndex, ...modelLines);
    } else {
      body.push(`${' '.repeat(providerIndent + 2)}models:`);
      body.push(...modelLines);
    }

    next.push(...lines.slice(0, providerIndex + 1), ...body, ...lines.slice(end));
    lines = next;
  } else {
    // 新增 provider
    const block = [];
    block.push(`${' '.repeat(providerIndent)}${id}:`);
    for (const [key, value] of scalars) {
      block.push(`${' '.repeat(providerIndent + 2)}${key}: ${yamlScalar(value)}`);
    }
    block.push(`${' '.repeat(providerIndent + 2)}models:`);
    block.push(...modelBlockLines(models, providerIndent + 4));

    if (found) {
      const providers = found[found.length - 1];
      const providersEnd = blockEnd(lines, providers.index + 1, providers.indent);
      lines = [...lines.slice(0, providersEnd), ...block, ...lines.slice(providersEnd)];
    } else {
      const section = ['llm-pi-ai:', '  providers:'];
      const tail = lines.length ? [''] : [];
      lines = [...lines, ...tail, ...section, ...block];
    }
  }

  const output = lines.join('\n');
  return hadTrailingNewline || output.length ? `${output}\n` : output;
}

/* ------------------------------------------------------------------ *
 * 读取 DSH 状态
 * ------------------------------------------------------------------ */

export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 读 ~/.dsh/.env，返回 { KEY: value } */
export function readDotEnv(file, env = process.env) {
  const text = readTextSafe(file);
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** provider 的某个模型是否支持图片 */
export function modelSupportsImage(model) {
  if (!model || typeof model !== 'object') return false;
  const candidates = [model.input, model.modalities?.input, model.modalities, model.supportedInput];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    if (list.some((item) => String(item).toLowerCase() === 'image')) return true;
  }
  if (model.supportsImage === true) return true;
  return false;
}

function normalizeModel(model) {
  const id = String(model?.id ?? '').trim();
  if (!id) return null;
  const input = Array.isArray(model.input)
    ? model.input.map((item) => String(item))
    : (Array.isArray(model.modalities?.input) ? model.modalities.input.map((item) => String(item)) : []);
  return {
    id,
    name: String(model.name ?? id),
    input,
    supportsImage: modelSupportsImage(model),
    contextWindow: Number(model.contextWindow) || 0,
    maxTokens: Number(model.maxTokens) || 0,
    reasoningEfforts:
      model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
        ? model.reasoningEfforts
        : null,
  };
}

/** 把 providers 段转成统一结构 */
export function normalizeProviders(rawProviders) {
  if (!rawProviders || typeof rawProviders !== 'object') return [];
  return Object.entries(rawProviders)
    .map(([id, value]) => {
      if (!value || typeof value !== 'object') return null;
      const models = (Array.isArray(value.models) ? value.models : [])
        .map(normalizeModel)
        .filter(Boolean);
      return {
        id,
        providerId: id,
        name: String(value.displayName ?? value.name ?? id),
        displayName: String(value.displayName ?? value.name ?? id),
        api: String(value.api ?? DEFAULT_API_KIND),
        apiKeyEnv: String(value.apiKeyEnv ?? ''),
        baseURL: String(value.baseURL ?? '').replace(/\/+$/, ''),
        models,
        supportsImage: models.some((model) => model.supportsImage),
      };
    })
    .filter(Boolean);
}

/** 从 settings.yaml / cordis.patch.yml 文本里取出 providers + 默认模型 */
export function extractDshState(text) {
  const doc = parseYamlSubset(text);
  if (!doc) return { providers: [], defaultProvider: '', defaultModel: '' };

  let providers = [];
  let defaultProvider = '';
  let defaultModel = '';

  if (Array.isArray(doc)) {
    // cordis.patch.yml：顶层是 loader 数组
    for (const entry of doc) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.id === 'llm-pi-ai' || entry.id === 'llm-pi-ai ') {
        providers = providers.concat(normalizeProviders(entry.config?.providers));
      }
      if (entry.id === 'agent-default-model') {
        defaultProvider = String(entry.config?.provider ?? '');
        defaultModel = String(entry.config?.model ?? '');
      }
    }
  } else if (typeof doc === 'object') {
    providers = normalizeProviders(doc?.['llm-pi-ai']?.providers);
    const agent = doc['agent-default-model'];
    if (agent && typeof agent === 'object') {
      defaultProvider = String(agent.provider ?? '');
      defaultModel = String(agent.model ?? '');
    }
  }

  return { providers, defaultProvider, defaultModel };
}

function profilePatchFiles(env) {
  const home = dshHome(env);
  const profiles = ['desktop', 'headless', 'acp'];
  return profiles.map((name) => path.join(home, 'profiles', name, 'cordis.patch.yml'));
}

/**
 * 读取本机 DSH 状态。
 * @returns {{home, settingsFile, envFile, settingsOk, settingsError, providers, defaultProvider, defaultModel, source}}
 */
export function readDshState(env = process.env) {
  const home = dshHome(env);
  const settingsFile = dshSettingsFile(env);
  const envFile = dshEnvFile(env);

  let settingsText = '';
  let settingsOk = false;
  let settingsError = '';
  try {
    settingsText = fs.readFileSync(settingsFile, 'utf8');
    settingsOk = true;
  } catch (err) {
    settingsError = err instanceof Error ? err.message : String(err);
  }

  const fromSettings = extractDshState(settingsText);
  let providers = fromSettings.providers;
  let defaultProvider = fromSettings.defaultProvider;
  let defaultModel = fromSettings.defaultModel;
  let source = settingsOk && providers.length ? 'settings.yaml' : 'none';

  if (!providers.length || !defaultProvider || !defaultModel) {
    for (const file of profilePatchFiles(env)) {
      const text = readTextSafe(file);
      if (!text.trim()) continue;
      const patch = extractDshState(text);
      if (!providers.length && patch.providers.length) {
        providers = patch.providers;
        if (!source || source === 'none') source = 'cordis.patch.yml';
      }
      if (!defaultProvider && patch.defaultProvider) defaultProvider = patch.defaultProvider;
      if (!defaultModel && patch.defaultModel) defaultModel = patch.defaultModel;
    }
  }

  return {
    home,
    settingsFile,
    envFile,
    settingsOk,
    settingsError,
    providers,
    defaultProvider,
    defaultModel,
    source,
  };
}

/** 按 id 找 provider；找不到就退回默认 provider */
export function findProvider(state, id) {
  const providers = state?.providers ?? [];
  const wanted = String(id ?? '').trim();
  if (wanted) {
    const hit = providers.find((provider) => provider.id === wanted);
    if (hit) return hit;
  }
  const fallbackId = String(state?.defaultProvider ?? '').trim();
  if (fallbackId) {
    const hit = providers.find((provider) => provider.id === fallbackId);
    if (hit) return hit;
  }
  return providers[0] ?? null;
}

/**
 * 按环境变量名解析密钥：先进程环境变量，再 ~/.dsh/.env。
 * 只返回来源，不把明文写进日志/HTTP 响应。
 */
export function resolveKeyByEnvName(name, env = process.env) {
  const envName = String(name ?? '').trim();
  if (!envName) return { env: '', value: '', source: 'none', found: false };
  const fromProcess = String(env[envName] ?? '').trim();
  if (fromProcess) return { env: envName, value: fromProcess, source: 'process.env', found: true };
  const dotenv = readDotEnv(dshEnvFile(env), env);
  const fromFile = String(dotenv[envName] ?? '').trim();
  if (fromFile) return { env: envName, value: fromFile, source: '.env', found: true };
  return { env: envName, value: '', source: 'missing', found: false };
}

/**
 * 解析 provider 的密钥：按 provider 自己的 apiKeyEnv 找。
 */
export function resolveProviderKey(provider, env = process.env) {
  return resolveKeyByEnvName(provider?.apiKeyEnv, env);
}

/**
 * provider 的密钥状态——给设置页显示「密钥从哪来」用，不回显明文。
 *
 * @returns {{apiKeyEnv: string, hasApiKey: boolean, keySource: string, localGateway: boolean}}
 */
export function providerKeyStatus(provider, env = process.env) {
  const key = resolveKeyByEnvName(provider?.apiKeyEnv, env);
  return {
    apiKeyEnv: key.env || String(provider?.apiKeyEnv ?? ''),
    hasApiKey: key.found,
    keySource: key.source,
    localGateway: isLoopbackURL(provider?.baseURL),
  };
}

/* ------------------------------------------------------------------ *
 * 写回 settings.yaml
 * ------------------------------------------------------------------ */

/**
 * 校验 + 规整「新增/编辑 provider」的表单。
 * 保留旧 provider 里我们不管理的字段（contextWindow / reasoningEfforts 等）。
 *
 * @param {object} input 表单内容
 * @param {object|null} existing 已存在的 provider（同名时用来兜底）
 */
export function normalizeProviderSpec(input = {}, existing = null) {
  const id = String(input.id ?? input.providerId ?? '').trim();
  if (!id) throw new Error('provider id 不能为空');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`provider id 非法：${id}`);
  const providerId = String(input.providerId ?? id).trim();
  if (providerId !== id) throw new Error('providerId 与 id 不一致');

  const name = String(input.name ?? input.displayName ?? existing?.name ?? id).trim() || id;
  const api = String(input.api ?? existing?.api ?? DEFAULT_API_KIND).trim() || DEFAULT_API_KIND;
  const baseURL = String(input.baseURL ?? existing?.baseURL ?? DEFAULT_MAGPIE_BASE)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseURL)) throw new Error(`baseURL 必须是 http(s) 地址：${baseURL}`);

  const apiKeyEnv = String(input.apiKeyEnv ?? existing?.apiKeyEnv ?? DEFAULT_API_KEY_ENV).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`apiKeyEnv 必须是环境变量名：${apiKeyEnv}`);
  }

  const previous = new Map((existing?.models ?? []).map((model) => [model.id, model]));
  const rawModels = Array.isArray(input.models) ? input.models : [];
  const models = [];
  for (const raw of rawModels) {
    const modelId = String(raw?.id ?? '').trim();
    if (!modelId) continue;
    const prev = previous.get(modelId);
    const supportsImage =
      raw?.supportsImage === undefined ? Boolean(prev?.supportsImage) : Boolean(raw.supportsImage);
    models.push({
      id: modelId,
      name: String(raw?.name ?? prev?.name ?? modelId).trim() || modelId,
      supportsImage,
      input: supportsImage ? ['text', 'image'] : ['text'],
      contextWindow: Number(raw?.contextWindow ?? prev?.contextWindow ?? 0) || 0,
      maxTokens: Number(raw?.maxTokens ?? prev?.maxTokens ?? 0) || 0,
      reasoningEfforts: raw?.reasoningEfforts ?? prev?.reasoningEfforts ?? null,
    });
  }
  if (!models.length) throw new Error('至少要有一个模型');

  return { id, providerId, name, api, baseURL, apiKeyEnv, models };
}

/**
 * 新增 / 更新 llm-pi-ai.providers.<id>。
 * 改之前会备份成 settings.yaml.bak。
 */
export function upsertDshProvider(provider, env = process.env) {
  const file = dshSettingsFile(env);
  const current = readTextSafe(file);
  const next = upsertProviderInText(current, provider);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (current) {
    try {
      fs.writeFileSync(`${file}.bak`, current, 'utf8');
    } catch {
      // 备份失败不阻断写入
    }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  return { file, backup: current ? `${file}.bak` : '', text: next };
}

export default {
  dshHome,
  dshSettingsFile,
  dshEnvFile,
  isLoopbackURL,
  parseYamlSubset,
  yamlScalar,
  findPath,
  upsertProviderInText,
  readDshState,
  findProvider,
  resolveProviderKey,
  resolveKeyByEnvName,
  providerKeyStatus,
  normalizeProviderSpec,
  upsertDshProvider,
  readDotEnv,
  extractDshState,
  normalizeProviders,
  modelSupportsImage,
  DEFAULT_MAGPIE_BASE,
  DEFAULT_MAGPIE_MODEL,
  LOCAL_GATEWAY_KEY,
  DEFAULT_API_KEY_ENV,
};
