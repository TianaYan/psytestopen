/**
 * 前端视图构造器的离线测试。
 * app.js 的 build*View 是纯函数（只依赖入参、只返回 HTML），因此可直接在 Node 里断言。
 *
 * 运行：node --test test/views.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStartView,
  buildQuizView,
  buildGeneratingView,
  buildFinalView,
  buildStatusStrip,
  buildErrorBanner,
  buildDimensionDetail,
  normalizeState,
  readoutOf,
  expectedTypeFrom,
  coverageLine,
  state,
  esc,
} from '../public/app.js';

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const AMP = String.fromCharCode(38);
const QUOT = String.fromCharCode(34);
const SCRIPT_OPEN = LT + 'script' + GT;
const SCRIPT_CLOSE = LT + '/script' + GT;

const ITEM_BANK = {
  dimensions: [
    { key: 'E/I', label: '能量朝向', poles: ['E', 'I'] },
    { key: 'S/N', label: '信息摄取', poles: ['S', 'N'] },
    { key: 'T/F', label: '决策方式', poles: ['T', 'F'] },
    { key: 'J/P', label: '生活节奏', poles: ['J', 'P'] },
  ],
};

const DIMENSION_RESULT = {
  dimension: 'E/I',
  lean: 'I',
  score: 0.78,
  strength: 0.78,
  axis: { from: 'E', to: 'I' },
  confidence: 0.86,
  evidence: [
    { itemId: 'EI-02', quote: '带项目那段其实挺累的', signal: '推进后更想独处恢复', strength: 'weak' },
    { itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后仍想独处', strength: 'strong' },
  ],
  counterEvidence: [
    { itemId: 'EI-01', quote: '兴奋得睡不着', signal: '社交后仍兴奋', strength: 'strong' },
  ],
  misreadChecks: ['疲惫 ≠ I → 仅作弱证据'],
  missing: ['EI-06'],
  note: '测试说明',
  validation: { keptEvidence: 2, keptCounterEvidence: 1, dropped: [] },
};

const FINAL_RESULT = {
  type: 'ISFP',
  typeConfidence: 0.84,
  dimensions: [
    { dimension: 'E/I', lean: 'I', score: 0.78, strength: 0.78, axis: { from: 'E', to: 'I' }, confidence: 0.86, rationale: '「我更想谁也别见」' },
    { dimension: 'S/N', lean: 'S', score: 0.42, strength: 0.42, axis: { from: 'S', to: 'N' }, confidence: 0.84, rationale: '' },
    { dimension: 'T/F', lean: 'F', score: 0.62, strength: 0.62, axis: { from: 'T', to: 'F' }, confidence: 0.88, rationale: '' },
    { dimension: 'J/P', lean: 'P', score: 0.84, strength: 0.84, axis: { from: 'J', to: 'P' }, confidence: 0.9, rationale: '' },
  ],
  biography: {
    title: '在具体经验与关系感受之间保持弹性',
    paragraphs: [
      '你在「我更想谁也别见」这样的句子之后，通常选择一个人待着。',
      '证据薄弱的地方在于：「兴奋得睡不着」只出现过一次。',
      '「兴奋得睡不着」这句话重复出现了两次。',
    ],
    closing: '这是一份读数，不是结论。',
    degraded: false,
  },
  caveats: ['E/I 维度存在明确反向证据'],
  evidenceMap: [
    { dimension: 'E/I', itemId: 'EI-03', quote: '我更想谁也别见' },
    { dimension: 'E/I', itemId: 'EI-01', quote: '兴奋得睡不着' },
  ],
  validation: { evidenceMapCount: 2, paragraphCount: 3, invalidParagraphs: [], biographyValid: true },
};

/* ---------- 草稿状态迁移 ---------- */

test('normalizeState 迁移旧阶段并对齐到第一个未判型的维度', () => {
  const snapshot = JSON.parse(JSON.stringify(state));

  state.stage = 'dimensionResult';
  state.results = [DIMENSION_RESULT];
  state.final = null;
  state.dimIndex = 0;
  normalizeState();
  assert.equal(state.stage, 'quiz', '旧版 dimensionResult 阶段必须迁移');
  assert.equal(state.dimIndex, 1, '应跳到第一个没有判型结果的维度 S/N');

  state.stage = 'dimensionResult';
  state.results = [];
  normalizeState();
  assert.equal(state.stage, 'start');

  Object.assign(state, snapshot);
});

