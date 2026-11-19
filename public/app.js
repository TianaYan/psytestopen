/* 开放题版人格测评 —— 前端状态机与渲染。
 *
 * 交互流程：填完一维 → 点提交 → 立即跳到下一维作答，本维判型在后台并行计算；
 *          所有维都提交后进入汇总页，一次性展示倾向字母、各维结果、证据、小传与引证表。
 *
 * 运行模式：**一律浏览器直连**，访客自带 API Key。
 * 无论页面是从本机服务打开、还是从 GitHub Pages 打开，行为完全一致——
 * 密钥只存在访客自己的浏览器里，页面与仓库都不含任何凭据。
 *
 * 套件化：题库、维度、透镜都随套件走（public/suites/<id>.json），
 * 引擎（public/lib/）对所有套件共用；新增测试 = 加一个套件文件。
 *
 * 视图构造器（build*View）是纯函数：只依赖入参、只返回 HTML 字符串，
 * 因此可以在 Node 里直接 import 做回归测试（见 test/views.test.mjs）。
 */

import { scoreDimension, finalizeReport } from './lib/pipeline.js';
import { createLlmClient } from './lib/llm.js';

const DRAFT_KEY = 'mbti-open-draft';
const KEY_STORE = 'mbti-open-api-key';
const CFG_STORE = 'mbti-open-api-cfg';

/** 站点默认标题。必须与 public/index.html 里的 <title> 一致（测试会断言）。 */
export const DEFAULT_TITLE = '开放题版人格测评 · 行为叙述';

/** 文件名里不能用的字符：Windows 与 Chrome 的「另存为 PDF」都会拒绝或替换它们。 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * 打印 / 另存为 PDF 的**默认文件名取自 document.title**，
 * 所以不同测试必须给出不同的标题——否则四套报告会存成同一个名字。
 *
 * 报告页用「套件名 · 倾向画像」，作答页用「套件名 · 作答中」，
 * 开始页用站点默认标题。
 */
export function documentTitleFor(suite, stage = 'start') {
  const raw = suite && suite.name ? String(suite.name) : '';
  const name = raw.replace(ILLEGAL_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return DEFAULT_TITLE;
  if (stage === 'final') return `${name} · 倾向画像`;
  if (stage === 'start') return DEFAULT_TITLE;
  return `${name} · 作答中`;
}

/** 把上面的标题写进 document.title（浏览器环境才有 document）。 */
function applyDocumentTitle(stage) {
  if (typeof document === 'undefined') return;
  document.title = documentTitleFor(state.suite, stage);
}

/* ---------- 运行模式 ---------- */

const DEFAULT_API_CFG = {
  baseURL: 'https://api.minimaxi.com/v1',
  model: 'MiniMax-M2.7',
  protocol: 'openai',
};

/**
 * 判型链路：**一律浏览器直连**，访客自带 API Key。
 *
 * 无论页面是从本机服务打开、还是从 GitHub Pages 打开，行为完全一致——
 * 密钥只存在访客自己的浏览器里，页面与仓库都不含任何凭据。
 */
export const TRANSPORT = 'direct';

/** 直连模式下的接口配置，允许访客覆盖端点与模型。 */
function loadApiCfg() {
  let extra = {};
  try {
    extra = JSON.parse(localStorage.getItem(CFG_STORE) || '{}') || {};
  } catch {
    extra = {};
  }
  return { ...DEFAULT_API_CFG, ...extra };
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
    throw new Error('还没有填写 API Key。静态部署版需要你自己的 MiniMax API Key。');
  }
  const cfg = { ...loadApiCfg(), apiKey: key, keyConfigured: true };
  return createLlmClient(cfg);
}


/* ---------- 套件（测试）---------- */

/** 当前套件的维度列表；未载入时为空。 */
export function currentDimensions() {
  return (state.suite && state.suite.dimensions) || [];
}

/** 当前套件的维度 key 顺序。 */
export function dimKeys() {
  return currentDimensions().map((d) => d.key);
}

/** 某个维度的元信息（label / poles / 透镜）。 */
export function dimMeta(key) {
  return currentDimensions().find((d) => d.key === key) || null;
}

/** 维度的人类可读名。 */
export function dimLabel(key) {
  const meta = dimMeta(key);
  return meta ? meta.label : key;
}

