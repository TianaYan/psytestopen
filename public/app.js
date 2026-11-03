/* 开放题版 MBTI —— 前端状态机与渲染。
 *
 * 交互流程：填完一维 → 点提交 → 立即跳到下一维作答，本维判型在后台并行计算；
 *          四维都提交后进入汇总页，一次性展示类型、四维结果、证据、小传与引证表。
 *
 * 运行模式（同一份代码，两种部署）：
 *  - local  ：本机跑 server.mjs。判型请求走同源 /api/*，密钥留在服务端，浏览器拿不到。
 *  - direct ：GitHub Pages 等纯静态部署。没有后端，访客填自己的 MiniMax Key，
 *             由浏览器直接调 API（该端点支持 CORS）。密钥只存在访客的浏览器里，
 *             仓库与页面上都没有密钥。判型规则与服务端共用 public/lib 下的同一份实现。
 *
 * 视图构造器（build*View）是纯函数：只依赖入参、只返回 HTML 字符串，
 * 因此可以在 Node 里直接 import 做回归测试（见 test/views.test.mjs）。
 */

import { scoreDimension, finalizeReport } from './lib/pipeline.js';
import { createLlmClient } from './lib/llm.js';

const DRAFT_KEY = 'mbti-open-draft';
const KEY_STORE = 'mbti-open-api-key';
const CFG_STORE = 'mbti-open-api-cfg';

/* ---------- 运行模式 ---------- */

const DEFAULT_API_CFG = {
  providerId: 'minimax',
  baseURL: 'https://api.minimaxi.com/v1',
  model: 'MiniMax-M2.7',
  protocol: 'openai',
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);

/* ---------- 厂商预设 ---------- */

/**
 * `cors` 是实测结论（预检是否返回允许本页面的 Access-Control-Allow-Origin）：
 *   'ok'      —— 实测通过，浏览器可直连；
 *   'blocked' —— 实测被拒（没有 ACAO 头，或 403）；
 *   'unknown' —— 本机网络到不了该厂商，未能实测。
 *
 * 静态部署只能直连 cors==='ok' 的服务：浏览器发起的跨域请求由对方放行与否决定，
 * 客户端绕不过去。其余厂商请用**本机版**（npm start）——服务端发请求，不受跨域限制。
 */
export const PROVIDER_PRESETS = [
  {
    id: 'minimax', label: 'MiniMax（本站默认）', cors: 'ok',
    baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7', protocol: 'openai',
  },
  {
    id: 'deepseek', label: 'DeepSeek', cors: 'ok',
    baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai',
  },
  {
    id: 'qwen', label: '阿里云百炼 · 通义千问', cors: 'ok',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'openai',
  },
  {
    id: 'kimi', label: '月之暗面 · Kimi', cors: 'ok',
    baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', protocol: 'openai',
  },
  {
    id: 'doubao', label: '火山方舟 · 豆包', cors: 'ok',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: '',
    modelHint: '填你的接入点 ID（ep-…）', protocol: 'openai',
  },
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow', cors: 'ok',
    baseURL: 'https://api.siliconflow.cn/v1', model: '',
    modelHint: '如 Qwen/Qwen2.5-7B-Instruct', protocol: 'openai',
  },
  {
    id: 'openrouter', label: 'OpenRouter（可调多家模型）', cors: 'ok',
    baseURL: 'https://openrouter.ai/api/v1', model: '',
    modelHint: '如 openai/gpt-4o-mini', protocol: 'openai',
  },
  {
    id: 'qianfan', label: '百度千帆', cors: 'ok',
    baseURL: 'https://qianfan.baidubce.com/v2', model: '',
    modelHint: '如 ernie-4.0-8k', protocol: 'openai',
  },
  {
    id: 'custom', label: '自定义 OpenAI 兼容端点', cors: 'unknown',
    baseURL: '', model: '', modelHint: '填你的 /v1 根地址', protocol: 'openai',
  },
];

/** 预设的跨域标记 → 给人看的一句话。 */
export function corsBadge(cors) {
  if (cors === 'ok') return { text: '可直连', tone: 'ok' };
  if (cors === 'blocked') return { text: '浏览器直连被拒', tone: 'bad' };
  return { text: '未实测', tone: 'unknown' };
}

/** 按主机名找出对应的厂商预设。 */
export function matchPresetByHost(url) {
  const host = hostOf(url);
  if (!host) return null;
  return PROVIDER_PRESETS.find((p) => p.id !== 'custom' && hostOf(p.baseURL) === host) || null;
}

/**
 * 解析统一的连接串输入。三种写法都能认：
 *   ① `sk-xxx`                              —— 只给 Key，用默认厂商与模型
 *   ② `https://api.deepseek.com/v1#deepseek-chat` —— 给端点与模型，Key 用已保存的
 *   ③ `sk-xxx@https://api.deepseek.com/v1#deepseek-chat` —— 三样一起给
 * 前缀也允许写成 `@端点#模型`，表示"沿用已保存的 Key"。
 */
export function parseConnectionString(input, { savedKey = '' } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '请填入 API Key，或填端点地址#模型名。' };

  let key = '';
  let rest = raw;

  if (rest.startsWith('@')) {
    rest = rest.slice(1).trim();
  } else {
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      const head = rest.slice(0, at).trim();
      const tail = rest.slice(at + 1).trim();
      if (/^https?:\/\//i.test(tail)) {
        key = head;
        rest = tail;
      }
    }
  }

  let model = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    model = rest.slice(hash + 1).trim();
    rest = rest.slice(0, hash).trim();
  }

  if (!/^https?:\/\//i.test(rest)) {
    // 只给了一把 Key：走默认连接
    key = rest || key;
    rest = '';
    model = '';
  }

  if (!key) key = String(savedKey || '').trim();
  if (!key) {
    return {
      ok: false,
      error: '没有找到 API Key。可以直接粘一把 Key，或把 Key 写在最前面：Key@端点#模型。',
    };
  }

  const preset = matchPresetByHost(rest);
  const baseURL = rest || (preset ? preset.baseURL : DEFAULT_API_CFG.baseURL);
  const finalModel = model || (preset ? preset.model : DEFAULT_API_CFG.model);

  return {
    ok: true,
    apiKey: key,
    baseURL,
    model: finalModel,
    providerId: preset ? preset.id : 'custom',
  };
}

const HAS_BROWSER = typeof location !== 'undefined';
const FORCE_MODE = HAS_BROWSER ? new URLSearchParams(location.search).get('mode') : null;
const HOSTNAME = HAS_BROWSER ? location.hostname : '';

/**
 * 是否走"浏览器直连 API"的静态模式。
 * ?mode=direct / ?mode=local 可以强制指定，便于在本机验证静态链路。
 */
export const IS_DIRECT = HAS_BROWSER
  && (FORCE_MODE === 'direct' || (FORCE_MODE !== 'local' && !LOCAL_HOSTS.has(HOSTNAME)));