/* ---------- esc ---------- */

test('esc 转义 HTML 关键字符', () => {
  assert.equal(esc(SCRIPT_OPEN), AMP + 'lt;script' + AMP + 'gt;');
  assert.equal(esc('a ' + AMP + ' b'), 'a ' + AMP + 'amp; b');
  assert.equal(esc(QUOT + 'x' + QUOT), AMP + 'quot;x' + AMP + 'quot;');
});

/* ---------- 状态条与错误条 ---------- */

test('buildStatusStrip 标出各维度状态', () => {
  const html = buildStatusStrip({
    results: [DIMENSION_RESULT],
    pending: { 'S/N': true },
    errors: { 'T/F': '上游超时' },
    dimIndex: 3,
  });
  assert.match(html, /E\/I/);
  assert.match(html, /完成/);
  assert.match(html, /计算中/);
  assert.match(html, /失败/);
  assert.match(html, /作答中/);

  const idle = buildStatusStrip({ results: [], pending: {}, errors: {}, dimIndex: 0 });
  assert.match(idle, /待答/);
});

test('buildErrorBanner 无错误时不输出任何内容', () => {
  assert.equal(buildErrorBanner({ errors: {} }), '');
  const html = buildErrorBanner({ errors: { 'E/I': '网络请求失败' } });
  assert.match(html, /E\/I 判型失败/);
  assert.match(html, /网络请求失败/);
  assert.match(html, /data-retry-dim="E\/I"/);
});

/* ---------- 开始页 ---------- */

test('buildStartView 含开始入口与边界声明', () => {
  const html = buildStartView({
    bank: { items: new Array(24).fill({}) },
    health: { keyConfigured: true, model: 'MiniMax-M2.7', endpointHost: 'api.minimaxi.com' },
    resultCount: 0,
  });
  assert.match(html, /开始作答/);
  assert.match(html, /24 道开放情境题/);
  assert.match(html, /后台并行计算/);
  assert.match(html, /不是类型判定/);
  assert.match(html, /id="start-btn"/);
});

/* ---------- 作答屏 ---------- */

test('buildQuizView 非末维给"提交并继续下一维"', () => {
  const html = buildQuizView({
    dimension: 'E/I',
    item: { id: 'EI-01', prompt: '题干', writingGuide: '指引', minInfo: ['要素一'] },
    itemIndex: 5,
    total: 6,
    text: '作答内容',
    checked: [],
    isLastDimension: false,
    statusStrip: buildStatusStrip({}),
    errorBanner: '',
  });
  assert.match(html, /提交并继续下一维/);
  assert.ok(!html.includes('提交并生成画像'));
});

test('buildQuizView 末维给"提交并生成画像"', () => {
  const html = buildQuizView({
    dimension: 'J/P',
    item: { id: 'JP-01', prompt: '题干', writingGuide: '指引', minInfo: ['要素一'] },
    itemIndex: 5,
    total: 6,
    text: '',
    checked: [],
    isLastDimension: true,
    statusStrip: buildStatusStrip({}),
    errorBanner: '',
  });
  assert.match(html, /提交并生成画像/);
});

test('buildQuizView 输出题干、写作指引、自检项与已有作答', () => {
  const html = buildQuizView({
    dimension: 'E/I',
    item: {
      id: 'EI-01',
      prompt: '最近一次你参加的人比较多的场合，结束后回家路上你第一反应是什么？',
      writingGuide: '写真实的第一反应。',
      minInfo: ['具体是哪次场合', '回家路上的身体感受'],
    },
    itemIndex: 0,
    total: 6,
    text: '我上次年会散场还在车上回消息',
    checked: [true, false],
    error: null,
    statusStrip: buildStatusStrip({}),
    errorBanner: '',
  });
  assert.match(html, /本题关注维度 · E\/I/);
  assert.match(html, /第 1 \/ 6 题/);
  assert.match(html, /我上次年会散场还在车上回消息/);
  assert.match(html, /具体是哪次场合/);
  assert.match(html, /data-check="0" checked/);
  assert.match(html, /id="next-btn"/);
});

test('buildQuizView 透出错误信息', () => {
  const html = buildQuizView({
    dimension: 'J/P',
    item: { id: 'JP-01', prompt: '题干', writingGuide: '指引', minInfo: ['要素'] },
    itemIndex: 5,
    total: 6,
    text: '',
    checked: [],
    error: '本维度判型失败：连不上本机服务',
    statusStrip: buildStatusStrip({}),
    errorBanner: '',
  });
  assert.match(html, /本维度判型失败/);
});

