/**
 * 凭证 / 端点 / 模型解析。
 *
 * 优先级（逐字段合并，先到先得）：
 *   1. 进程环境变量   MBTI_API_KEY / MBTI_BASE_URL / MBTI_MODEL / MBTI_PROTOCOL
 *   2. 项目内 .env.local（同名变量）
 *   3. 本机 MiniMax 配置文件（agents/coder 优先于根 config.yaml）
 *
 * 只解析四个字段：apiKey / baseURL / npm / defaultModel。
 * 不引入 YAML 依赖——这几个文件结构固定，行级正则足够。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

/** 候选配置文件，按优先级排列。agents/coder 是当前唯一持有可用凭证的 profile。 */
export const MINIMAX_CONFIG_CANDIDATES = [
  path.join(os.homedir(), '.minimax', 'agents', 'coder', 'config.yaml'),
  path.join(os.homedir(), '.minimax', 'config.yaml'),
];

/**
 * 读 `key: value` 或 `key=value` 形式的扁平键值对；同名键取第一次出现。
 *
 * 两种分隔符都要支持：YAML 配置用冒号，.env 文件用等号。
 * 只按冒号切会把 .env 里的 `MBTI_BASE_URL=https://api.deepseek.com/v1`
 * 误切成 key=`MBTI_BASE_URL=https`，导致覆盖机制整条失效。
 */
export function readFlatPairs(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*([:=])\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[3].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** 读 .env 风格的本地覆盖文件。 */
export function readDotEnv(file) {
  const pairs = readFlatPairs(file);
  const out = {};
  for (const [k, v] of Object.entries(pairs)) {
    if (k.startsWith('MBTI_')) out[k] = v;
  }
  return out;
}

function protocolFromNpm(npm) {
  const value = String(npm || '').toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('google')) return 'gemini';
  return 'openai';
}

/** `minimax/MiniMax-M2.7` → `MiniMax-M2.7` */
function modelIdFromRef(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  const idx = value.lastIndexOf('/');
  return idx === -1 ? value : value.slice(idx + 1);
}

function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

/**
 * @param {object} [opts]
 * @returns {{apiKey:string, baseURL:string, model:string, protocol:string,
 *            keyConfigured:boolean, endpointHost:string, source:string}}
 */
export function loadConfig({
  env = process.env,
  root = PROJECT_ROOT,
  configPaths = MINIMAX_CONFIG_CANDIDATES,
} = {}) {
  const local = readDotEnv(path.join(root, '.env.local'));

  let mini = {};
  let miniPath = '';
  for (const candidate of configPaths) {
    const pairs = readFlatPairs(candidate);
    if (pairs.apiKey || pairs.baseURL) {
      mini = pairs;
      miniPath = candidate;
      break;
    }
  }

  const apiKey = pick(
    env.MBTI_API_KEY,
    local.MBTI_API_KEY,
    mini.apiKey,
  );

  const baseURL = pick(
    env.MBTI_BASE_URL,
    local.MBTI_BASE_URL,
    mini.baseURL,
  );

  const model = modelIdFromRef(
    pick(env.MBTI_MODEL, local.MBTI_MODEL, mini.defaultModel),
  );

  const protocol = pick(
    env.MBTI_PROTOCOL,
    local.MBTI_PROTOCOL,
  ) || protocolFromNpm(mini.npm);

  // 思考模式开关：DeepSeek 等模型默认开启推理，会吃掉 max_tokens 且使 temperature 失效。
  // 取值 off | on | enable | disable，留空表示不干预（用服务端默认）。
  const thinkingRaw = String(pick(env.MBTI_THINKING, local.MBTI_THINKING) || '').toLowerCase();
  const thinking = ['off', 'disable', 'disabled'].includes(thinkingRaw)
    ? 'off'
    : ['on', 'enable', 'enabled'].includes(thinkingRaw)
      ? 'on'
      : '';

  let endpointHost = '';
  try {
    if (baseURL) endpointHost = new URL(baseURL).host;
  } catch {
    endpointHost = '';
  }

  return {
    apiKey: apiKey ? String(apiKey) : '',
    baseURL: baseURL ? String(baseURL).replace(/\/+$/, '') : '',
    model: model ? String(model) : '',
    protocol,
    thinking,
    keyConfigured: Boolean(apiKey),
    endpointHost,
    source: miniPath,
  };
}

/** 对外暴露的脱敏视图，供 /api/health 使用。 */
export function publicView(cfg) {
  return {
    model: cfg.model,
    protocol: cfg.protocol,
    endpointHost: cfg.endpointHost,
    keyConfigured: cfg.keyConfigured,
  };
}