/** 直连模式下的接口配置，允许访客覆盖端点与模型。 */
function loadApiCfg() {
  let extra = {};
  try {
    extra = JSON.parse(localStorage.getItem(CFG_STORE) || '{}') || {};
  } catch {
    extra = {};
  }
  const merged = { ...DEFAULT_API_CFG, ...extra };
  // 预设被删掉后（比如 Anthropic 已从列表移除），旧的端点不该留在那儿装成别的厂商。
  const known = PROVIDER_PRESETS.some((p) => p.id === merged.providerId);
  if (!known) return { ...DEFAULT_API_CFG };
  return merged;
}

function saveApiCfg(patch) {
  const next = { ...loadApiCfg(), ...patch };
  try {
    localStorage.setItem(CFG_STORE, JSON.stringify(next));
  } catch (err) {
    console.warn('接口配置保存失败', err);
  }
  return next;
}

/** 取端点的主机名，用于在界面上说明"数据发去了哪里"。 */
export function hostOf(baseURL) {
  try {
    return new URL(String(baseURL || '')).host;
  } catch {
    return '';
  }
}

function loadApiKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

function saveApiKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORE, value);
    else localStorage.removeItem(KEY_STORE);
  } catch (err) {
    console.warn('密钥保存失败', err);
  }
}

/** 直连模式的模型客户端。每次都重建，避免换了 Key 之后还在用旧连接参数。 */
function directClient() {
  const key = loadApiKey();
  if (!key) {
    throw new Error('还没有填写 API Key。静态部署版需要你自己的 API Key。');
  }
  const cfg = { ...loadApiCfg(), apiKey: key, keyConfigured: true };
  return createLlmClient(cfg);
}

/* ---------- 接口设置面板的状态与动作 ---------- */

const apiPanelState = { message: null, busy: false };

/**
 * 连通性测试：发一个极小的请求。
 * 报错要说人话——尤其要把"跨域被拦"和"密钥错了"分开，
 * 因为前者改配置没有用，得换服务或改用本机版。
 */
export async function testConnection(values) {
  try {
    const client = createLlmClient({
      baseURL: values.baseURL,
      model: values.model,
      protocol: values.protocol,
      apiKey: values.key,
      keyConfigured: true,
    });
    const { content } = await client.rawCall({
      system: '按要求原样回复，不要多说。',
      user: '回复：收到',
      temperature: 0,
      maxTokens: 8,
    });
    const said = String(content || '').trim().slice(0, 40);
    return {
      tone: 'ok',
      text: `连接成功：${values.model || '(未填模型名)'} 已响应${said ? `（回复：${said}）` : ''}。`,
    };
  } catch (err) {
    const status = err?.status || 0;
    if (status === 401 || status === 403) {
      return { tone: 'bad', text: `密钥被拒（HTTP ${status}）：检查 API Key 是否正确、是否属于这个端点。` };
    }
    if (status === 404) {
      return { tone: 'bad', text: '端点或模型名不对（HTTP 404）：接口地址要填到 /v1 为止，模型名要用该服务商真实存在的。' };
    }
    if (status === 400) {
      return { tone: 'bad', text: '请求被拒（HTTP 400）：多半是模型名不被接受，或该服务对参数有额外要求。' };
    }
    if (status === 429) {
      return { tone: 'bad', text: '被限流了（HTTP 429）：稍后再试，或换个时段。' };
    }
    return {
      tone: 'bad',
      text: '浏览器连不上这个端点。多半是对方不允许网页直连（跨域被拦）——'
        + '改用列表里标「可直连」的服务，或改用本机版（npm start）：那时请求由本机服务端发出，不受跨域限制。',
    };
  }
}


const DIM_LABEL = {
  'E/I': '能量朝向',
  'S/N': '信息摄取',
  'T/F': '决策方式',
  'J/P': '生活节奏',
};

const DIM_ORDER = ['E/I', 'S/N', 'T/F', 'J/P'];

export const state = {
  stage: 'start',      // start | quiz | generating | final
  dimIndex: 0,
  itemIndex: 0,
  mode: 'full',        // full（每维 6 题）| quick（每维 4 题，只取 core 层）
  answers: {},         // dimension -> { itemId: { text, checked[] } }
  skipped: {},         // dimension -> [itemId]（受测者主动跳过的题）
  results: [],         // 已完成的维度判型结果
  pending: {},         // dimension -> true（后台计算中）
  errors: {},          // dimension -> 错误信息
  final: null,
  busy: false,
  error: null,
};

let bank = null;
let health = null;
let dom = null;

/* ---------- 工具 ---------- */

const CH_AMP = String.fromCharCode(38);
const CH_LT = String.fromCharCode(60);
const CH_GT = String.fromCharCode(62);
const CH_QUOT = String.fromCharCode(34);
const CH_APOS = String.fromCharCode(39);

const HTML_ENTITIES = {
  [CH_AMP]: CH_AMP + 'amp;',
  [CH_LT]: CH_AMP + 'lt;',
  [CH_GT]: CH_AMP + 'gt;',
  [CH_QUOT]: CH_AMP + 'quot;',
  [CH_APOS]: CH_AMP + '#39;',
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
}

function currentDimension() {
  return DIM_ORDER[state.dimIndex] || DIM_ORDER[0];
}

function itemsOf(dimension) {
  if (!bank) return [];
  const list = bank.items.filter((item) => item.dimension === dimension);
  // 快速版只问每维信号最干净的 4 题（core 层），扩展层留给完整版。
  if (state.mode === 'quick') return list.filter((item) => item.tier === 'core');
  return list;
}

function answersOf(dimension) {
  if (!state.answers[dimension]) state.answers[dimension] = {};
  return state.answers[dimension];
}

/** 该维度被主动跳过的题号。 */
function skippedOf(dimension) {
  if (!Array.isArray(state.skipped[dimension])) state.skipped[dimension] = [];
  return state.skipped[dimension];
}

export function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      stage: state.stage,
      dimIndex: state.dimIndex,
      itemIndex: state.itemIndex,
      mode: state.mode,
      answers: state.answers,
      skipped: state.skipped,
      results: state.results,
      pending: state.pending,
      errors: state.errors,
      final: state.final,
    }));
  } catch (err) {
    console.warn('草稿保存失败', err);
  }
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    Object.assign(state, {
      stage: parsed.stage || 'start',
      dimIndex: Number(parsed.dimIndex) || 0,
      itemIndex: Number(parsed.itemIndex) || 0,
      mode: parsed.mode === 'quick' ? 'quick' : 'full',
      answers: parsed.answers || {},
      skipped: parsed.skipped || {},
      results: Array.isArray(parsed.results) ? parsed.results : [],
      pending: parsed.pending || {},
      errors: parsed.errors || {},
      final: parsed.final || null,
    });
  } catch (err) {
    console.warn('草稿读取失败', err);
  }
}

/**
 * 草稿状态归一化：
 *  - 兼容旧版草稿里已废弃的 'dimensionResult' 阶段；
 *  - 作答位置始终对齐到「第一个还没判型的维度」，避免刷新后跳错组。
 */