/* ---------- 生成中 ---------- */

test('buildGeneratingView 说明后台并行并含状态条', () => {
  const html = buildGeneratingView({
    statusStrip: buildStatusStrip({ results: [DIMENSION_RESULT], pending: { 'S/N': true } }),
    errorBanner: '',
    error: null,
  });
  assert.match(html, /正在收束四个维度的判型结果/);
  assert.match(html, /后台独立进行/);
  assert.match(html, /dim-strip/);
  assert.match(html, /等待后台判型完成/);
});

/* ---------- 维度证据块 ---------- */

test('buildDimensionDetail 输出支撑、反向、易误读与缺口', () => {
  const html = buildDimensionDetail(DIMENSION_RESULT);
  assert.match(html, /带项目那段其实挺累的/);
  assert.match(html, /弱证据/);
  assert.match(html, /反向证据/);
  assert.match(html, /疲惫 ≠ I/);
  assert.match(html, /证据缺口/);
  assert.match(html, /EI-06/);
});

/* ---------- 最终报告 ---------- */

test('buildFinalView 输出类型字母、四维表、小传、引证表与边界声明', () => {
  const html = buildFinalView({
    final: FINAL_RESULT,
    itemBank: ITEM_BANK,
    dimensionResults: [DIMENSION_RESULT],
    error: null,
    errorBanner: '',
  });

  const start = html.indexOf('type-display');
  assert.ok(start > -1, '缺少类型展示区');
  const block = html.slice(start, start + 2000);
  const letters = [...block.matchAll(/class="type-letter">\s*([A-Z])\s*</g)].map((m) => m[1]);
  assert.deepEqual(letters, ['I', 'S', 'F', 'P']);

  assert.match(html, /整体置信度 84%/);
  assert.match(html, /四维读数/);
  assert.match(html, /往 I 偏/);
  assert.match(html, /在具体经验与关系感受之间保持弹性/);
  assert.match(html, /证据薄弱的地方在于/);
  assert.match(html, /引证表/);
  assert.match(html, /「我更想谁也别见」/);
  assert.match(html, /证据边界/);
  assert.match(html, /招聘筛选/);
  assert.match(html, /id="print-btn"/);
  assert.match(html, /id="re-finalize-btn"/, '报告页应提供不重答问卷就能重新合成的入口');
});

test('buildFinalView 汇总展示各维度的完整判型依据', () => {
  const html = buildFinalView({
    final: FINAL_RESULT,
    itemBank: ITEM_BANK,
    dimensionResults: [DIMENSION_RESULT],
    error: null,
    errorBanner: '',
  });
  assert.match(html, /四个维度的判型依据/);
  assert.match(html, /dim-block/);
  assert.match(html, /E\/I · 能量朝向/);
  assert.match(html, /轴 E → I/);
  assert.match(html, /带项目那段其实挺累的/);
  assert.match(html, /EI-06/);
});

test('buildFinalView 对用户内容做转义，不注入可执行标记', () => {
  const hostile = {
    ...FINAL_RESULT,
    biography: {
      ...FINAL_RESULT.biography,
      paragraphs: [SCRIPT_OPEN + 'alert(1)' + SCRIPT_CLOSE + ' 与「我更想谁也别见」'],
    },
  };
  const html = buildFinalView({ final: hostile, itemBank: ITEM_BANK, dimensionResults: [], error: null, errorBanner: '' });
  assert.ok(!html.includes(SCRIPT_OPEN + 'alert(1)'), '用户内容里的 script 标签必须被转义');
  assert.match(html, /alert\(1\)/);
});

test('buildFinalView 在小传降级时改用保守版并标注', () => {
  const degraded = {
    ...FINAL_RESULT,
    biography: {
      title: '本次作答的原话切片',
      paragraphs: ['E/I：你写道「我更想谁也别见」'],
      closing: '本次分析未生成叙述性小传（引文校验未通过）。',
      degraded: true,
    },
  };
  const html = buildFinalView({ final: degraded, itemBank: ITEM_BANK, dimensionResults: [], error: null, errorBanner: '' });
  assert.match(html, /本次分析未生成叙述性小传/);
  assert.match(html, /我更想谁也别见/);
  assert.ok(!html.includes('class="biography"'), '降级时不应渲染完整小传块');
});

