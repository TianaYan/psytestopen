/**
 * 离线契约测试：不依赖真实 API，用固定 fixture + 假模型客户端。
 * 运行：node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createServer, envList, createRateLimiter, clientIp } from '../server.mjs';
import {
  normalizeText,
  quoteMatches,
  quoteTraceable,
  validateScore,
  validateFinalize,
  degradeBiography,
  extractQuotedFragments,
} from '../public/lib/validate.js';

const TEST_CONFIG = {
  apiKey: 'sk-unit-test-key',
  baseURL: 'https://example.invalid/v1',
  model: 'test-model',
  protocol: 'openai',
  keyConfigured: true,
  endpointHost: 'example.invalid',
  source: 'unit-test',
};

const FIXTURE_ANSWERS = [
  { itemId: 'EI-01', text: '上次年会散场，我在车上还想给同事回消息，兴奋得睡不着。' },
  { itemId: 'EI-02', text: '带项目那段其实挺累的，做完我只想一个人歇着。' },
  { itemId: 'EI-03', text: '一个人待了一整天之后，我更想谁也别见。' },
  { itemId: 'EI-04', text: '那天我在人群里一句话没说，心里空空的。' },
  { itemId: 'EI-05', text: '连着三天没跟人说话，我一点也不想出去。' },
  { itemId: 'EI-06', text: '讨论的时候基本都是别人在说。' },
];

/* ---------- 纯函数 ---------- */

test('normalizeText 统一全角标点与空白', () => {
  assert.equal(normalizeText('你好，世界'), '你好,世界');
  assert.equal(normalizeText('  多个   空格 '), '多个 空格');
  assert.equal(normalizeText('ab'), 'ab');
});

test('quoteMatches 只接受原文里的连续片段', () => {
  const text = '我在车上还想给同事回消息，兴奋得睡不着。';
  assert.equal(quoteMatches('兴奋得睡不着', text), true);
  assert.equal(quoteMatches('兴奋得睡不着', '完全不同的另一段作答内容'), false);
  assert.equal(quoteMatches('好', text), false, '过短的片段不构成证据');
});

test('validateScore 丢弃无法核对的引文并下调置信度', () => {
  const raw = {
    dimension: 'E/I',
    lean: 'I',
    score: 0.8,
    confidence: 0.9,
    evidence: [
      { itemId: 'EI-01', quote: '兴奋得睡不着', signal: '结束后仍兴奋', strength: 'strong' },
      { itemId: 'EI-01', quote: '今天天气不错', signal: '编造的引文', strength: 'strong' },
    ],
    counterEvidence: [],
    misreadChecks: ['话少不等于 I → 未命中'],
    missing: ['EI-06'],
    note: '测试',
  };

  const result = validateScore(raw, FIXTURE_ANSWERS);

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].quote, '兴奋得睡不着');
  assert.equal(result.validation.dropped.length, 1);
  assert.equal(result.validation.dropped[0].reason, 'quote-not-found');
  assert.ok(result.confidence < 0.9, '丢掉引文后置信度必须下调');
  assert.equal(result.lean, 'I');
});

test('validateScore 按 lean 校正打分方向，score 恒为 0=第一极、1=第二极', () => {
  // 模型若采用相反的轴约定（此处把 I 记作 0），必须被校正。
  const raw = {
    dimension: 'E/I',
    lean: 'I',
    score: 0.18,
    confidence: 0.9,
    evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '', strength: 'strong' }],
  };
  const result = validateScore(raw, FIXTURE_ANSWERS, { poles: ['E', 'I'] });
  assert.equal(result.lean, 'I');
  assert.ok(result.strength > 0.5, 'I 倾向的强度必须大于 0.5');
  assert.equal(result.axis.from, 'E');
  assert.equal(result.axis.to, 'I');
});

test('validateScore 方向已一致时不翻转', () => {
  // 规范轴是 0=E → 1=I；lean='E' 时 score 应小于 0.5。
  const raw = {
    dimension: 'E/I',
    lean: 'E',
    score: 0.25,
    confidence: 0.8,
    evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }],
  };
  const result = validateScore(raw, FIXTURE_ANSWERS, { poles: ['E', 'I'] });
  assert.equal(result.strength, 0.25);
});

