/**
 * 账号 API 调用层。
 *
 * - 协议适配：openai → /chat/completions（Bearer）；anthropic → /messages（x-api-key）。
 * - 超时 90s；429 / 5xx / 网络错误退避重试 1 次。
 * - 模型输出优先直接 JSON.parse，其次 ```json 围栏，最后扫描首个配平的 {...}。
 * - 任何错误信息在返回前都会做密钥脱敏。
 */

export class LlmError extends Error {
  constructor(message, { status = 0, retryable = false, snippet = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.snippet = snippet;
  }
}

/** 抹掉密钥与疑似密钥片段。 */
export function redact(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('***');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  return out;
}

/** 从模型输出里挖出 JSON 对象。失败抛 Error。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('empty output');

  try {
    return JSON.parse(raw);
  } catch {
    /* 继续尝试其他形态 */
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* 继续 */
    }
  }

  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('no json object found');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} cfg loadConfig() 的返回值
 * @param {object} [opts]
 */
export function createLlmClient(cfg, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  sleep = defaultSleep,
} = {}) {
  if (!cfg.keyConfigured) {
    throw new Error(
      '未找到可用凭证：请设置 MBTI_API_KEY，或在项目根目录提供 .env.local，或确保本机存在可用的 MiniMax 配置文件。',
    );
  }
  if (!cfg.baseURL) {
    throw new Error('未找到 API 端点（baseURL）。');
  }
  if (!cfg.model) {
    throw new Error('未找到模型名（defaultModel）。');
  }

  async function rawCall({ system, user, temperature, maxTokens, useJsonFormat }) {
    const protocol = cfg.protocol || 'openai';
    let url;
    let headers;
    let body;

    if (protocol === 'anthropic') {
      url = `${cfg.baseURL}/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      };
      body = {
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      };
      if (typeof temperature === 'number') body.temperature = temperature;
    } else {
      url = `${cfg.baseURL}/chat/completions`;
      headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      };
      body = {
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (typeof temperature === 'number') body.temperature = temperature;
      if (useJsonFormat) body.response_format = { type: 'json_object' };
    }

    // 思考模式开关（DeepSeek 等模型）：默认开启推理，会占用 max_tokens，
    // 且使 temperature 失效。对"按固定 schema 抽取引文"这类任务，关掉更稳。
    if (cfg.thinking === 'off') body.thinking = { type: 'disabled' };
    else if (cfg.thinking === 'on') body.thinking = { type: 'enabled' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmError(`网络请求失败：${redact(err?.message, cfg.apiKey)}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      throw new LlmError(`上游返回 HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        snippet: redact(raw, cfg.apiKey).slice(0, 600),
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError('上游返回的不是 JSON。', {
        snippet: redact(raw, cfg.apiKey).slice(0, 400),
      });
    }

    const content = protocol === 'anthropic'
      ? (Array.isArray(data.content)
        ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
        : '')
      : readOpenAiContent(data);

    return { content: String(content ?? ''), data };
  }

  function readOpenAiContent(data) {
    const message = data?.choices?.[0]?.message?.content;
    if (Array.isArray(message)) {
      return message.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
    }
    return message ?? data?.choices?.[0]?.text ?? '';
  }

  /**
   * 调用模型并返回解析后的 JSON。
   * @param {{system:string,user:string,temperature?:number,maxTokens?:number}} params
   */
  async function call({ system, user, temperature, maxTokens }) {
    let useJsonFormat = cfg.protocol !== 'anthropic';
    let lastError;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { content } = await rawCall({ system, user, temperature, maxTokens, useJsonFormat });

        if (!content.trim()) {
          throw new LlmError('上游返回了空内容。', { retryable: true });
        }

        try {
          return extractJson(content);
        } catch {
          throw new LlmError('模型输出不是可解析的 JSON。', {
            retryable: true,
            snippet: redact(content, cfg.apiKey).slice(0, 600),
          });
        }
      } catch (err) {
        lastError = err;

        // 上游不接受 response_format 时，去掉该参数再来一次（不计入退避重试）。
        if (err instanceof LlmError && err.status === 400 && useJsonFormat) {
          useJsonFormat = false;
          attempt -= 1;
          continue;
        }

        if (err instanceof LlmError && err.retryable && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  return { call, rawCall };
}