test('buildFinalView 在没有结果时给出提示而不是抛错', () => {
  const html = buildFinalView({ final: null, itemBank: ITEM_BANK, dimensionResults: [], error: null, errorBanner: '' });
  assert.match(html, /还没有生成最终画像/);
});

/* ---------- 读数口径 ---------- */

test('readoutOf 把轴坐标换算成与倾向一致的强度', () => {
  // 倾向落在第二极：强度就是 score
  const second = readoutOf({ lean: 'I', score: 0.78, confidence: 0.86 }, ['E', 'I']);
  assert.equal(second.strength, 0.78);
  assert.equal(second.direction, 'I');

  // 倾向落在第一极：强度必须是 1 - score，否则会与"倾向"自相矛盾
  const first = readoutOf({ lean: 'S', score: 0.30, confidence: 0.82 }, ['S', 'N']);
  assert.equal(first.strength, 0.70);
  assert.equal(first.direction, 'S');

  // 定不出倾向：居中，不给方向
  const none = readoutOf({ lean: 'ambiguous', score: 0.5, confidence: 0.93 }, ['T', 'F']);
  assert.equal(none.strength, 0.5);
  assert.equal(none.direction, '');
});

test('buildFinalView 的强度与方向跟倾向对齐', () => {
  const html = buildFinalView({
    final: FINAL_RESULT,
    itemBank: ITEM_BANK,
    dimensionResults: [{
      ...DIMENSION_RESULT,
      dimension: 'S/N',
      lean: 'S',
      score: 0.3,
      strength: 0.3,
      axis: { from: 'S', to: 'N' },
      confidence: 0.82,
    }],
    error: null,
    errorBanner: '',
  });
  assert.match(html, /往 S 偏/);
  assert.ok(!html.includes('往 N 偏'), '倾向是 S 时不应显示"往 N 偏"');
  assert.match(html, /70%/);
});

test('buildFinalView 在两阶段读数不一致时把两个都列出来', () => {
  const ambiguousTF = {
    ...DIMENSION_RESULT,
    dimension: 'T/F',
    lean: 'ambiguous',
    score: 0.5,
    strength: 0.5,
    axis: { from: 'T', to: 'F' },
    confidence: 0.93,
  };
  const html = buildFinalView({
    final: {
      ...FINAL_RESULT,
      dimensions: [
        ...FINAL_RESULT.dimensions,
        { dimension: 'T/F', lean: 'T', score: 0.5, strength: 0.5, axis: { from: 'T', to: 'F' }, confidence: 0.52, rationale: '微弱裁决' },
      ],
    },
    itemBank: ITEM_BANK,
    dimensionResults: [DIMENSION_RESULT, ambiguousTF],
    error: null,
    errorBanner: '',
  });
  assert.match(html, /汇总阶段读作 T（置信度 52%），与单维判型不一致/);
  assert.match(html, /该维度证据不足/);
});

test('buildFinalView 不重复小传标题', () => {
  const html = buildFinalView({
    final: FINAL_RESULT,
    itemBank: ITEM_BANK,
    dimensionResults: [DIMENSION_RESULT],
    error: null,
    errorBanner: '',
  });
  assert.match(html, /<h1>在具体经验与关系感受之间保持弹性<\/h1>/);
  assert.match(html, /<h2>人物小传<\/h2>/);
  const occurrences = html.split('在具体经验与关系感受之间保持弹性').length - 1;
  assert.equal(occurrences, 1, '标题只应出现一次');
});

test('buildStartView 提供完整版与快速版选择', () => {
  const bank = {
    dimensions: ITEM_BANK.dimensions,
    items: [
      ...['E/I', 'S/N', 'T/F', 'J/P'].flatMap((d, dimIndex) => [0, 1, 2, 3, 4, 5].map((n) => ({
        id: `${d.split('/')[0]}-0${n + 1}`,
        dimension: d,
        tier: n < 4 ? 'core' : 'extended',
      }))),
    ],
  };
  const full = buildStartView({ bank, health: null, resultCount: 0, mode: 'full' });
  assert.match(full, /data-mode="full"/);
  assert.match(full, /data-mode="quick"/);
  assert.match(full, /每组 6 题/);
  assert.match(full, /共 24 题/);

  const quick = buildStartView({ bank, health: null, resultCount: 0, mode: 'quick' });
  assert.match(quick, /每组 4 题/);
  assert.match(quick, /共 16 题/);
});