export function normalizeState() {
  const validStages = ['start', 'quiz', 'generating', 'final'];

  if (!validStages.includes(state.stage)) {
    if (state.final) state.stage = 'final';
    else if (state.results.length >= DIM_ORDER.length) state.stage = 'generating';
    else state.stage = state.results.length ? 'quiz' : 'start';
  }

  if (state.stage === 'quiz') {
    const nextMissing = DIM_ORDER.findIndex((d) => !state.results.some((r) => r.dimension === d));
    if (nextMissing !== -1 && nextMissing !== state.dimIndex) {
      state.dimIndex = nextMissing;
      state.itemIndex = 0;
    }
    // 题数随版本变化（完整版 6 题 / 快速版 4 题），别让游标落在范围外
    const total = itemsOf(DIM_ORDER[state.dimIndex]).length;
    if (total > 0 && state.itemIndex > total - 1) state.itemIndex = total - 1;
    if (state.itemIndex < 0) state.itemIndex = 0;
  }

  if (state.stage === 'start' && state.results.length && !state.final) {
    state.stage = 'quiz';
  }

  return state;
}

/**
 * 由已有的单维判型结果推出应有的类型字母。
 * 某一维还定不出倾向时返回空串——此时无法断定报告是否过期。
 */
export function expectedTypeFrom(results) {
  const letters = DIM_ORDER.map((key) => {
    const hit = (results || []).find((r) => r.dimension === key);
    return hit && hit.lean && hit.lean !== 'ambiguous' ? hit.lean : '';
  });
  return letters.every(Boolean) ? letters.join('') : '';
}

export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ }
}

/* ---------- 重新开始（行内二次确认） ---------- */

/**
 * 原生 confirm() 会锁住渲染线程——在嵌入式面板里可能把整个界面卡死
 * （实测点一次就挂到超时）。改成按钮自身的两段式确认：
 * 第一次点击变成"确认清空草稿？"，再点一次才真的清空。
 * 武装状态记在按钮自己身上，重新渲染出新按钮时自然失效。
 */
export function bindRestart(button) {
  if (!button || button.dataset.confirmBound === '1') return;
  button.dataset.confirmBound = '1';
  const original = button.textContent || '重新开始';

  button.addEventListener('click', () => {
    if (button.dataset.armed === '1') {
      clearDraft();
      window.location.reload();
      return;
    }
    button.dataset.armed = '1';
    button.textContent = '确认清空草稿？';
    button.classList.add('btn--danger');
  });
}

/* ---------- API ---------- */

/**
 * 单维判型。local 模式走同源服务端；direct 模式由浏览器直连 API。
 * 两条路径调用的是同一份 public/lib/pipeline.js，结果口径一致。
 */
async function requestScore(dimension, answers, skipped = []) {
  if (IS_DIRECT) {
    return scoreDimension({
      dimension,
      answers,
      skipped,
      items: itemsOf(dimension),
      client: directClient(),
    });
  }
  return postJSON('api/score', { dimension, answers, skipped });
}

/** 合成最终画像。同样两种路径。 */
async function requestFinalize(dimensionResults) {
  if (IS_DIRECT) {
    const cfg = loadApiCfg();
    const result = await finalizeReport({
      dimensionResults,
      client: directClient(),
      onNote: (message) => console.info('[mbti-open]', message),
    });
    result.meta = { model: cfg.model, endpointHost: hostOf(cfg.baseURL), protocol: cfg.protocol };
    return result;
  }
  return postJSON('api/finalize', { dimensionResults });
}

export async function postJSON(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error('连不上本机服务（127.0.0.1:5173）。请确认服务端还在运行再重试——你的作答已经存在浏览器里，不会丢。');
  }
  let data = null;
  try { data = await response.json(); } catch { /* 非 JSON 响应 */ }
  if (!response.ok) {
    const message = (data && (data.error || data.detail)) || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 视图构造器（纯函数） ---------- */

export function buildStatusStrip({ results = [], pending = {}, errors = {}, dimIndex = 0 } = {}) {
  const items = DIM_ORDER.map((dimension, index) => {
    const done = results.some((r) => r.dimension === dimension);
    const isPending = Boolean(pending[dimension]);
    const failed = Boolean(errors[dimension]);
    const status = done ? '完成' : failed ? '失败' : isPending ? '计算中' : (index === dimIndex ? '作答中' : '待答');
    const modifier = done ? 'is-done' : failed ? 'is-failed' : isPending ? 'is-pending' : (index === dimIndex ? 'is-active' : 'is-idle');
    return `<span class="dim-strip__item dim-strip__item--${modifier}">${esc(dimension)}<em>${esc(status)}</em></span>`;
  });
  return `<div class="dim-strip">${items.join('')}</div>`;
}

export function buildErrorBanner({ errors = {} } = {}) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return '';
  return `<div class="notice">
    ${entries.map(([dimension, message]) => `
      <div><b>${esc(dimension)} 判型失败</b>：${esc(message)}
        <button type="button" class="btn btn--sm" data-retry-dim="${esc(dimension)}">重试评判</button>
      </div>`).join('')}
  </div>`;
}

/**
 * 静态部署版的接口设置：一个输入框搞定。
 * 只有 direct 模式（纯静态托管）才需要——那时没有后端替访客保管密钥。
 */
export function buildApiSettingsPanel({
  cfg = {}, hasKey = false, message = '', busy = false,
} = {}) {
  const chips = PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => {
    const badge = corsBadge(p.cors);
    const template = p.model ? `${p.baseURL}#${p.model}` : p.baseURL;
    return `<button type="button" class="conn-chip conn-chip--${esc(badge.tone)}" data-conn="${esc(template)}">
        <span class="conn-chip__name">${esc(p.label)}</span>
        <span class="conn-chip__meta">${esc(badge.text)}</span>
      </button>`;
  }).join('');

  const current = cfg.baseURL
    ? `当前连接：${esc(cfg.model || '(未填模型名)')} · ${esc(hostOf(cfg.baseURL))}`
    : '';

  const messageHTML = message
    ? `<p class="small api-msg api-msg--${esc(message.tone || 'info')}">${esc(message.text)}</p>`
    : '';

  return `
    <div class="key-panel">
      <h2 class="key-panel__title">接哪家的模型？</h2>
      <p class="small">
        一个框就行，不用区分厂商或模型：
        <br>· 只填 <code>API Key</code> —— 用默认的 ${esc(DEFAULT_API_CFG.model)}；
        <br>· 填 <code>端点地址#模型名</code> —— 用这台设备上已保存的 Key；
        <br>· 填 <code>Key@端点地址#模型名</code> —— 三样一起指定。
      </p>

      <input type="text" id="api-conn" class="key-input key-input--conn" spellcheck="false" autocomplete="off"
             placeholder="${esc(hasKey
               ? '已保存一个 Key：填 端点#模型 即可，或重新粘一把 Key'
               : 'sk-…  或  https://api.deepseek.com/v1#deepseek-chat')}">

      <div class="btn-row" style="margin-top:12px">
        <button type="button" class="btn btn--primary" id="api-save">保存</button>
        <button type="button" class="btn" id="api-test"${busy ? ' disabled' : ''}>${busy ? '正在测试…' : '测试连接'}</button>
        <button type="button" class="btn btn--ghost" id="api-key-clear">清除 Key</button>
      </div>

      ${messageHTML}

      <p class="small">${current ? `${esc(current)} · ` : ''}Key ${hasKey ? '已保存在这台设备上' : '尚未保存'}</p>

      <div class="conn-chips">
        <span class="conn-chips__label">常用连接串（点一下填进上面的框）</span>
        ${chips}
      </div>

      <p class="small">
        标「可直连」的服务浏览器能直接调；标「浏览器直连被拒」或「未实测」的，请改用<b>本机版</b>
        （<code>npm start</code>）——那时请求由本机服务端发出，不受跨域限制，任意厂商都可以。
      </p>
    </div>`;
}

