/**
 * 代理 Worker 的离线测试（不需要部署，也不需要真的调模型）。
 *
 * 覆盖：来源白名单、每日额度、密钥缺失、请求格式、上游报错、正常转发。
 *
 * 运行：node --test test/worker.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/psytest-proxy.js';

const ORIGIN = 'https://tianayan.github.io';

/** 造一个带内存 KV 的 env。 */
function makeEnv(overrides = {}) {
  const store = new Map();
  const env = {
    MODEL_API_KEY: 'sk-unit-test-key',
    MODEL: 'MiniMax-M2.7',
    UPSTREAM_BASE: 'https://api.minimaxi.com/v1',
    ALLOWED_ORIGINS: ORIGIN,
    DAILY_LIMIT: '3',
    QUOTA: {
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async put(key, value) { store.set(key, value); },
    },
    ...overrides,
  };
  return { env, store };
}

/** 替换全局 fetch，模拟上游模型接口。 */
function mockUpstream(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function modelRequest(body) {
  return new Request('https://proxy.example/api/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

test('GET /api/health 返回模型信息，不泄露密钥', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://proxy.example/api/health', {
    headers: { origin: ORIGIN },
  }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.model, 'MiniMax-M2.7');
  assert.equal(body.quotaEnabled, true);
  assert.ok(!JSON.stringify(body).includes('sk-unit-test-key'), 'health 不能泄露密钥');
});

test('白名单之外的来源被拒', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://proxy.example/api/health', {
    headers: { origin: 'https://evil.example' },
  }), env);
  assert.equal(res.status, 403);
});

test('没有配置白名单时，跨源请求一律不放行', async () => {
  const { env } = makeEnv({ ALLOWED_ORIGINS: '' });
  const res = await worker.fetch(new Request('https://proxy.example/api/health', {
    headers: { origin: ORIGIN },
  }), env);
  assert.equal(res.status, 403);
});

test('OPTIONS 预检直接放行', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://proxy.example/api/model', {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
  }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('正常转发：加密钥调模型，把原始输出还回去', async () => {
  const restore = mockUpstream(async (url, init) => {
    assert.equal(url, 'https://api.minimaxi.com/v1/chat/completions');
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, 'MiniMax-M2.7');
    assert.equal(sent.messages[0].role, 'system');
    assert.ok(init.headers.authorization.startsWith('Bearer '));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"lean":"I"}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const { env } = makeEnv();
    const res = await worker.fetch(modelRequest({
      system: '你是评分助手',
      user: '作答原文',
      temperature: 0.2,
      maxTokens: 3000,
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.content, '{"lean":"I"}');
    assert.equal(body.model, 'MiniMax-M2.7');
    assert.equal(body.remaining, 2);
  } finally {
    restore();
  }
});

test('没配置密钥时返回 500，并提示怎么配', async () => {
  const { env } = makeEnv({ MODEL_API_KEY: '' });
  const res = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /MODEL_API_KEY/);
});

test('请求格式不对返回 400', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(modelRequest({ user: '缺 system' }), env);
  assert.equal(res.status, 400);
});

test('上游报错原样带回状态，但不带出密钥', async () => {
  const restore = mockUpstream(async () => new Response('{"error":"invalid key"}', { status: 401 }));
  try {
    const { env } = makeEnv();
    const res = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /上游返回 HTTP 401/);
    assert.ok(!JSON.stringify(body).includes('sk-unit-test-key'));
  } finally {
    restore();
  }
});

test('超过每日额度后返回 429', async () => {
  const restore = mockUpstream(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const { env } = makeEnv({ DAILY_LIMIT: '2' });
    const one = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
    assert.equal(one.status, 200);
    const two = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
    assert.equal(two.status, 200);
    const three = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
    assert.equal(three.status, 429);
    const body = await three.json();
    assert.match(body.error, /额度/);
  } finally {
    restore();
  }
});

test('没配 KV 时不限流，只是不计数', async () => {
  const restore = mockUpstream(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const { env } = makeEnv({ QUOTA: undefined });
    for (let i = 0; i < 5; i += 1) {
      const res = await worker.fetch(modelRequest({ system: 'a', user: 'b' }), env);
      assert.equal(res.status, 200);
    }
  } finally {
    restore();
  }
});

test('非 /api/model 的路径返回 404', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://proxy.example/api/score', {
    method: 'POST',
    headers: { origin: ORIGIN },
  }), env);
  assert.equal(res.status, 404);
});