/** 维度两极的可读名（[极A, 极B]）。 */
export function dimPoleLabels(key) {
  const meta = dimMeta(key);
  return (meta && meta.poleLabels) || [];
}

export const state = {
  stage: 'start',      // start | quiz | generating | final
  dimIndex: 0,
  itemIndex: 0,
  mode: 'full',        // full（每维 6 题）| quick（每维 4 题，只取 core 层）
  suiteId: 'mbti',     // 当前选中的测试套件
  suite: null,         // 载入的套件（题库 + 维度 + 透镜）
  suiteIndex: [],      // 可选套件目录
  answers: {},         // dimension -> { itemId: { text, checked[] } }
  skipped: {},         // dimension -> [itemId]（受测者主动跳过的题）
  results: [],         // 已完成的维度判型结果
  pending: {},         // dimension -> true（后台计算中）
  errors: {},          // dimension -> 错误信息
  final: null,
  busy: false,
  error: null,
};

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
  return dimKeys()[state.dimIndex] || dimKeys()[0];
}

function itemsOf(dimension) {
  if (!state.suite) return [];
  const list = state.suite.items.filter((item) => item.dimension === dimension);
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
      suiteId: state.suiteId,
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
      suiteId: parsed.suiteId || 'mbti',
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
    else if (state.results.length >= dimKeys().length) state.stage = 'generating';
    else state.stage = state.results.length ? 'quiz' : 'start';
  }

  if (state.stage === 'quiz') {
    const nextMissing = dimKeys().findIndex((d) => !state.results.some((r) => r.dimension === d));
    if (nextMissing !== -1 && nextMissing !== state.dimIndex) {
      state.dimIndex = nextMissing;
      state.itemIndex = 0;
    }
    // 题数随版本变化（完整版 6 题 / 快速版 4 题），别让游标落在范围外
    const total = itemsOf(dimKeys()[state.dimIndex]).length;
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
export function expectedTypeFrom(results, dimensions = []) {
  const letters = dimensions.map((d) => {
    const key = d.key;
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
 * 组装单维判型的调用参数（纯函数，不含 client）。
 *
 * 透镜（dimensionMeta.lens）与本题维题目必须一起交给 pipeline：
 * 漏传 dimensionMeta 会在运行时抛"维度缺少透镜定义"，四维全灭。
 * 抽成纯函数是为了让这类漏参能在离线测试里被直接断言（见 test/suites.test.mjs）。
 */
export function scoreCallArgs(dimension, answers = [], skipped = []) {
  return {
    dimension,
    dimensionMeta: dimMeta(dimension),
    answers,
    skipped,
    items: itemsOf(dimension),
  };
}

/**
 * 组装汇总合成的调用参数（纯函数）。
 * dimensions 决定计分轴、类型字母的拼法与引文校验口径，必须随套件走。
 */
export function finalizeCallArgs(dimensionResults = []) {
  return {
    dimensionResults,
    dimensions: currentDimensions(),
  };
}

/**
 * 单维判型：浏览器直连模型 API，访客自带 Key。
 * 与服务端共用 public/lib/pipeline.js 的判型实现，结果口径一致。
 */
async function requestScore(dimension, answers, skipped = []) {
  return scoreDimension({
    ...scoreCallArgs(dimension, answers, skipped),
    client: directClient(),
  });
}

/** 合成最终画像。同样浏览器直连。 */
async function requestFinalize(dimensionResults) {
  return finalizeReport({
    ...finalizeCallArgs(dimensionResults),
    client: directClient(),
    onNote: (message) => console.info('[mbti-open]', message),
  });
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

export function buildStatusStrip({
  results = [], pending = {}, errors = {}, dimIndex = 0, dimensions = [],
} = {}) {
  const items = dimensions.map((d, index) => {
    const dimension = d.key;
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
 * 静态部署版的密钥面板。
 * 只有 direct 模式（纯静态托管）才需要——那时没有后端替访客保管密钥。
 */
export function buildKeyPanel({ hasKey = false, endpoint = '', model = '' } = {}) {
  return `
    <div class="key-panel">
      <h2 class="key-panel__title">这个页面需要你自己的 API Key</h2>
      <p class="small">
        判型请求由<b>你的浏览器</b>直接发往 <code>${esc(endpoint)}</code>（模型 ${esc(model)}）。
        Key 只保存在这台设备上（浏览器 localStorage）——页面、代码仓库和 GitHub 上都没有密钥，
        仓库里也不存在任何凭据。
      </p>
      <div class="key-panel__row">
        <input type="password" id="api-key-input" class="key-input" autocomplete="off" spellcheck="false"
               placeholder="${esc(hasKey ? '已保存一个 Key，可在此处更换' : '粘贴你的 MiniMax API Key（sk-…）')}">
        <button type="button" class="btn btn--primary" id="api-key-save">${hasKey ? '更换' : '保存'}</button>
        ${hasKey ? '<button type="button" class="btn btn--ghost" id="api-key-clear">清除</button>' : ''}
      </div>
      <p class="small" id="api-key-hint">${hasKey
        ? '已保存一个 Key，可以直接开始作答。'
        : '尚未填写。填好之后才能开始作答。'}</p>
      <p class="small">
        没有 Key？可以在 minimaxi.com 申请；也可以把仓库克隆到本机执行 <code>npm start</code>，
        用本机服务端运行——那时密钥由服务端从本机配置读取，不用手填。
      </p>
    </div>`;
}

/**
 * 开始页：先是**测试入口列表**（选一个测什么），再是当前测试的版本与密钥设置。
 */
/**
 * 入口卡片的题量说明。
 * 只用 index.json 里的真实计数（维度数 / 题数 / core 题数）拼出来，
 * 不接受手写字符串——手写的数字一旦和套件文件脱节，页面就会说谎。
 */
export function suiteCardMeta(entry) {
  const dims = Number(entry?.dimensionCount) || 0;
  const items = Number(entry?.itemCount) || 0;
  const core = Number(entry?.coreItemCount) || 0;
  if (!dims || !items) return String(entry?.meta || '');
  return `${dims} 维 · ${items} 题（快速版 ${core} 题）`;
}

export function buildStartView({
  suite: itemSuite, suiteIndex = [], selectedId = '', health: itemHealth,
  resultCount = 0, keyPanel = '', direct = false,
  mode = 'full', modeSelectable = true,
} = {}) {
  const healthLine = direct
    ? `<span class="small">浏览器直连模式 · 判型请求由你的浏览器直接发往 API · 密钥只存在你的浏览器里</span>`
    : itemHealth
      ? (itemHealth.keyConfigured
        ? `<span class="small">服务端已就绪 · 模型 ${esc(itemHealth.model)} · 端点 ${esc(itemHealth.endpointHost)} · 密钥由服务端保管，你无需填写</span>`
        : `<span class="small" style="color:var(--warn-ink)">服务端未找到可用凭证，判型会失败：${esc(itemHealth.model || '模型未配置')}</span>`)
      : '<span class="small">正在检查服务状态…</span>';

  const allItems = itemSuite ? itemSuite.items : [];
  const coreItems = allItems.filter((i) => i.tier === 'core');
  const isQuick = mode === 'quick';
  const dims = itemSuite ? itemSuite.dimensions.length : 0;
  // 两个版本的每维题量必须各自独立算，不能跟着"当前选中的是哪个版本"走：
  // 否则完整版会用完整版的题数去渲染快速版卡片，显示成"每维 8 题"这类错数。
  const perDimensionCore = dims ? Math.round(coreItems.length / dims) : 0;
  const perDimensionFull = dims ? Math.round(allItems.length / dims) : 0;
  const perDimension = isQuick ? perDimensionCore : perDimensionFull;
  const extraPerDimension = Math.max(0, perDimensionFull - perDimensionCore);
  const total = isQuick ? coreItems.length : allItems.length;
  const count = allItems.length;

  // 测试入口列表
  const entryPanel = suiteIndex.length
    ? `<div class="suite-panel">
        <h2 class="suite-panel__title">选一个测什么</h2>
        <div class="suite-panel__row">
          ${suiteIndex.map((entry) => `
            <button type="button" class="suite-card${entry.id === selectedId ? ' suite-card--on' : ''}"
                    data-suite="${esc(entry.id)}">
              <span class="suite-card__title">${esc(entry.name)}</span>
              <span class="suite-card__meta">${esc(suiteCardMeta(entry))}</span>
              <span class="suite-card__note">${esc(entry.tagline || '')}</span>
            </button>`).join('')}
        </div>
      </div>`
    : '';

  const suiteIntro = itemSuite
    ? `<div class="notice notice--calm">
        <b>${esc(itemSuite.name)}</b> — ${esc(itemSuite.intro || '')}
      </div>`
    : '';

  const modePanel = modeSelectable
    ? `<div class="mode-panel">
        <h2 class="mode-panel__title">这次想花多少时间？</h2>
        <p class="small">
          两个版本问的是同一批题目，只是数量不同：快速版每个维度只问信号最干净的 ${perDimensionCore} 题，
          完整版每维 ${perDimensionFull} 题、覆盖的行为侧面更全。哪个维度写不出来都可以<b>跳过</b>，
          跳过的题会在报告里如实记成证据缺口，而不是悄悄消失。
        </p>
        <div class="mode-panel__row">
          <button type="button" class="mode-card${isQuick ? '' : ' mode-card--on'}" data-mode="full">
            <span class="mode-card__title">完整版</span>
            <span class="mode-card__meta">每维 ${perDimensionFull} 题 · 共 ${count} 题</span>
            <span class="mode-card__note">证据最厚，反向证据最容易浮出来</span>
          </button>
          <button type="button" class="mode-card${isQuick ? ' mode-card--on' : ''}" data-mode="quick">
            <span class="mode-card__title">快速版</span>
            <span class="mode-card__meta">每维 ${perDimensionCore} 题 · 共 ${coreItems.length} 题</span>
            <span class="mode-card__note">省三分之一时间，每维少 ${extraPerDimension} 个行为侧面</span>
          </button>
        </div>
      </div>`
    : `<p class="small">本次为${isQuick ? `快速版（每维 ${perDimensionCore} 题）` : `完整版（每维 ${perDimensionFull} 题）`}。想换版本请点右上角"重新开始"。</p>`;

  const dimNames = itemSuite ? itemSuite.dimensions.map((d) => d.key).join('、') : '';

  return `
    <p class="kicker">开放题式人格测评</p>
    <h1>把选择题换成你自己写的场景</h1>
    <p class="lede">
      传统量表让你在若干选项里挑一个最像的。这一套测试反过来：每一题给你一个情境框定，
      你写下自己在类似情境下<b>可能产生的行为与想法</b>。模型读的是你的原话，
      按量表原有的维度框架给出倾向、置信度和一份能追溯到原句的人物小传。
    </p>

    <div class="section-rule"></div>

    ${entryPanel}

    ${suiteIntro}

    <ul class="fact-list">
      <li><span class="k">题量</span><span>${isQuick ? '快速版' : '完整版'}共 ${total} 道开放情境题，分 ${dims} 组，每组 ${perDimension} 题，对应 ${esc(dimNames)} 几个维度。</span></li>
      <li><span class="k">节奏</span><span>每组约 ${isQuick ? '2–3' : '3–5'} 分钟。提交一组后立刻进入下一组，上一组的判型在后台并行计算。</span></li>
      <li><span class="k">证据</span><span>画像里的每一条判断都必须引用你的原话；引文对不上的会被丢弃，该维置信度随之下调。</span></li>
      <li><span class="k">产出</span><span>各维读数与全部证据、倾向类型、可回查的引证表，以及一份逐段带引文的人物小传。</span></li>
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
  const alt = dimKeys().indexOf(dimension) % 2 === 1;
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
      <span class="small">${esc(dimLabel(dimension))} · 第 ${itemIndex + 1} / ${total} 题</span>
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

export function buildGeneratingView({ statusStrip = '', errorBanner = '', error = null, dimensionCount = 0 } = {}) {
  const dims = dimensionCount > 0 ? dimensionCount : 4;
  return `
    ${statusStrip}
    ${errorBanner}

    <p class="kicker">生成中</p>
    <h1>正在收束${dims}个维度的判型结果</h1>
    <p class="lede">
      每个维度的判型在后台独立进行，互不阻塞。${dims}个维度的结果齐备后会自动合成倾向读数与人物小传。
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
  final, suite: suiteData = null, dimensionResults = [], error = null, errorBanner = '',
} = {}) {
  if (!final) {
    return `${errorBanner}<div class="notice">还没有生成最终画像。</div>`;
  }

  const letters = String(final.type || '').split('');
  const suiteKeys = (suiteData?.dimensions || []).map((d) => d.key);

  const metaOf = (key) => (suiteData?.dimensions || []).find((d) => d.key === key) || null;
  const poleOf = (key) => {
    const meta = metaOf(key);
    return meta ? meta.poles : [];
  };
  /** 某个极的可读名。 */
  const poleNameOf = (key, letter) => {
    const meta = metaOf(key);
    if (!meta) return '';
    const labels = meta.poleLabels || [];
    const at = (meta.poles || []).indexOf(letter);
    return at === -1 ? '' : (labels[at] || '');
  };
  const scoredOf = (key) => (dimensionResults || []).find((r) => r.dimension === key);

  // 单维判型阶段判定为"证据不足"的维度，类型字母仍可能由汇总阶段微弱裁决给出，
  // 因此在字母下方直接标注，避免读者以为该维度证据充分。
  const typeHTML = letters.length
    ? `<div class="type-display">${letters.map((letter, index) => {
      const key = suiteKeys[index] || '';
      const scored = scoredOf(key);
      const flag = scored && scored.lean === 'ambiguous'
        ? `<span class="type-letter__flag">该维度证据不足</span>`
        : '';
      return `
        <div class="type-letter">
          ${esc(letter)}
          <span class="type-letter__pole">${esc(key)} ${esc(poleNameOf(key, letter))}</span>
          ${flag}
        </div>`;
    }).join('')}</div>`
    : '<div class="notice">未能确定各维倾向字母。</div>';

  const finalByDim = new Map((final.dimensions || []).map((d) => [d.dimension, d]));

  // 四维读数：以单维判型（引文已逐条校验）为主，汇总阶段读数作为补充。
  // 两阶段读数不一致时两个都列出来，而不是只显示其中一个。
  const dimRows = suiteKeys.map((key) => {
    const meta = metaOf(key);
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
       <h3>${suiteKeys.length}个维度的判型依据</h3>
       ${dimensionResults.map((result) => {
    const meta = metaOf(result.dimension);
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
  const expectedType = expectedTypeFrom(dimensionResults, suiteData?.dimensions || []);
  const inconsistent = Boolean(expectedType) && expectedType !== final.type;
  const inconsistentNotice = inconsistent
    ? `<div class="notice"><b>这份报告的字母与各维读数不一致。</b>
        逐维判型指向 ${esc(expectedType)}，而报告顶部写的是 ${esc(final.type)}——
        多半是服务端更新后留下的旧报告。点"重新合成报告"即可按当前判型结果重新生成。</div>`
    : '';

  return `
    ${errorBanner}
    ${inconsistentNotice}

    <p class="kicker">倾向画像</p>
    <h1>${esc(bio.title || '你的画像')}</h1>
    <p class="small">整体置信度 ${(Number(final.typeConfidence || 0) * 100).toFixed(0)}%</p>

    ${typeHTML}

    <div class="section-rule"></div>
    <h3>${suiteKeys.length}维读数</h3>
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
  state.results.sort((a, b) => dimKeys().indexOf(a.dimension) - dimKeys().indexOf(b.dimension));
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

  if (state.dimIndex < dimKeys().length - 1) {
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

  const missing = dimKeys().filter((d) => !state.results.some((r) => r.dimension === d));
  if (missing.length) {
    state.stage = 'quiz';
    state.dimIndex = dimKeys().indexOf(missing[0]);
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
  const missing = dimKeys().filter((d) => !state.results.some((r) => r.dimension === d));
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

/* ---------- 套件载入 ---------- */

/** 载入套件目录（开始页的测试入口列表）。 */
async function loadSuiteIndex() {
  try {
    const r = await fetch('suites/index.json', { cache: 'no-store' });
    if (r.ok) state.suiteIndex = await r.json();
  } catch (err) {
    console.warn('套件目录载入失败', err);
  }
}

/** 载入一个套件（题库 + 维度 + 透镜）。 */
async function selectSuite(id) {
  try {
    const r = await fetch(`suites/${id}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const suite = await r.json();
    state.suiteId = suite.id || id;
    state.suite = suite;
    return true;
  } catch (err) {
    state.error = `套件载入失败：${err.message}`;
    return false;
  }
}

/* ---------- 渲染与事件绑定 ---------- */

function currentStatusStrip() {
  return buildStatusStrip({
    results: state.results,
    pending: state.pending,
    errors: state.errors,
    dimIndex: state.dimIndex,
    dimensions: currentDimensions(),
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
  const keyPanel = buildKeyPanel({
    hasKey: Boolean(loadApiKey()),
    endpoint: apiCfg.baseURL,
    model: apiCfg.model,
  });
  dom.view.innerHTML = buildStartView({
    suite: state.suite,
    suiteIndex: state.suiteIndex,
    selectedId: state.suiteId,
    health,
    resultCount: state.results.length,
    keyPanel,
    direct: true,
    mode: state.mode,
    modeSelectable: state.results.length === 0 && !state.final,
  });

  dom.view.querySelectorAll('[data-suite]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.suite;
      if (!id || id === state.suiteId) return;
      const ok = await selectSuite(id);
      if (!ok) return;
      state.answers = {};
      state.skipped = {};
      state.results = [];
      state.errors = {};
      state.pending = {};
      state.final = null;
      state.dimIndex = 0;
      state.itemIndex = 0;
      state.error = null;
      saveDraft();
      render();
    });
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

  dom.view.querySelector('#api-key-save')?.addEventListener('click', () => {
    const input = dom.view.querySelector('#api-key-input');
    const value = String(input?.value || '').trim();
    if (!value) {
      state.error = '请先粘贴一个 API Key。';
      render();
      return;
    }
    saveApiKey(value);
    state.error = null;
    render();
  });

  dom.view.querySelector('#api-key-clear')?.addEventListener('click', () => {
    saveApiKey('');
    state.error = null;
    render();
  });

  dom.view.querySelector('#start-btn')?.addEventListener('click', () => {
    if (!loadApiKey()) {
      state.error = '这个页面需要你自己的 API Key：先在上面填一个，再开始作答。';
      render();
      return;
    }
    state.stage = 'quiz';
    state.error = null;
    saveDraft();
    render();
  });

  dom.view.querySelector('#resume-btn')?.addEventListener('click', () => {
    state.stage = state.final ? 'final' : (state.results.length === dimKeys().length ? 'generating' : 'quiz');
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
    isLastDimension: state.dimIndex >= dimKeys().length - 1,
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
    dimensionCount: dimKeys().length,
  });
  bindRetryButtons();
}

function renderFinal() {
  dom.view.innerHTML = buildFinalView({
    final: state.final,
    suite: state.suite,
    dimensionResults: state.results,
    error: state.error,
    errorBanner: currentErrorBanner(),
  });

  bindRetryButtons();

  dom.view.querySelector('#print-btn')?.addEventListener('click', () => {
    // 再设一次：保证打印对话框里的默认文件名就是这套测试的名字，
    // 而不是四套测试共用的站点标题。
    applyDocumentTitle('final');
    window.print();
  });
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
  if (!state.suite) {
    dom.view.innerHTML = '<p class="small">正在载入题库…</p>';
    return;
  }
  // 标题跟着套件走：打印 / 另存为 PDF 的默认文件名取自 document.title。
  applyDocumentTitle(state.stage);
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
    // 相对路径：GitHub Pages 挂在 /<repo>/ 子路径下，绝对路径会 404
    await loadSuiteIndex();
  } catch (err) {
    console.warn('初始化失败', err);
  }

  loadDraft();
  if (!state.suite || state.suite.id !== state.suiteId) {
    await selectSuite(state.suiteId || 'mbti');
  }
  normalizeState();

  // 报告顶部的大字母必须与逐维判型结论一致。
  // 服务端换过版本后，草稿里可能还留着旧算法生成的报告，
  // 于是"大字母"和"四维读数"会对不上。这里自动重新合成一次，
  // 用户刷新页面就能拿到一致的结果，不必手动重答。
  if (state.stage === 'final' && state.final && state.results.length === dimKeys().length) {
    const expected = expectedTypeFrom(state.results, currentDimensions());
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