export function buildStartView({
  bank: itemBank, health: itemHealth, resultCount = 0, keyPanel = '', direct = false,
  mode = 'full', modeSelectable = true, apiCfg = null,
} = {}) {
  const healthLine = direct
    ? `<span class="small">静态直连模式 · ${esc(apiCfg?.model || '未指定模型')} · `
      + `${esc(hostOf(apiCfg?.baseURL) || '未指定端点')} · 密钥只存在你的浏览器里</span>`
    : itemHealth
      ? (itemHealth.keyConfigured
        ? `<span class="small">服务已就绪 · 模型 ${esc(itemHealth.model)} · 端点 ${esc(itemHealth.endpointHost)}</span>`
        : `<span class="small" style="color:var(--warn-ink)">服务未找到可用凭证，判型会失败：${esc(itemHealth.model || '模型未配置')}</span>`)
      : '<span class="small">正在检查服务状态…</span>';

  const allItems = itemBank ? itemBank.items : [];
  const coreItems = allItems.filter((i) => i.tier === 'core');
  const isQuick = mode === 'quick';
  const perDimension = isQuick ? 4 : 6;
  const total = isQuick ? (coreItems.length || 16) : (allItems.length || 24);
  const count = allItems.length || 24;

  const modePanel = modeSelectable
    ? `<div class="mode-panel">
        <h2 class="mode-panel__title">这次想花多少时间？</h2>
        <p class="small">
          两个版本问的是同一批题目，只是数量不同：快速版每个维度只问信号最干净的 4 题，
          完整版每维 6 题、覆盖的行为侧面更全。哪个维度写不出来都可以<b>跳过</b>，
          跳过的题会在报告里如实记成证据缺口，而不是悄悄消失。
        </p>
        <div class="mode-panel__row">
          <button type="button" class="mode-card${isQuick ? '' : ' mode-card--on'}" data-mode="full">
            <span class="mode-card__title">完整版</span>
            <span class="mode-card__meta">每维 6 题 · 共 ${count} 题 · 约 15–20 分钟</span>
            <span class="mode-card__note">证据最厚，反向证据最容易浮出来</span>
          </button>
          <button type="button" class="mode-card${isQuick ? ' mode-card--on' : ''}" data-mode="quick">
            <span class="mode-card__title">快速版</span>
            <span class="mode-card__meta">每维 4 题 · 共 ${coreItems.length || 16} 题 · 约 10–13 分钟</span>
            <span class="mode-card__note">省三分之一时间，每维少两个行为侧面</span>
          </button>
        </div>
      </div>`
    : `<p class="small">本次为${isQuick ? '快速版（每维 4 题）' : '完整版（每维 6 题）'}。想换版本请点右上角"重新开始"。</p>`;

  return `
    <p class="kicker">开放题版 MBTI</p>
    <h1>把选择题换成你自己写的场景</h1>
    <p class="lede">
      传统量表让你在若干选项里挑一个最像的。这份测试反过来：每一题给你一个情境框定，
      你写下自己在类似情境下<b>可能产生的行为与想法</b>。模型读的是你的原话，
      按量表原有的维度框架给出倾向、置信度和一份能追溯到原句的人物小传。
    </p>

    <div class="section-rule"></div>

    <ul class="fact-list">
      <li><span class="k">题量</span><span>${isQuick ? '快速版' : '完整版'}共 ${total} 道开放情境题，分 4 组，每组 ${perDimension} 题，对应 E/I、S/N、T/F、J/P 四个维度。</span></li>
      <li><span class="k">节奏</span><span>每组约 ${isQuick ? '2–3' : '3–5'} 分钟。提交一组后立刻进入下一组，上一组的判型在后台并行计算。</span></li>
      <li><span class="k">证据</span><span>画像里的每一条判断都必须引用你的原话；引文对不上的会被丢弃，该维置信度随之下调。</span></li>
      <li><span class="k">产出</span><span>四维读数与全部证据、四字母类型、可回查的引证表，以及一份逐段带引文的人物小传。</span></li>
    </ul>

    <div class="section-rule"></div>

    ${modePanel}

    <div class="notice notice--calm">
      <b>为什么必须写具体场景。</b>含糊的作答（"我挺外向的""看情况"）不构成证据。
      题干下方那三项自检，就是判型时找不找得到证据的直接依据。
    </div>

    <div class="notice">
      <b>边界。</b>这是一份<b>倾向画像</b>，不是类型判定，也不是任何形式的诊断。
      它没有信效度检验，不适用于招聘筛选等高风险决策。
    </div>

    ${keyPanel}

    <div class="btn-row">
      <button type="button" class="btn btn--primary" id="start-btn">开始作答</button>
      ${resultCount ? '<button type="button" class="btn" id="resume-btn">回到上次进度</button>' : ''}
    </div>
    <p class="small" style="margin-top:14px">${healthLine}</p>
  `;
}

export function buildQuizView({
  dimension, item, itemIndex = 0, total = 6, text = '', checked = [],
  isLastDimension = false, error = null, statusStrip = '', errorBanner = '',
  skipped = false,
} = {}) {
  const alt = DIM_ORDER.indexOf(dimension) % 2 === 1;
  const skipBanner = skipped
    ? `<div class="notice notice--calm">
        <b>本题已跳过。</b>没有作答材料，报告会把它记成证据缺口，不会替你猜。
        想写的话直接在下面输入就自动取消跳过。
      </div>`
    : '';
  return `
    ${statusStrip}
    ${errorBanner}

    <div class="quiz-head">
      <span class="dimension-tag${alt ? ' dimension-tag--alt' : ''}">本题关注维度 · ${esc(dimension)}</span>
      <span class="small">${esc(DIM_LABEL[dimension] || '')} · 第 ${itemIndex + 1} / ${total} 题</span>
    </div>

    <h2 class="prompt">${esc(item.prompt)}</h2>
    <p class="guide">${esc(item.writingGuide || '')}</p>

    ${skipBanner}

    <label class="label" for="answer">你的作答</label>
    <textarea id="answer" placeholder="写下你真实会做的事、真实会有的念头……">${esc(text)}</textarea>
    <div class="counter" id="counter">${text.length} 字</div>

    <ul class="checks">
      ${(item.minInfo || []).map((hint, index) => `
        <li>
          <label class="check${checked[index] ? ' check--on' : ''}">
            <input type="checkbox" data-check="${index}"${checked[index] ? ' checked' : ''}>
            <span>${esc(hint)}</span>
          </label>
        </li>`).join('')}
    </ul>

    <div class="quiz-foot">
      <button type="button" class="btn btn--ghost" id="prev-btn"${itemIndex === 0 ? ' disabled' : ''}>上一题</button>
      <div class="btn-row">
        ${itemIndex < total - 1
          ? '<button type="button" class="btn" id="next-btn">下一题</button>'
          : `<button type="button" class="btn btn--primary" id="submit-dim-btn">${isLastDimension ? '提交并生成画像' : '提交并继续下一维'}</button>`}
        <button type="button" class="btn btn--ghost" id="skip-btn">${skipped ? '重新作答' : '跳过这题'}</button>
      </div>
    </div>

    ${error ? `<div class="notice" style="margin-top:18px">${esc(error)}</div>` : ''}
  `;
}

