/**
 * 开放题版 MBTI 测试页 —— 本地服务端。
 *
 *  - 只监听 127.0.0.1，密钥只存在于本进程内存，绝不下发到浏览器。
 *  - 无状态：作答不落盘，草稿保存在浏览器 localStorage。
 *  - /api/score 按维度串行（同一维度排队，跨维度并行），避免重复计分与瞬时打满配额。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, publicView } from './lib/config.mjs';
import { createLlmClient, LlmError, redact } from './public/lib/llm.js';
import { DIMENSIONS, DIMENSION_ORDER } from './public/lib/prompts.js';
import { scoreDimension, finalizeReport } from './public/lib/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const ITEMS_FILE = path.join(PUBLIC_DIR, 'items.json');

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ANSWER_CHARS = 4000;
const DEFAULT_PORT = 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function loadItems() {
  const raw = fs.readFileSync(ITEMS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 无 Origin 头（curl / 同源 fetch）
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** 同维度串行队列。 */
function createQueues() {
  const chains = new Map();
  return function enqueue(key, task) {
    const previous = chains.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    chains.set(key, run.then(() => undefined, () => undefined));
    return run;
  };
}

function validateScoreRequest(body, items) {
  const dimension = String(body?.dimension ?? '');
  if (!DIMENSIONS.includes(dimension)) {
    const err = new Error(`未知维度：${dimension || '(空)'}`);
    err.statusCode = 400;
    throw err;
  }
  const allowed = new Set(items.items.filter((i) => i.dimension === dimension).map((i) => i.id));
  const rawAnswers = Array.isArray(body?.answers) ? body.answers : [];
  const answers = [];
  const seen = new Set();
  for (const entry of rawAnswers) {
    const itemId = String(entry?.itemId ?? '');
    const text = String(entry?.text ?? '').trim();
    if (!allowed.has(itemId)) {
      const err = new Error(`题号 ${itemId} 不属于维度 ${dimension}`);
      err.statusCode = 400;
      throw err;
    }
    if (seen.has(itemId)) {
      const err = new Error(`题号 ${itemId} 重复提交`);
      err.statusCode = 400;
      throw err;
    }
    seen.add(itemId);
    if (text.length > MAX_ANSWER_CHARS) {
      const err = new Error(`题号 ${itemId} 超过 ${MAX_ANSWER_CHARS} 字上限`);
      err.statusCode = 400;
      throw err;
    }
    // 跳过的题也会出现在 answers 里（text 为空），这样提示词能对上题号。
    answers.push({ itemId, text });
  }

  const skipped = (Array.isArray(body?.skipped) ? body.skipped : []).map(String);
  for (const itemId of skipped) {
    if (!allowed.has(itemId)) {
      const err = new Error(`题号 ${itemId} 不属于维度 ${dimension}`);
      err.statusCode = 400;
      throw err;
    }
    if (!seen.has(itemId)) {
      const err = new Error(`题号 ${itemId} 被标记为跳过，但不在本次作答的题目里`);
      err.statusCode = 400;
      throw err;
    }
  }

  if (!answers.some((a) => a.text)) {
    const err = new Error('本维度至少要写一题');
    err.statusCode = 400;
    throw err;
  }
  return { dimension, answers, skipped };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config] 覆盖配置（测试用）
 * @param {object} [opts.llm] 覆盖模型客户端（测试用）
 */
export function createServer({ config, llm, items } = {}) {
  const cfg = config ?? loadConfig();
  const client = llm ?? createLlmClient(cfg);
  const bank = items ?? loadItems();
  const enqueue = createQueues();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          ...publicView(cfg),
          dimensions: DIMENSIONS,
          itemCount: bank.items.length,
        });
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/score' || pathname === '/api/finalize')) {
        if (!originAllowed(req)) {
          sendJson(res, 403, { error: '拒绝跨源请求。' });
          return;
        }

        const body = await readBody(req);

        if (pathname === '/api/score') {
          const { dimension, answers, skipped } = validateScoreRequest(body, bank);
          console.log(
            `[mbti-open] POST /api/score ${dimension} (${answers.length} 题`
            + `${skipped.length ? `，跳过 ${skipped.length}` : ''})`,
          );

          const result = await enqueue(`score:${dimension}`, () =>
            scoreDimension({ dimension, answers, skipped, items: bank.items, client }));

          sendJson(res, 200, result);
          return;
        }

        // /api/finalize
        const dimensionResults = Array.isArray(body?.dimensionResults) ? body.dimensionResults : [];
        if (!dimensionResults.length) {
          const err = new Error('缺少 dimensionResults');
          err.statusCode = 400;
          throw err;
        }
        console.log(`[mbti-open] POST /api/finalize (${dimensionResults.length} 维)`);

        const result = await enqueue('finalize', () =>
          finalizeReport({
            dimensionResults,
            client,
            onNote: (message) => console.log(`[mbti-open] ${message}`),
          }));

        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const target = path.join(PUBLIC_DIR, rel);
        if (!target.startsWith(PUBLIC_DIR)) {
          sendJson(res, 403, { error: '非法路径' });
          return;
        }
        try {
          const data = await fsp.readFile(target);
          const ext = path.extname(target).toLowerCase();
          res.writeHead(200, {
            'content-type': MIME[ext] || 'application/octet-stream',
            'content-length': data.length,
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch {
          sendJson(res, 404, { error: '未找到' });
        }
        return;
      }

      sendJson(res, 405, { error: '不支持的方法' });
    } catch (err) {
      const status = err?.statusCode || 500;
      if (status >= 500) {
        console.error('[mbti-open] 服务端错误:', err?.message || err);
      }
      const payload = { error: redact(err?.message || '服务器内部错误', cfg.apiKey) };
      if (err instanceof LlmError && err.snippet) {
        payload.detail = redact(err.snippet, cfg.apiKey).slice(0, 500);
      }
      sendJson(res, status, payload);
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, config: cfg, bank, dimensionOrder: DIMENSION_ORDER };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { server, config, bank } = createServer();
  const port = Number(process.env.PORT) || DEFAULT_PORT;

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[mbti-open] 端口 ${port} 已被占用。可能有另一个实例在运行；` +
          '如需换端口请设置 PORT 环境变量后重启。',
      );
    } else {
      console.error('[mbti-open] 服务端启动失败:', err?.message || err);
    }
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[mbti-open] http://127.0.0.1:${port}`);
    console.log(`[mbti-open] 模型 ${config.model || '(未配置)'} · 端点 ${config.endpointHost || '(未配置)'} · 凭证 ${config.keyConfigured ? '已就绪' : '缺失'}`);
    console.log(`[mbti-open] 题库 ${bank.items.length} 题 · 维度 ${DIMENSIONS.join(' / ')}`);
    if (!config.keyConfigured) {
      console.warn('[mbti-open] 警告：未找到可用凭证，判型接口会返回错误。设置 MBTI_API_KEY 或提供 .env.local。');
    }
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