test('validateScore 证据全空时判为 ambiguous 并压低置信度', () => {
  const raw = {
    dimension: 'E/I',
    lean: 'E',
    score: 0.9,
    confidence: 0.8,
    evidence: [{ itemId: 'EI-01', quote: '完全不存在于原文的片段', signal: '', strength: 'strong' }],
  };
  const result = validateScore(raw, FIXTURE_ANSWERS);
  assert.equal(result.lean, 'ambiguous');
  assert.equal(result.score, 0.5);
  assert.ok(result.confidence <= 0.35);
});

test('validateScore 全部为弱证据时置信度不高于 0.45', () => {
  const raw = {
    dimension: 'E/I',
    lean: 'I',
    score: 0.6,
    confidence: 0.9,
    evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '', strength: 'weak' }],
  };
  const result = validateScore(raw, FIXTURE_ANSWERS);
  assert.ok(result.confidence <= 0.45);
});

test('validateFinalize 过滤引证表并标记无效小传段落', () => {
  const dimensionResults = [{
    dimension: 'E/I',
    evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }],
    counterEvidence: [],
  }];

  const raw = {
    type: 'INTJ',
    typeConfidence: 0.7,
    dimensions: [{ dimension: 'E/I', lean: 'I', score: 0.8, confidence: 0.6, rationale: '「兴奋得睡不着」' }],
    biography: {
      title: '测试',
      paragraphs: [
        '你写下「兴奋得睡不着」，说明你在人群里是被充电的。',
        '这段话没有任何可溯源的引文支撑。',
      ],
      closing: '结束',
    },
    caveats: ['证据有限'],
    evidenceMap: [
      { dimension: 'E/I', itemId: 'EI-01', quote: '兴奋得睡不着' },
      { dimension: 'E/I', itemId: 'EI-01', quote: '根本没出现过的引文' },
    ],
  };

  const result = validateFinalize(raw, dimensionResults);

  assert.equal(result.type, 'INTJ');
  assert.equal(result.evidenceMap.length, 1, '未在维度结果里出现过的引文必须被剔除');
  assert.deepEqual(result.validation.invalidParagraphs, [1]);
  assert.equal(result.validation.biographyValid, false);
});

test('validateFinalize 用逐维倾向拼类型，不采信模型写错的 type', () => {
  // 实测事故：模型逐维给出 E/N/T/J，type 字段却写成 ESTJ。
  // 直接展示 type 会让大字母和同一页的四维读数自相矛盾。
  const dimensionResults = [
    { dimension: 'E/I', lean: 'E', score: 0.88, evidence: [], counterEvidence: [] },
    { dimension: 'S/N', lean: 'N', score: 0.64, evidence: [], counterEvidence: [] },
    { dimension: 'T/F', lean: 'T', score: 0.63, evidence: [], counterEvidence: [] },
    { dimension: 'J/P', lean: 'J', score: 0.70, evidence: [], counterEvidence: [] },
  ];

  const raw = {
    type: 'ESTJ',
    typeConfidence: 0.79,
    dimensions: [
      { dimension: 'E/I', lean: 'E', score: 0.88, confidence: 0.76, rationale: '' },
      { dimension: 'S/N', lean: 'N', score: 0.64, confidence: 0.85, rationale: '' },
      { dimension: 'T/F', lean: 'T', score: 0.63, confidence: 0.78, rationale: '' },
      { dimension: 'J/P', lean: 'J', score: 0.70, confidence: 0.78, rationale: '' },
    ],
    biography: { title: '测试', paragraphs: ['你写下「兴奋得睡不着」。'], closing: '' },
    caveats: [],
    evidenceMap: [],
  };

  const result = validateFinalize(raw, dimensionResults);

  assert.equal(result.type, 'ENTJ', '类型必须由逐维倾向拼出');
  assert.deepEqual(result.typeLetters, ['E', 'N', 'T', 'J']);
  assert.equal(result.validation.modelType, 'ESTJ', '应保留模型原始写法以便排查');
  assert.equal(result.validation.typeMismatch, true);
});