export function buildGeneratingView({ statusStrip = '', errorBanner = '', error = null } = {}) {
  return `
    ${statusStrip}
    ${errorBanner}

    <p class="kicker">生成中</p>
    <h1>正在收束四个维度的判型结果</h1>
    <p class="lede">
      每个维度的判型在后台独立进行，互不阻塞。四维结果齐备后会自动合成类型与人物小传。
    </p>

    <div class="section-rule"></div>

    <div class="sheet sheet--tight" style="text-align:center;padding:46px 24px">
      <p><span class="spinner"></span>等待后台判型完成…</p>
      <p class="small">这段时间你可以继续往下作答，不必等待。</p>
    </div>

    ${error ? `<div class="notice" style="margin-top:18px">${esc(error)}</div>` : ''}
  `;
}

/** 本维度实际用了多少作答、跳过了哪几题。少答要说出来，不能让读者以为证据是完整的。 */
export function coverageLine(result) {
  if (!result) return '';
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const answered = Number.isFinite(result.answeredCount)
    ? result.answeredCount
    : null;
  if (!skipped.length && answered === null) return '';
  if (!skipped.length) {
    return `<p class="small">本维度实际作答 ${answered} 题。</p>`;
  }
  return `<p class="small">本维度实际作答 ${answered === null ? '若干' : answered} 题，`
    + `跳过 ${skipped.length} 题（${esc(skipped.join('、'))}）。`
    + '跳过的题没有作答材料，报告不会替它们推断倾向。</p>';
}

/** 单个维度的证据区（支撑 / 反向 / 易误读 / 缺口），供维度卡与最终报告共用。 */
export function buildDimensionDetail(result) {
  if (!result) return '';

  // 结果来自接口，字段未必齐全；缺字段时按空处理，不能让整页崩掉。
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const counterEvidence = Array.isArray(result.counterEvidence) ? result.counterEvidence : [];
  const misreadChecks = Array.isArray(result.misreadChecks) ? result.misreadChecks : [];
  const missing = Array.isArray(result.missing) ? result.missing : [];

  const evidenceHTML = evidence.length
    ? `<ul class="quote-list">${evidence.map((entry) => `
        <li class="${entry.strength === 'weak' ? 'weak' : ''}">
          <q>${esc(entry.quote)}</q>
          <span class="src">${esc(entry.itemId)} · ${esc(entry.signal || '')}${entry.strength === 'weak' ? ' · 弱证据' : ''}</span>
        </li>`).join('')}</ul>`
    : '<p class="small">本维度没有产出通过引文校验的证据，因此不给出倾向。</p>';

  const counterHTML = counterEvidence.length
    ? `<h3 style="margin-top:26px">反向证据</h3>
       <ul class="quote-list">${counterEvidence.map((entry) => `
         <li><q>${esc(entry.quote)}</q><span class="src">${esc(entry.itemId)} · ${esc(entry.signal || '')}</span></li>`).join('')}</ul>`
    : '';

  const misreadHTML = misreadChecks.length
    ? `<h3 style="margin-top:26px">易误读核对</h3>
       <ul class="caveats">${misreadChecks.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`
    : '';

  const missingHTML = missing.length
    ? `<h3 style="margin-top:26px">证据缺口</h3>
       <p class="small">${missing.map(esc).join('、')} —— 这些题没能拿到可用证据。</p>`
    : '';

  return `${evidenceHTML}${counterHTML}${misreadHTML}${missingHTML}`;
}

/**
 * 把一次维度判型读成「倾向 + 倾向强度 + 置信度」。
 *
 * score 是**轴坐标**：0 = 完全倒向第一极，1 = 完全倒向第二极（见 lib/prompts.js 的计分轴约定）。
 * 因此当倾向落在第一极时，倾向强度必须取 1 - score，否则会出现
 * 「倾向 S / 强度 30% / 往 N 偏」这种自相矛盾的读数。
 */
export function readoutOf(dim, poles = []) {
  const lean = String(dim?.lean ?? 'ambiguous');
  const axisScore = Number(dim?.score ?? dim?.strength ?? 0.5);
  const [poleA, poleB] = Array.isArray(poles) ? poles : [];
  let strength = 0.5;
  if (lean !== 'ambiguous') {
    if (lean === poleA) strength = 1 - axisScore;
    else if (lean === poleB) strength = axisScore;
    else strength = axisScore;
  }
  return {
    lean,
    strength: Math.min(1, Math.max(0, strength)),
    direction: lean === 'ambiguous' ? '' : lean,
    confidence: Number(dim?.confidence || 0),
  };
}