test('buildStartView 已有作答时不提供版本切换', () => {
  const html = buildStartView({
    bank: { dimensions: ITEM_BANK.dimensions, items: [] },
    health: null,
    resultCount: 2,
    modeSelectable: false,
  });
  assert.ok(!html.includes('data-mode="quick"'), '已有进度时不应再让用户换版本');
  assert.match(html, /想换版本请点/);
});

test('buildQuizView 提供跳过入口与已跳过提示', () => {
  const html = buildQuizView({
    dimension: 'E/I',
    item: { id: 'EI-01', prompt: '题干', writingGuide: '指引', minInfo: ['要素一'] },
    itemIndex: 0,
    total: 4,
    text: '',
    checked: [],
    isLastDimension: false,
    error: null,
    statusStrip: '',
    errorBanner: '',
    skipped: false,
  });
  assert.match(html, /id="skip-btn"/);
  assert.match(html, /跳过这题/);

  const skippedHtml = buildQuizView({
    dimension: 'E/I',
    item: { id: 'EI-01', prompt: '题干', writingGuide: '指引', minInfo: ['要素一'] },
    itemIndex: 0,
    total: 4,
    text: '',
    checked: [],
    isLastDimension: false,
    error: null,
    statusStrip: '',
    errorBanner: '',
    skipped: true,
  });
  assert.match(skippedHtml, /本题已跳过/);
  assert.match(skippedHtml, /重新作答/);
});

test('coverageLine 披露实际作答条数与跳过的题号', () => {
  assert.match(
    coverageLine({ answeredCount: 4, skipped: ['EI-02', 'EI-06'] }),
    /实际作答 4 题.*跳过 2 题（EI-02、EI-06）/s,
  );
  assert.equal(coverageLine(null), '');
});

test('buildFinalView 在报告里说明跳过的题', () => {
  const html = buildFinalView({
    final: FINAL_RESULT,
    itemBank: ITEM_BANK,
    dimensionResults: [{
      ...DIMENSION_RESULT,
      answeredCount: 4,
      skipped: ['EI-06'],
    }],
    error: null,
    errorBanner: '',
  });
  assert.match(html, /实际作答 4 题/);
  assert.match(html, /EI-06/);
});

/* ---------- 报告与逐维结论是否同源 ---------- */

test('expectedTypeFrom 由逐维判型结果推出类型字母', () => {
  const results = [
    { dimension: 'E/I', lean: 'E' },
    { dimension: 'S/N', lean: 'N' },
    { dimension: 'T/F', lean: 'T' },
    { dimension: 'J/P', lean: 'J' },
  ];
  assert.equal(expectedTypeFrom(results), 'ENTJ');

  // 某一维还定不出倾向时，无法判断报告是否过期
  const partial = results.map((r) => (r.dimension === 'T/F' ? { ...r, lean: 'ambiguous' } : r));
  assert.equal(expectedTypeFrom(partial), '');
  assert.equal(expectedTypeFrom([]), '');
});

test('buildFinalView 标出大字母与四维读数不一致的旧报告', () => {
  const stale = { ...FINAL_RESULT, type: 'ESTJ' };
  const results = [
    { dimension: 'E/I', lean: 'E' },
    { dimension: 'S/N', lean: 'N' },
    { dimension: 'T/F', lean: 'T' },
    { dimension: 'J/P', lean: 'J' },
  ];
  const html = buildFinalView({
    final: stale,
    itemBank: ITEM_BANK,
    dimensionResults: results,
    error: null,
    errorBanner: '',
  });
  assert.match(html, /类型字母与四维读数不一致/);
  assert.match(html, /逐维判型指向 ENTJ/);
  assert.match(html, /id="re-finalize-btn"/);
});

test('buildFinalView 在报告与逐维结论一致时不给出告警', () => {
  const results = [
    { dimension: 'E/I', lean: 'I' },
    { dimension: 'S/N', lean: 'S' },
    { dimension: 'T/F', lean: 'F' },
    { dimension: 'J/P', lean: 'P' },
  ];
  const html = buildFinalView({
    final: { ...FINAL_RESULT, type: 'ISFP' },
    itemBank: ITEM_BANK,
    dimensionResults: results,
    error: null,
    errorBanner: '',
  });
  assert.ok(!html.includes('类型字母与四维读数不一致'), '一致的报告不应出现告警');
});