test('validateFinalize 单维判型的 ambiguous 会让位给汇总阶段的裁决', () => {
  const dimensionResults = [
    { dimension: 'E/I', lean: 'E', score: 0.8, evidence: [], counterEvidence: [] },
    { dimension: 'S/N', lean: 'N', score: 0.6, evidence: [], counterEvidence: [] },
    { dimension: 'T/F', lean: 'ambiguous', score: 0.5, evidence: [], counterEvidence: [] },
    { dimension: 'J/P', lean: 'J', score: 0.7, evidence: [], counterEvidence: [] },
  ];

  const raw = {
    type: 'ENFJ',
    typeConfidence: 0.8,
    dimensions: [
      { dimension: 'E/I', lean: 'E', score: 0.8, confidence: 0.7, rationale: '' },
      { dimension: 'S/N', lean: 'N', score: 0.6, confidence: 0.7, rationale: '' },
      { dimension: 'T/F', lean: 'F', score: 0.55, confidence: 0.5, rationale: '微弱裁决' },
      { dimension: 'J/P', lean: 'J', score: 0.7, confidence: 0.7, rationale: '' },
    ],
    biography: { title: '测试', paragraphs: ['你写下「兴奋得睡不着」。'], closing: '' },
    caveats: [],
    evidenceMap: [],
  };

  const result = validateFinalize(raw, dimensionResults);

  assert.equal(result.type, 'ENFJ');
  assert.equal(result.typeLetters[2], 'F', '上游定不出时，采纳汇总阶段的裁决');
  assert.equal(result.validation.typeLetterSources[2], 'finalize');
  assert.deepEqual(result.validation.typeLetterSources, ['upstream', 'upstream', 'finalize', 'upstream']);
  assert.equal(result.validation.typeMismatch, false);
});

test('extractQuotedFragments 能取出多种引号包裹的片段', () => {
  const fragments = extractQuotedFragments('他说「甲」又说"乙"，还有「丙」。');
  assert.deepEqual(fragments, ['甲', '乙', '丙']);
});

test('quoteTraceable 接受已校验引文的连续片段，拒绝改写与杜撰', () => {
  const quotes = [normalizeText('一个人待了一整天之后，我更想谁也别见。')];

  // 完全一致
  assert.equal(quoteTraceable('一个人待了一整天之后，我更想谁也别见。', quotes), true);
  // 模型把句号包进引号内
  assert.equal(quoteTraceable('一个人待了一整天之后，我更想谁也别见', quotes), true);
  // 只引长句中的一段
  assert.equal(quoteTraceable('我更想谁也别见', quotes), true);
  // 改写
  assert.equal(quoteTraceable('一个人待了一整天之后，我谁都不想见', quotes), false);
  // 杜撰
  assert.equal(quoteTraceable('其实我那天特别想去热闹的地方', quotes), false);
  // 过短的敷衍片段
  assert.equal(quoteTraceable('谁也别', quotes), false);
});

test('validateFinalize 小传段落里的引文只引一段也算可溯源', () => {
  const dimensionResults = [{
    dimension: 'E/I',
    evidence: [{ itemId: 'EI-03', quote: '一个人待了一整天之后，我更想谁也别见。', signal: '', strength: 'strong' }],
    counterEvidence: [],
  }];

  const raw = {
    type: 'ISTJ',
    typeConfidence: 0.6,
    dimensions: [{ dimension: 'E/I', lean: 'I', score: 0.7, confidence: 0.6, rationale: '' }],
    biography: {
      title: '测试',
      paragraphs: [
        // 引文只截取长句中的一段，且句号被包进引号内
        '你在「我更想谁也别见」之后，选择一个人待着。',
        '这一段没有任何引文。',
      ],
      closing: '',
    },
    caveats: [],
    evidenceMap: [],
  };

  const result = validateFinalize(raw, dimensionResults);
  assert.deepEqual(result.validation.invalidParagraphs, [1], '只引一段的段落应算可溯源');
});

test('degradeBiography 只拼原话且每段都带可溯源引文', () => {
  const dimensionResults = [{
    dimension: 'E/I',
    evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }],
    counterEvidence: [],
  }];
  const bio = degradeBiography(dimensionResults);
  assert.equal(bio.degraded, true);
  assert.equal(bio.paragraphs.length, 1);
  assert.ok(bio.paragraphs[0].includes('兴奋得睡不着'));
});

/* ---------- HTTP 层 ---------- */

function startServer(llm, opts = {}) {
  const { server } = createServer({ config: TEST_CONFIG, llm, ...opts });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET / 返回可用的开始页', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, { path: '/' });
    assert.equal(res.status, 200);
    assert.match(res.text, /开始作答/);
  } finally {
    server.close();
  }
});

test('GET /api/health 不泄露密钥', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, { path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.json.keyConfigured, true);
    assert.equal(res.json.model, 'test-model');
    assert.ok(!res.text.includes('sk-unit-test-key'), 'health 响应里不能出现密钥');
  } finally {
    server.close();
  }
});