export function buildFinalView({
  final, itemBank: itemBankData, dimensionResults = [], error = null, errorBanner = '',
} = {}) {
  if (!final) {
    return `${errorBanner}<div class="notice">还没有生成最终画像。</div>`;
  }

  const letters = String(final.type || '').split('');
  const poleNames = {
    E: '外向', I: '内向',
    S: '实感', N: '直觉',
    T: '思考', F: '情感',
    J: '判断', P: '知觉',
  };

  const poleOf = (key) => {
    const meta = itemBankData?.dimensions?.find((d) => d.key === key);
    return meta ? meta.poles : [];
  };
  const scoredOf = (key) => (dimensionResults || []).find((r) => r.dimension === key);

  // 单维判型阶段判定为"证据不足"的维度，类型字母仍可能由汇总阶段微弱裁决给出，
  // 因此在字母下方直接标注，避免读者以为该维度证据充分。
  const typeHTML = letters.length
    ? `<div class="type-display">${letters.map((letter, index) => {
      const key = DIM_ORDER[index] || '';
      const scored = scoredOf(key);
      const flag = scored && scored.lean === 'ambiguous'
        ? `<span class="type-letter__flag">该维度证据不足</span>`
        : '';
      return `
        <div class="type-letter">
          ${esc(letter)}
          <span class="type-letter__pole">${esc(key)} ${esc(poleNames[letter] || '')}</span>
          ${flag}
        </div>`;
    }).join('')}</div>`
    : '<div class="notice">未能确定类型字母。</div>';

  const finalByDim = new Map((final.dimensions || []).map((d) => [d.dimension, d]));

  // 四维读数：以单维判型（引文已逐条校验）为主，汇总阶段读数作为补充。
  // 两阶段读数不一致时两个都列出来，而不是只显示其中一个。
  const dimRows = DIM_ORDER.map((key) => {
    const meta = itemBankData?.dimensions?.find((d) => d.key === key);
    const poles = poleOf(key);
    const scored = scoredOf(key);
    const summarized = finalByDim.get(key);
    const primary = scored || summarized;
    if (!primary) return '';

    const { lean, strength, direction, confidence } = readoutOf(primary, poles);
    const label = lean === 'ambiguous' ? '未定' : `${lean}（${poles[0]}／${poles[1]}）`;
    const strengthCell = lean === 'ambiguous'
      ? '50%<br><span class="small dim-table__dir">居中，未定向</span>'
      : `${(strength * 100).toFixed(0)}%<br><span class="small dim-table__dir">往 ${esc(direction)} 偏</span>`;
    const rationale = (summarized && summarized.rationale) || (scored && scored.note) || '';

    let crossNote = '';
    if (scored && summarized) {
      const s = readoutOf(scored, poles);
      const f = readoutOf(summarized, poles);
      if (s.lean !== f.lean) {
        crossNote = `<br><span class="small">汇总阶段读作 ${f.lean === 'ambiguous' ? '未定' : esc(f.lean)}（置信度 ${(f.confidence * 100).toFixed(0)}%），与单维判型不一致</span>`;
      }
    }

    return `
      <tr>
        <td>${esc(key)}<br><span class="small">${esc(meta?.label || '')}</span></td>
        <td class="dim-table__lean">${esc(label)}</td>
        <td>${strengthCell}</td>
        <td>${(confidence * 100).toFixed(0)}%</td>
        <td>${esc(rationale)}${crossNote}</td>
      </tr>`;
  }).join('');

  const evidenceRows = (final.evidenceMap || []).map((entry) => `
    <tr>
      <td>${esc(entry.dimension)}</td>
      <td>${esc(entry.itemId)}</td>
      <td>「${esc(entry.quote)}」</td>
    </tr>`).join('');

  const bio = final.biography || {};
  // 写明是谁判的型：换厂商/换模型，口径未必一样，得让人知道。
  const meta = final.meta || {};
  const metaLine = meta.model
    ? `<p class="small">本次判型由 <b>${esc(meta.model)}</b>`
      + `${meta.endpointHost ? `（${esc(meta.endpointHost)}）` : ''} 生成。`
      + '不同模型的判型口径会有差异；用同一份作答换模型重跑，可以作对照。</p>'
    : '';
  const bioHTML = bio.degraded
    ? `<h2>人物小传</h2>
       <p class="notice">${esc(bio.closing || '本次未生成叙述性小传。')}</p>
       ${(bio.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}`
    : `<div class="biography">
         <h2>人物小传</h2>
         ${(bio.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}
         ${bio.closing ? `<p class="closing">${esc(bio.closing)}</p>` : ''}
       </div>`;

  const caveatsHTML = (final.caveats || []).length
    ? `<h3 style="margin-top:26px">证据边界</h3>
       <ul class="caveats">${final.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
    : '';

  // 每个维度的完整判型结果（支撑 / 反向 / 易误读 / 缺口），一并呈现在汇总页。
  const dimensionSections = dimensionResults.length
    ? `<div class="section-rule"></div>
       <h3>四个维度的判型依据</h3>
       ${dimensionResults.map((result) => {
    const meta = itemBankData?.dimensions?.find((d) => d.key === result.dimension);
    const poles = meta ? meta.poles : [];
    const axis = result.axis || { from: poles[0] || '', to: poles[1] || '' };
    const { lean, strength } = readoutOf(result, poles);
    const verdict = lean === 'ambiguous'
      ? '证据不足（居中）'
      : `${esc(lean)} 倾向 ${(strength * 100).toFixed(0)}%`;
    return `
         <section class="dim-block">
           <h4 class="dim-block__title">${esc(result.dimension)} · ${esc(meta?.label || '')}
             <span class="dim-block__verdict">${verdict}
               · 置信度 ${(Number(result.confidence || 0) * 100).toFixed(0)}%
               <em>轴 ${esc(axis.from)} → ${esc(axis.to)}</em>
             </span>
           </h4>
           ${result.note ? `<p class="small">${esc(result.note)}</p>` : ''}
           ${coverageLine(result)}
           ${buildDimensionDetail(result)}
         </section>`;
  }).join('')}`
    : '';

  // 大字母与四维读数必须同源。草稿里的报告可能是旧算法留下的，
  // 这时明确标出来，而不是让两个读数在页面上互相矛盾。
  const expectedType = expectedTypeFrom(dimensionResults);
  const inconsistent = Boolean(expectedType) && expectedType !== final.type;
  const inconsistentNotice = inconsistent
    ? `<div class="notice"><b>这份报告的类型字母与四维读数不一致。</b>
        逐维判型指向 ${esc(expectedType)}，而报告顶部写的是 ${esc(final.type)}——
        多半是服务端更新后留下的旧报告。点"重新合成报告"即可按当前判型结果重新生成。</div>`
    : '';

  return `
    ${errorBanner}
    ${inconsistentNotice}

    <p class="kicker">倾向画像</p>
    <h1>${esc(bio.title || '你的画像')}</h1>
    <p class="small">整体置信度 ${(Number(final.typeConfidence || 0) * 100).toFixed(0)}%</p>
    ${metaLine}

    ${typeHTML}

    <div class="section-rule"></div>
    <h3>四维读数</h3>
    <table class="dim-table">
      <thead><tr><th>维度</th><th>倾向</th><th>强度</th><th>置信度</th><th>依据</th></tr></thead>
      <tbody>${dimRows || '<tr><td colspan="5">暂无</td></tr>'}</tbody>
    </table>

    <div class="section-rule"></div>
    ${bioHTML}
    ${caveatsHTML}

    ${dimensionSections}

    <div class="section-rule"></div>
    <h3>引证表</h3>
    <p class="small">下面每一条都能在你的作答原文里找到。找不到的引文已在服务端被丢弃。</p>
    <table class="dim-table">
      <thead><tr><th>维度</th><th>题号</th><th>原文</th></tr></thead>
      <tbody>${evidenceRows || '<tr><td colspan="3">本次没有通过校验的引文。</td></tr>'}</tbody>
    </table>

    <div class="section-rule"></div>
    <div class="notice">
      <b>请把这当作一份倾向读数。</b>它由模型依据你的原话生成，没有信效度检验，
      也不是诊断。它不应当被用于招聘筛选、升学分流等高风险决策。
    </div>

    <div class="btn-row">
      <button type="button" class="btn" id="print-btn">打印 / 存为 PDF</button>
      <button type="button" class="btn btn--ghost" id="re-finalize-btn">重新合成报告</button>
      <button type="button" class="btn btn--ghost" id="restart-btn-2">重新开始</button>
    </div>
    ${error ? `<div class="notice" style="margin-top:18px">${esc(error)}</div>` : ''}
  `;
}

/* ---------- 判型与流程 ---------- */

function mergeResult(result) {
  const index = state.results.findIndex((r) => r.dimension === result.dimension);
  if (index === -1) state.results.push(result);
  else state.results[index] = result;
  state.results.sort((a, b) => DIM_ORDER.indexOf(a.dimension) - DIM_ORDER.indexOf(b.dimension));
}

/** 后台判型：完成即写入结果，失败即记录错误，都不阻塞作答。 */
async function runScore(dimension) {
  const items = itemsOf(dimension);
  const bucket = answersOf(dimension);
  const skipped = skippedOf(dimension).filter((id) => items.some((item) => item.id === id));
  const answers = items.map((item) => ({
    itemId: item.id,
    text: (bucket[item.id] || {}).text || '',
  }));

  state.pending[dimension] = true;
  delete state.errors[dimension];
  saveDraft();
  render();

  try {
    const result = await requestScore(dimension, answers, skipped);
    mergeResult(result);
  } catch (err) {
    state.errors[dimension] = err.message;
  } finally {
    delete state.pending[dimension];
    saveDraft();
    render();
    maybeFinalize();
  }
}

/** 提交本维：立即跳到下一维作答，本维判型转后台。 */
function submitDimension() {
  if (state.busy) return;
  const dimension = currentDimension();
  const items = itemsOf(dimension);
  const bucket = answersOf(dimension);

  const written = (item) => ((bucket[item.id] || {}).text || '').trim();
  const missing = items.filter((item) => !written(item));

  if (!items.some(written)) {
    state.error = '这一维至少要写一题。写不出来可以跳过，但不能整维都空着。';
    render();
    return;
  }

  // 没写的题自动计为跳过；跳过的题会带着题号一起提交，由服务端记为证据缺口。
  const skipped = [...new Set([
    ...skippedOf(dimension).filter((id) => items.some((item) => item.id === id)),
    ...missing.map((item) => item.id),
  ])];
  state.skipped[dimension] = skipped;
  state.error = null;

  if (state.dimIndex < DIM_ORDER.length - 1) {
    state.dimIndex += 1;
    state.itemIndex = 0;
  } else {
    state.stage = 'generating';
  }
  render();

  runScore(dimension); // 不 await：后台并行计算
}

/** 四维结果齐备后自动合成最终画像。 */
function maybeFinalize() {
  if (state.stage !== 'generating') return;
  if (Object.keys(state.pending).length) return;

  const missing = DIM_ORDER.filter((d) => !state.results.some((r) => r.dimension === d));
  if (missing.length) {
    state.stage = 'quiz';
    state.dimIndex = DIM_ORDER.indexOf(missing[0]);
    state.itemIndex = 0;
    state.error = `以下维度还没拿到判型结果：${missing.join('、')}。可以点"重试评判"，或回到该维度修改作答。`;
    render();
    return;
  }
  finalize();
}

async function finalize() {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  render();

  try {
    const result = await requestFinalize(state.results);
    state.final = result;
    state.stage = 'final';
    state.busy = false;
    saveDraft();
    render();
  } catch (err) {
    state.busy = false;
    state.error = `合成失败：${err.message}`;
    // 已经有一份报告时，别把用户挡在门外：退回报告页，旧报告仍然可看。
    if (state.final) state.stage = 'final';
    render();
  }
}

/** 用已有的四维结果重新合成一次报告，不必重答 24 题。 */
function refinalize() {
  if (state.busy) return;
  const missing = DIM_ORDER.filter((d) => !state.results.some((r) => r.dimension === d));
  if (missing.length) {
    state.error = `以下维度还没有判型结果，无法重新合成：${missing.join('、')}。请先补齐或重试评判。`;
    render();
    return;
  }
  state.error = null;
  state.stage = 'generating';
  render();
  finalize();
}

/* ---------- 渲染与事件绑定 ---------- */

function currentStatusStrip() {
  return buildStatusStrip({
    results: state.results,
    pending: state.pending,
    errors: state.errors,
    dimIndex: state.dimIndex,
  });
}

function currentErrorBanner() {
  return buildErrorBanner({ errors: state.errors });
}

function bindRetryButtons() {
  dom.view.querySelectorAll('[data-retry-dim]').forEach((button) => {
    button.addEventListener('click', () => {
      const dimension = button.dataset.retryDim;
      if (!dimension) return;
      state.error = null;
      render();
      runScore(dimension);
    });
  });
}

function renderStart() {
  const apiCfg = loadApiCfg();
  const keyPanel = IS_DIRECT
    ? buildApiSettingsPanel({
      cfg: apiCfg,
      providerId: apiCfg.providerId || 'minimax',
      hasKey: Boolean(loadApiKey()),
      message: apiPanelState.message,
      busy: apiPanelState.busy,
    })
    : '';
  dom.view.innerHTML = buildStartView({
    bank,
    health,
    resultCount: state.results.length,
    keyPanel,
    direct: IS_DIRECT,
    mode: state.mode,
    modeSelectable: state.results.length === 0 && !state.final,
    apiCfg,
  });

  dom.view.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.mode === 'quick' ? 'quick' : 'full';
      if (next === state.mode) return;
      state.mode = next;
      // 题集变了，之前写的答案不再对应当前版本
      state.answers = {};
      state.skipped = {};
      state.itemIndex = 0;
      state.error = null;
      saveDraft();
      render();
    });
  });

  dom.view.querySelector('#api-save')?.addEventListener('click', () => {
    const parsed = parseConnectionString(dom.view.querySelector('#api-conn')?.value, {
      savedKey: loadApiKey(),
    });
    if (!parsed.ok) {
      apiPanelState.message = { tone: 'bad', text: parsed.error };
      render();
      return;
    }
    saveApiKey(parsed.apiKey);
    saveApiCfg({
      providerId: parsed.providerId,
      baseURL: parsed.baseURL,
      model: parsed.model,
      protocol: 'openai',
    });
    apiPanelState.message = {
      tone: 'ok',
      text: `已保存：${parsed.model} · ${hostOf(parsed.baseURL)}。可以点"测试连接"确认这个端点通不通。`,
    };
    render();
  });

  dom.view.querySelector('#api-test')?.addEventListener('click', async () => {
    const parsed = parseConnectionString(dom.view.querySelector('#api-conn')?.value, {
      savedKey: loadApiKey(),
    });
    if (!parsed.ok) {
      apiPanelState.message = { tone: 'bad', text: parsed.error };
      render();
      return;
    }
    saveApiKey(parsed.apiKey);
    saveApiCfg({
      providerId: parsed.providerId,
      baseURL: parsed.baseURL,
      model: parsed.model,
      protocol: 'openai',
    });
    apiPanelState.busy = true;
    apiPanelState.message = null;
    render();

    apiPanelState.message = await testConnection(parsed);
    apiPanelState.busy = false;
    render();
  });

  dom.view.querySelector('#api-key-clear')?.addEventListener('click', () => {
    saveApiKey('');
    apiPanelState.message = { tone: 'info', text: '已清除这台设备上保存的 Key。' };
    render();
  });

  dom.view.querySelectorAll('[data-conn]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = dom.view.querySelector('#api-conn');
      if (!input) return;
      input.value = chip.dataset.conn || '';
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      apiPanelState.message = null;
    });
  });

  dom.view.querySelector('#start-btn')?.addEventListener('click', () => {
    if (IS_DIRECT && !loadApiKey()) {
      state.error = '静态部署版需要你自己的 API Key：先在上面填一个，再开始作答。';
      render();
      return;
    }
    state.stage = 'quiz';
    state.error = null;
    saveDraft();
    render();
  });

  dom.view.querySelector('#resume-btn')?.addEventListener('click', () => {
    state.stage = state.final ? 'final' : (state.results.length === DIM_ORDER.length ? 'generating' : 'quiz');
    render();
    if (state.stage === 'generating') maybeFinalize();
  });
}

function renderQuiz() {
  const dimension = currentDimension();
  const items = itemsOf(dimension);
  const item = items[state.itemIndex] || items[0];

  if (!item) {
    dom.view.innerHTML = '<div class="notice">题库异常：当前维度没有题目。</div>';
    return;
  }

  const bucket = answersOf(dimension);
  const entry = bucket[item.id] || { text: '', checked: [] };
  const text = entry.text || '';
  const checked = entry.checked || [];
  const total = items.length;
  const isSkipped = skippedOf(dimension).includes(item.id);

  dom.view.innerHTML = buildQuizView({
    dimension,
    item,
    itemIndex: state.itemIndex,
    total,
    text,
    checked,
    isLastDimension: state.dimIndex >= DIM_ORDER.length - 1,
    error: state.error,
    statusStrip: currentStatusStrip(),
    errorBanner: currentErrorBanner(),
    skipped: isSkipped,
  });

  bindRetryButtons();

  const textarea = dom.view.querySelector('#answer');
  const counter = dom.view.querySelector('#counter');

  textarea?.addEventListener('input', () => {
    const current = answersOf(dimension);
    current[item.id] = { text: textarea.value, checked: (current[item.id] || {}).checked || [] };
    // 一开始写就等于取消跳过
    const skippedList = skippedOf(dimension);
    const at = skippedList.indexOf(item.id);
    if (at !== -1) {
      skippedList.splice(at, 1);
      state.skipped[dimension] = skippedList;
    }
    if (counter) counter.textContent = `${textarea.value.length} 字`;
    saveDraft();
  });

  dom.view.querySelectorAll('input[data-check]').forEach((input) => {
    input.addEventListener('change', () => {
      const current = answersOf(dimension);
      const record = current[item.id] || { text: textarea ? textarea.value : '', checked: [] };
      record.checked = record.checked || [];
      record.checked[Number(input.dataset.check)] = input.checked;
      record.text = textarea ? textarea.value : record.text;
      current[item.id] = record;
      input.closest('.check')?.classList.toggle('check--on', input.checked);
      saveDraft();
    });
  });

  dom.view.querySelector('#prev-btn')?.addEventListener('click', () => {
    state.itemIndex = Math.max(0, state.itemIndex - 1);
    state.error = null;
    saveDraft();
    render();
  });

  dom.view.querySelector('#next-btn')?.addEventListener('click', () => {
    state.itemIndex = Math.min(total - 1, state.itemIndex + 1);
    state.error = null;
    saveDraft();
    render();
  });

  dom.view.querySelector('#skip-btn')?.addEventListener('click', () => {
    const list = skippedOf(dimension);
    const at = list.indexOf(item.id);
    if (at !== -1) {
      // 取消跳过：回到正常作答状态
      list.splice(at, 1);
      state.skipped[dimension] = list;
      state.error = null;
      saveDraft();
      render();
      return;
    }
    list.push(item.id);
    state.skipped[dimension] = list;
    const current = answersOf(dimension);
    current[item.id] = { text: '', checked: (current[item.id] || {}).checked || [] };
    state.error = null;
    saveDraft();
    if (state.itemIndex < total - 1) {
      state.itemIndex += 1;
      saveDraft();
    }
    render();
  });

  dom.view.querySelector('#submit-dim-btn')?.addEventListener('click', submitDimension);
}

function renderGenerating() {
  dom.view.innerHTML = buildGeneratingView({
    statusStrip: currentStatusStrip(),
    errorBanner: currentErrorBanner(),
    error: state.error,
  });
  bindRetryButtons();
}

function renderFinal() {
  dom.view.innerHTML = buildFinalView({
    final: state.final,
    itemBank: bank,
    dimensionResults: state.results,
    error: state.error,
    errorBanner: currentErrorBanner(),
  });

  bindRetryButtons();

  dom.view.querySelector('#print-btn')?.addEventListener('click', () => window.print());
  dom.view.querySelector('#re-finalize-btn')?.addEventListener('click', () => {
    refinalize();
  });
  bindRestart(dom.view.querySelector('#restart-btn-2'));
}

function renderProgress() {
  if (state.stage === 'start') {
    dom.progressLabel.textContent = state.results.length ? `已有 ${state.results.length} 个维度结果` : '';
    dom.restartBtn.hidden = true;
    return;
  }
  dom.restartBtn.hidden = false;
  if (state.stage === 'quiz') {
    dom.progressLabel.textContent = `维度 ${state.dimIndex + 1} / 4 · 第 ${state.itemIndex + 1} 题`;
  } else if (state.stage === 'generating') {
    dom.progressLabel.textContent = '正在生成画像';
  } else {
    dom.progressLabel.textContent = '画像完成';
  }
}

export function render() {
  if (!bank) {
    dom.view.innerHTML = '<p class="small">正在载入题库…</p>';
    return;
  }
  renderProgress();

  if (state.busy) {
    dom.view.innerHTML = `
      <div class="sheet sheet--tight" style="text-align:center;padding:56px 24px">
        <p><span class="spinner"></span>正在合成类型与人物小传…</p>
        <p class="small">这一步会再调用一次本账号 API，通常需要十几秒。</p>
      </div>`;
    return;
  }

  if (state.stage === 'start') renderStart();
  else if (state.stage === 'quiz') renderQuiz();
  else if (state.stage === 'generating') renderGenerating();
  else if (state.stage === 'final') renderFinal();
}

async function boot() {
  dom = {
    view: document.getElementById('view'),
    progressLabel: document.getElementById('progress-label'),
    restartBtn: document.getElementById('restart-btn'),
  };

  bindRestart(dom.restartBtn);

  try {
    const [bankResponse, healthResponse] = await Promise.all([
      // 相对路径：GitHub Pages 挂在 /<repo>/ 子路径下，绝对路径会 404
      fetch('items.json'),
      fetch('api/health').catch(() => null),
    ]);
    if (bankResponse.ok) bank = await bankResponse.json();
    if (healthResponse && healthResponse.ok) health = await healthResponse.json();
  } catch (err) {
    console.warn('初始化失败', err);
  }
  loadDraft();
  normalizeState();

  // 报告顶部的大字母必须与逐维判型结论一致。
  // 服务端换过版本后，草稿里可能还留着旧算法生成的报告，
  // 于是"大字母"和"四维读数"会对不上。这里自动重新合成一次，
  // 用户刷新页面就能拿到一致的结果，不必手动重答。
  if (state.stage === 'final' && state.final && state.results.length === DIM_ORDER.length) {
    const expected = expectedTypeFrom(state.results);
    if (expected && expected !== state.final.type) {
      state.stage = 'generating';
    }
  }

  render();

  // 刷新后若有待补的判型，自动继续。
  if (state.stage === 'generating') maybeFinalize();
}

if (typeof document !== 'undefined' && document.getElementById('view')) {
  boot();
}
