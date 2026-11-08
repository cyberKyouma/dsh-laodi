/**
 * 视觉模型调用（OpenAI 兼容 chat/completions，多模态）。
 *
 * - 配置来自 config.vision（baseURL / model / apiKey 走环境变量）；
 * - 没有 apiKey 时自动降级成 mock，保证宿主循环可以离线跑；
 * - 只负责「发请求 + 解析结果」，不做任何策略判断。
 */

/** 视觉模型期望的输出结构 */
export const VISION_RESULT_KEYS = ['scene', 'summary', 'suggestion', 'spoilerLevel'];

/** mock 场景：离线跑主循环时用 */
export const MOCK_RESULT = Object.freeze({
  scene: 'street',
  summary: '（mock）皇家大道的街景',
  suggestion: '（mock）今天先去花坛看看有没有新的面具卡',
  spoilerLevel: 0,
  raw: '',
});

/**
 * 组装 chat/completions 请求体。
 */
export function buildChatCompletionBody(options = {}) {
  const {
    model = 'gpt-4o-mini',
    prompt = '',
    imageBase64 = '',
    mimeType = 'image/png',
    maxTokens = 300,
    temperature = 0.2,
    detail = 'low',
    responseFormat = 'json',
  } = options;

  if (!imageBase64) throw new Error('buildChatCompletionBody: 缺少图像');

  const content = [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail },
    },
  ];

  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: maxTokens,
    temperature,
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };
  return body;
}

/**
 * 解析模型输出：优先当 JSON，失败则当纯文本摘要。
 */
export function parseVisionResult(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return { scene: 'unknown', summary: '', suggestion: '', spoilerLevel: 0, raw };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const spoiler = Number(parsed.spoilerLevel);
      return {
        scene: String(parsed.scene ?? 'unknown'),
        summary: String(parsed.summary ?? ''),
        suggestion: String(parsed.suggestion ?? ''),
        spoilerLevel: Number.isFinite(spoiler) ? spoiler : 0,
        raw,
      };
    }
  } catch {
    // 不是 JSON，按纯文本处理
  }
  return {
    scene: 'unknown',
    summary: raw,
    suggestion: '',
    spoilerLevel: 0,
    raw,
  };
}

export class VisionClient {
  constructor(options = {}) {
    const {
      baseURL = 'https://api.openai.com/v1',
      model = 'gpt-4o-mini',
      apiKey = '',
      timeoutMs = 30000,
      prompt = '',
      fetchImpl = globalThis.fetch,
      mock = false,
    } = options;

    this.baseURL = String(baseURL).replace(/\/+$/, '');
    this.model = model;
    this.apiKey = String(apiKey ?? '');
    this.timeoutMs = timeoutMs;
    this.prompt = prompt;
    this.fetchImpl = fetchImpl;
    this.mock = Boolean(mock) || this.apiKey.length === 0;
  }

  get isMock() {
    return this.mock;
  }

  /** 请求 URL */
  get endpoint() {
    return `${this.baseURL}/chat/completions`;
  }

  /**
   * 描述一张截图。
   * @param {{imageBase64: string, mimeType?: string, prompt?: string, signal?: AbortSignal}} params
   * @returns {Promise<{scene: string, summary: string, suggestion: string, spoilerLevel: number, raw: string}>}
   */
  async describe(params = {}) {
    if (this.mock) return { ...MOCK_RESULT };

    const { imageBase64, mimeType = 'image/png', prompt, signal } = params;
    if (!imageBase64) throw new Error('VisionClient.describe: 缺少 imageBase64');

    const body = buildChatCompletionBody({
      model: this.model,
      prompt: prompt ?? this.prompt,
      imageBase64,
      mimeType,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `视觉接口 ${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
        );
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content
            .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
            .join('')
        : String(content ?? '');
      return parseVisionResult(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * 按 config 生成客户端；没配 apiKey 就走 mock。
 */
export function createVisionClient(config = {}) {
  const vision = config.vision ?? {};
  return new VisionClient({
    baseURL: vision.baseURL,
    model: vision.model,
    apiKey: vision.apiKey,
    timeoutMs: vision.timeoutMs,
    prompt: vision.prompt,
    mock: vision.mock,
  });
}

export default {
  VisionClient,
  createVisionClient,
  buildChatCompletionBody,
  parseVisionResult,
  MOCK_RESULT,
};