test('GET /items.json 返回 24 题、四维各 6 题', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, { path: '/items.json' });
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 24);
    for (const dimension of ['E/I', 'S/N', 'T/F', 'J/P']) {
      assert.equal(res.json.items.filter((i) => i.dimension === dimension).length, 6, `${dimension} 应有 6 题`);
    }
  } finally {
    server.close();
  }
});

test('POST /api/score 校验通过后返回本维度结果', async () => {
  const llm = {
    call: async () => ({
      dimension: 'E/I',
      lean: 'I',
      score: 0.75,
      confidence: 0.8,
      evidence: [
        { itemId: 'EI-01', quote: '兴奋得睡不着', signal: '结束后仍兴奋', strength: 'strong' },
        { itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后想躲起来', strength: 'strong' },
        { itemId: 'EI-02', quote: '这段文字根本不在作答里', signal: '编造', strength: 'strong' },
      ],
      counterEvidence: [],
      misreadChecks: ['话少不等于 I → 未命中'],
      missing: ['EI-06'],
      note: 'mock',
    }),
  };
  const server = await startServer(llm);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: FIXTURE_ANSWERS },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.dimension, 'E/I');
    assert.equal(res.json.evidence.length, 2);
    assert.equal(res.json.validation.dropped.length, 1);
    assert.ok(res.json.confidence < 0.8);
  } finally {
    server.close();
  }
});

test('POST /api/score 拒绝未知维度与未作答', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const badDimension = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'X/Y', answers: FIXTURE_ANSWERS },
    });
    assert.equal(badDimension.status, 400);

    const empty = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: [{ itemId: 'EI-01', text: '  ' }] },
    });
    assert.equal(empty.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/finalize 返回类型、四维与可溯源小传', async () => {
  const llm = {
    call: async () => ({
      type: 'ISTJ',
      typeConfidence: 0.66,
      dimensions: [
        { dimension: 'E/I', lean: 'I', score: 0.7, confidence: 0.7, rationale: '「兴奋得睡不着」' },
        { dimension: 'S/N', lean: 'S', score: 0.6, confidence: 0.6, rationale: '' },
        { dimension: 'T/F', lean: 'T', score: 0.55, confidence: 0.5, rationale: '' },
        { dimension: 'J/P', lean: 'J', score: 0.52, confidence: 0.45, rationale: '' },
      ],
      biography: {
        title: '一个把话藏在细节里的人',
        paragraphs: [
          '你在「兴奋得睡不着」这样的句子之后，通常选择一个人待着。',
          '证据薄弱的地方在于：「我更想谁也别见」这类句子只出现过一次。',
          '「我更想谁也别见」这句话重复出现了两次。',
        ],
        closing: '以上只是读数，不是结论。',
      },
      caveats: ['S/N 维度只有一题拿到有效证据'],
      evidenceMap: [
        { dimension: 'E/I', itemId: 'EI-01', quote: '兴奋得睡不着' },
        { dimension: 'E/I', itemId: 'EI-03', quote: '我更想谁也别见' },
      ],
    }),
  };

  const dimensionResults = [{
    dimension: 'E/I',
    evidence: [
      { itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' },
      { itemId: 'EI-03', quote: '我更想谁也别见', signal: '', strength: 'strong' },
    ],
    counterEvidence: [],
  }];

  const server = await startServer(llm);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/finalize',
      body: { dimensionResults },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.type, 'ISTJ');
    assert.equal(res.json.dimensions.length, 4);
    assert.equal(res.json.evidenceMap.length, 2);
    assert.equal(res.json.validation.biographyValid, true);
    assert.equal(res.json.biography.degraded, false);
  } finally {
    server.close();
  }
});

