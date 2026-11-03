/**
 * 线上版的模型代理（Cloudflare Worker）。
 *
 * 为什么要它：GitHub Pages 是公开托管的，密钥一旦写进前端就等于公开。
 * 所以改成"访客不填 Key，请求打到这里，Worker 用 secret 里的 Key 调模型"。
 * 仓库里只有代理地址，密钥存在 Worker 的 secret 里（wrangler secret put）。
 *
 * 它是**薄转发**：浏览器带着提示词过来，Worker 加密钥调模型，把模型的原始输出还回去，
 * 引文校验、类型派生、小传降级这些逻辑仍由前端跑 public/lib 下同一份代码。
 *
 * 部署见 worker/README.md。
 */

const DEFAULT_UPSTREAM = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7';
const DEFAULT_DAILY_LIMIT = 60; // 每个 IP 每天的模型调用次数（一次完整测评约 5 次）

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function json(payload, headers, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 这个来源允许吗？ALLOWED_ORIGINS 是逗号分隔的来源白名单。 */
function originAllowed(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true; // 同源 / curl 等没有 Origin 的请求
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return false; // 没配白名单就不放行跨源
  return allowed.includes('*') || allowed.includes(origin);
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
}

/**
 * 按 IP + 天记一次调用次数。没配 KV 就不限流（会在日志里提醒）。
 * KV 免费额度是每天 10 万次读、1000 次写，所以这里每次请求写一次是够用的。
 */
async function consumeQuota(env, request) {
  const kv = env.QUOTA;
  const limit = Number(env.DAILY_LIMIT || DEFAULT_DAILY_LIMIT);
  if (!kv) return { allowed: true, remaining: null, limited: false };

  const ip = clientIp(request);
  const day = new Date().toISOString().slice(0, 10);
  const key = `u:${ip}:${day}`;

  const current = Number((await kv.get(key)) || 0);
  if (current >= limit) return { allowed: false, remaining: 0, limited: true };

  await kv.put(key, String(current + 1), { expirationTtl: 172800 });
  return { allowed: true, remaining: limit - current - 1, limited: true };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allowed = originAllowed(request, env);

    if (!allowed) {
      return json({ error: '这个来源不在代理的白名单里。' }, corsHeaders('null'), 403);
    }
    const cors = corsHeaders(origin || '*');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        model: env.MODEL || DEFAULT_MODEL,
        upstream: env.UPSTREAM_BASE || DEFAULT_UPSTREAM,
        dailyLimit: Number(env.DAILY_LIMIT || DEFAULT_DAILY_LIMIT),
        quotaEnabled: Boolean(env.QUOTA),
      }, cors);
    }

    if (url.pathname !== '/api/model') {
      return json({ error: '没有这个接口。' }, cors, 404);
    }
    if (request.method !== 'POST') {
      return json({ error: '只支持 POST。' }, cors, 405);
    }

    const quota = await consumeQuota(env, request);
    if (!quota.allowed) {
      return json({
        error: '今天的免费额度用完了，明天再来。'
          + '（每个 IP 每天 ' + Number(env.DAILY_LIMIT || DEFAULT_DAILY_LIMIT) + ' 次模型调用，一次完整测评约 5 次）',
        remaining: 0,
      }, cors, 429);
    }

    if (!env.MODEL_API_KEY) {
      return json({ error: '代理还没有配置密钥：wrangler secret put MODEL_API_KEY' }, cors, 500);
    }

    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload.system !== 'string' || typeof payload.user !== 'string') {
      return json({ error: '请求格式不对：需要 system 与 user。' }, cors, 400);
    }

    const model = env.MODEL || DEFAULT_MODEL;
    const upstream = await fetch(`${env.UPSTREAM_BASE || DEFAULT_UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.MODEL_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: Number(payload.maxTokens) || 3000,
        temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.2,
        messages: [
          { role: 'system', content: payload.system },
          { role: 'user', content: payload.user },
        ],
      }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // 上游的报错原样带回，但不把密钥带出去
      return json({
        error: `上游返回 HTTP ${upstream.status}`,
        detail: text.slice(0, 500),
      }, cors, 502);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ error: '上游返回的不是 JSON。' }, cors, 502);
    }

    const content = data?.choices?.[0]?.message?.content ?? '';
    return json({
      content: String(content),
      model,
      remaining: quota.remaining,
    }, cors);
  },
};