test('POST /api/finalize 纠正模型写错的 type 字母', async () => {
  // 实测事故复现：逐维结论是 E/N/T/J，模型写的 type 却是 ESTJ。
  // 接口必须返回 ENTJ，否则大字母会和同一页的四维读数打架。
  const llm = {
    call: async () => ({
      type: 'ESTJ',
      typeConfidence: 0.79,
      dimensions: [
        { dimension: 'E/I', lean: 'E', score: 0.88, confidence: 0.76, rationale: '依据一' },
        { dimension: 'S/N', lean: 'N', score: 0.64, confidence: 0.85, rationale: '依据二' },
        { dimension: 'T/F', lean: 'T', score: 0.63, confidence: 0.78, rationale: '依据三' },
        { dimension: 'J/P', lean: 'J', score: 0.70, confidence: 0.78, rationale: '依据四' },
      ],
      biography: {
        title: '向外联结、审慎判断与结构收尾',
        paragraphs: ['你在「兴奋得睡不着」之后仍然想找人说话。'],
        closing: '以上只是读数，不是结论。',
      },
      caveats: [],
      evidenceMap: [],
    }),
  };

  const dimensionResults = [
    { dimension: 'E/I', lean: 'E', score: 0.88, evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }], counterEvidence: [] },
    { dimension: 'S/N', lean: 'N', score: 0.64, evidence: [], counterEvidence: [] },
    { dimension: 'T/F', lean: 'T', score: 0.63, evidence: [], counterEvidence: [] },
    { dimension: 'J/P', lean: 'J', score: 0.70, evidence: [], counterEvidence: [] },
  ];

  const server = await startServer(llm);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/finalize',
      body: { dimensionResults },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.type, 'ENTJ');
    assert.deepEqual(res.json.typeLetters, ['E', 'N', 'T', 'J']);
    assert.equal(res.json.validation.modelType, 'ESTJ');
    assert.equal(res.json.validation.typeMismatch, true);
    // 四维读数与大字母必须一致
    assert.deepEqual(
      res.json.dimensions.map((d) => d.lean),
      ['E', 'N', 'T', 'J'],
    );
  } finally {
    server.close();
  }
});

test('POST /api/finalize 小传无引文时降级为保守版', async () => {
  const llm = {
    call: async () => ({
      type: 'INTJ',
      typeConfidence: 0.6,
      dimensions: [],
      biography: {
        title: '测试',
        paragraphs: ['你是一个很有条理的人，做事总有自己的节奏。'],
        closing: '',
      },
      caveats: [],
      evidenceMap: [],
    }),
  };

  const dimensionResults = [{
    dimension: 'E/I',
    evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }],
    counterEvidence: [],
  }];

  const server = await startServer(llm);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/finalize',
      body: { dimensionResults },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.biography.degraded, true);
    assert.ok(res.json.biography.paragraphs[0].includes('兴奋得睡不着'));
  } finally {
    server.close();
  }
});

test('POST 拒绝跨源请求', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: FIXTURE_ANSWERS },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('POST 跨源请求在配置了白名单后放行', async () => {
  const llm = {
    call: async () => ({
      dimension: 'E/I',
      lean: 'I',
      score: 0.8,
      confidence: 0.8,
      evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后想躲起来', strength: 'strong' }],
      counterEvidence: [],
      misreadChecks: [],
      missing: [],
      note: 'mock',
    }),
  };
  const server = await startServer(llm, { allowedOrigins: ['https://psytest.pages.dev'] });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: FIXTURE_ANSWERS },
      headers: { origin: 'https://psytest.pages.dev' },
    });
    assert.equal(res.status, 200, '白名单内的来源应当被放行');

    const blocked = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: FIXTURE_ANSWERS },
      headers: { origin: 'https://not-allowed.example' },
    });
    assert.equal(blocked.status, 403, '白名单外的来源仍应被拒');
  } finally {
    server.close();
  }
});

test('POST 触发限流时返回 429', async () => {
  const llm = {
    call: async () => ({
      dimension: 'E/I',
      lean: 'I',
      score: 0.8,
      confidence: 0.8,
      evidence: [],
      counterEvidence: [],
      misreadChecks: [],
      missing: [],
      note: 'mock',
    }),
  };
  const server = await startServer(llm, { rateLimit: { allow: () => false } });
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: { dimension: 'E/I', answers: FIXTURE_ANSWERS },
    });
    assert.equal(res.status, 429);
    assert.match(res.json.error, /过于频繁/);
  } finally {
    server.close();
  }
});

test('envList 解析逗号分隔的环境变量', () => {
  assert.deepEqual(envList('X', [], { X: 'a, b ,,c' }), ['a', 'b', 'c']);
  assert.deepEqual(envList('X', ['fallback'], {}), ['fallback']);
  assert.deepEqual(envList('X', [], { X: '' }), []);
});

test('createRateLimiter 在窗口内限流、窗口外放行', () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 2 });
  assert.equal(limiter.allow('1.2.3.4'), true);
  assert.equal(limiter.allow('1.2.3.4'), true);
  assert.equal(limiter.allow('1.2.3.4'), false, '超出上限应被拒');
  assert.equal(limiter.allow('5.6.7.8'), true, '不同 IP 各算各的');
});

test('clientIp 默认不信任 X-Forwarded-For', () => {
  const req = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '1.1.1.1' } };
  assert.equal(clientIp(req), '1.1.1.1');
  assert.equal(clientIp(req, { trustProxy: true }), '9.9.9.9');
});

test('题库字段完整且题干互不重复', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, { path: '/items.json' });
    const prompts = new Set();
    for (const item of res.json.items) {
      assert.ok(item.id, '缺少 id');
      assert.ok(['E/I', 'S/N', 'T/F', 'J/P'].includes(item.dimension), `题号 ${item.id} 维度非法`);
      assert.ok(item.prompt && item.prompt.length > 6, `题号 ${item.id} 题干过短`);
      assert.ok(item.construct, `题号 ${item.id} 缺少构念`);
      assert.ok(item.writingGuide, `题号 ${item.id} 缺少写作指引`);
      assert.ok(Array.isArray(item.minInfo) && item.minInfo.length >= 2, `题号 ${item.id} 缺少最小信息要求`);
      assert.ok(item.anchors && Object.keys(item.anchors).length === 2, `题号 ${item.id} 锚点必须两端各一`);
      assert.ok(Array.isArray(item.misreads) && item.misreads.length >= 1, `题号 ${item.id} 缺少误读防护`);
      assert.ok(['core', 'extended'].includes(item.tier), `题号 ${item.id} 缺少 tier 分层`);
      assert.ok(!prompts.has(item.prompt), `题号 ${item.id} 题干重复`);
      prompts.add(item.prompt);
    }
  } finally {
    server.close();
  }
});

test('题库每个维度恰好 4 道核心题、2 道扩展题', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const res = await request(server, { path: '/items.json' });
    for (const dimension of ['E/I', 'S/N', 'T/F', 'J/P']) {
      const items = res.json.items.filter((i) => i.dimension === dimension);
      assert.equal(items.length, 6, `${dimension} 应有 6 题`);
      assert.equal(items.filter((i) => i.tier === 'core').length, 4, `${dimension} 应有 4 道核心题`);
      assert.equal(items.filter((i) => i.tier === 'extended').length, 2, `${dimension} 应有 2 道扩展题`);
    }
    assert.equal(res.json.items.filter((i) => i.tier === 'core').length, 16, '核心题共 16 道');
  } finally {
    server.close();
  }
});

test('POST /api/score 允许跳题：写了一题就能提交，跳过的题记为缺口', async () => {
  const llm = {
    call: async () => ({
      dimension: 'E/I',
      lean: 'I',
      score: 0.8,
      confidence: 0.7,
      evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后想躲起来', strength: 'strong' }],
      counterEvidence: [],
      misreadChecks: [],
      missing: [],
      note: 'mock',
    }),
  };
  const server = await startServer(llm);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: {
        dimension: 'E/I',
        answers: [
          { itemId: 'EI-01', text: '' },
          { itemId: 'EI-03', text: '一个人待了一整天之后，我更想谁也别见。' },
          { itemId: 'EI-04', text: '' },
        ],
        skipped: ['EI-01', 'EI-04'],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.answeredCount, 1, '应如实记录只写了一题');
    assert.deepEqual(res.json.skipped, ['EI-01', 'EI-04']);
    assert.ok(res.json.missing.includes('EI-01'), '跳过的题必须计入证据缺口');
    assert.ok(res.json.missing.includes('EI-04'), '跳过的题必须计入证据缺口');
  } finally {
    server.close();
  }
});

test('POST /api/score 拒绝整维全空与不存在的跳过题号', async () => {
  const server = await startServer({ call: async () => ({}) });
  try {
    const empty = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: {
        dimension: 'E/I',
        answers: [{ itemId: 'EI-01', text: '' }],
        skipped: ['EI-01'],
      },
    });
    assert.equal(empty.status, 400, '整维没有作答应当被拒');

    const badSkip = await request(server, {
      method: 'POST',
      path: '/api/score',
      body: {
        dimension: 'E/I',
        answers: [{ itemId: 'EI-01', text: '有作答' }],
        skipped: ['EI-99'],
      },
    });
    assert.equal(badSkip.status, 400, '不属于本维度的跳过题号应当被拒');
  } finally {
    server.close();
  }
});
