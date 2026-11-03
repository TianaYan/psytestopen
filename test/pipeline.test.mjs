/**
 * 共享判型流程的离线测试。
 *
 * public/lib/pipeline.js 是服务端与浏览器共用的唯一实现，
 * 因此它的行为（引文校验、类型派生、小传降级）在这里被独立锁住。
 *
 * 运行：node --test test/pipeline.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreDimension, finalizeReport, polesByDimension } from '../public/lib/pipeline.js';
import { buildScoreMessages } from '../public/lib/prompts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'public', 'items.json'), 'utf8'));

const EI_ITEMS = BANK.items.filter((i) => i.dimension === 'E/I');

const EI_ANSWERS = [
  { itemId: 'EI-01', text: '上次年会散场，我在车上还想给同事回消息，兴奋得睡不着。' },
  { itemId: 'EI-02', text: '带项目那段其实挺累的，做完我只想一个人歇着。' },
  { itemId: 'EI-03', text: '一个人待了一整天之后，我更想谁也别见。' },
  { itemId: 'EI-04', text: '那天我在人群里一句话没说，心里空空的。' },
  { itemId: 'EI-05', text: '连着三天没跟人说话，我一点也不想出去。' },
  { itemId: 'EI-06', text: '我一般不主动接话，被点名才开口。' },
];

/** 依次返回预设响应的假模型客户端。 */
function fakeClient(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async call(payload) {
      calls.push(payload);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

test('scoreDimension 走完模型调用并校验引文', async () => {
  const client = fakeClient([{
    dimension: 'E/I',
    lean: 'I',
    score: 0.82,
    confidence: 0.9,
    evidence: [
      { itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后仍想躲起来', strength: 'strong' },
      { itemId: 'EI-01', quote: '这句根本不在作答里', signal: '编造', strength: 'strong' },
    ],
    counterEvidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '社交后仍兴奋', strength: 'strong' }],
    misreadChecks: ['疲惫 ≠ I'],
    missing: ['EI-06'],
    note: '说明',
  }]);

  const result = await scoreDimension({
    dimension: 'E/I',
    answers: EI_ANSWERS,
    items: EI_ITEMS,
    call: (msg) => client.call(msg),
  });

  assert.equal(client.calls.length, 1, '只应调用一次模型');
  assert.ok(client.calls[0].system.includes('E/I'), '提示词应包含维度');
  assert.equal(result.lean, 'I');
  assert.equal(result.evidence.length, 1, '对不上的引文必须被丢弃');
  assert.equal(result.validation.dropped.length, 1);
  assert.ok(result.confidence < 0.9, '丢引文后置信度要下调');
  assert.equal(result.axis.from, 'E');
  assert.equal(result.axis.to, 'I');
});

test('finalizeReport 按逐维倾向拼出类型，不采信模型写错的 type', async () => {
  const notes = [];
  const client = fakeClient([{
    type: 'ESTJ',
    typeConfidence: 0.79,
    dimensions: [
      { dimension: 'E/I', lean: 'E', score: 0.12, confidence: 0.76, rationale: '一' },
      { dimension: 'S/N', lean: 'N', score: 0.64, confidence: 0.85, rationale: '二' },
      { dimension: 'T/F', lean: 'T', score: 0.6, confidence: 0.78, rationale: '三' },
      { dimension: 'J/P', lean: 'J', score: 0.3, confidence: 0.78, rationale: '四' },
    ],
    biography: {
      title: '测试',
      paragraphs: ['你写下「兴奋得睡不着」，说明你还想继续互动。'],
      closing: '',
    },
    caveats: [],
    evidenceMap: [],
  }]);

  const dimensionResults = [
    { dimension: 'E/I', lean: 'E', score: 0.12, evidence: [{ itemId: 'EI-01', quote: '兴奋得睡不着', signal: '', strength: 'strong' }], counterEvidence: [] },
    { dimension: 'S/N', lean: 'N', score: 0.64, evidence: [], counterEvidence: [] },
    { dimension: 'T/F', lean: 'T', score: 0.6, evidence: [], counterEvidence: [] },
    { dimension: 'J/P', lean: 'J', score: 0.3, evidence: [], counterEvidence: [] },
  ];

  const result = await finalizeReport({ dimensionResults, call: (msg) => client.call(msg), onNote: (m) => notes.push(m) });

  assert.equal(result.type, 'ENTJ');
  assert.deepEqual(result.typeLetters, ['E', 'N', 'T', 'J']);
  assert.equal(result.validation.typeMismatch, true);
  assert.ok(
    notes.some((n) => n.includes('ESTJ') && n.includes('ENTJ')),
    '应记录一条"类型被更正"的说明',
  );
});

test('finalizeReport 小传不合格时重试一次，仍不合格则降级', async () => {
  const badBiography = {
    type: 'ISFP',
    typeConfidence: 0.8,
    dimensions: [],
    biography: {
      title: '测试',
      // 没有任何可溯源引文
      paragraphs: ['你是一个很有条理的人，做事总有自己的节奏。'],
      closing: '',
    },
    caveats: [],
    evidenceMap: [],
  };

  const client = fakeClient([badBiography]);
  const notes = [];
  const dimensionResults = [
    { dimension: 'E/I', lean: 'I', score: 0.8, evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '', strength: 'strong' }], counterEvidence: [] },
  ];

  const result = await finalizeReport({ dimensionResults, call: (msg) => client.call(msg), onNote: (m) => notes.push(m) });

  assert.equal(client.calls.length, 2, '首轮不合格应重试一次');
  assert.equal(result.biography.degraded, true, '仍不合格就降级为只拼原话');
  assert.ok(result.biography.paragraphs[0].includes('我更想谁也别见'));
  assert.ok(notes.some((n) => n.includes('重新生成一次')));
});

test('polesByDimension 给出四维两极', () => {
  const poles = polesByDimension();
  assert.deepEqual(poles['E/I'], ['E', 'I']);
  assert.deepEqual(poles['S/N'], ['S', 'N']);
  assert.deepEqual(poles['T/F'], ['T', 'F']);
  assert.deepEqual(poles['J/P'], ['J', 'P']);
});

test('buildScoreMessages 明确标出跳过的题并禁止为其编造证据', () => {
  const { system, user } = buildScoreMessages({
    dimension: 'E/I',
    items: EI_ITEMS,
    answers: [
      { itemId: 'EI-01', text: '' },
      { itemId: 'EI-03', text: '一个人待了一整天之后，我更想谁也别见。' },
    ],
    skipped: ['EI-01'],
  });

  assert.match(user, /本题未作答，受测者已跳过/);
  assert.match(system, /实际作答 1 题/);
  assert.match(system, /EI-01/, '跳过的题号要写进规则里');
  assert.match(system, /不得为其编造/);
  // 没问到的题不该出现在题面里（快速版只给 4 题时尤其重要）
  assert.ok(!user.includes('EI-06'), '未作答且未跳过的题不应出现在作答块里');
});

test('scoreDimension 把跳过的题记入证据缺口并记录作答条数', async () => {
  const client = fakeClient([{
    dimension: 'E/I',
    lean: 'I',
    score: 0.8,
    confidence: 0.7,
    evidence: [{ itemId: 'EI-03', quote: '我更想谁也别见', signal: '独处后想躲起来', strength: 'strong' }],
    counterEvidence: [],
    misreadChecks: [],
    missing: [],
    note: 'mock',
  }]);

  const result = await scoreDimension({
    dimension: 'E/I',
    answers: [
      { itemId: 'EI-01', text: '' },
      { itemId: 'EI-03', text: '一个人待了一整天之后，我更想谁也别见。' },
    ],
    items: EI_ITEMS,
    skipped: ['EI-01'],
    call: (msg) => client.call(msg),
  });

  assert.equal(result.answeredCount, 1);
  assert.deepEqual(result.skipped, ['EI-01']);
  assert.ok(result.missing.includes('EI-01'), '跳过的题必须计入证据缺口');
  // 跳过的题没有作答材料，任何引用它的引文都应被丢弃
  assert.ok(!result.evidence.some((e) => e.itemId === 'EI-01'));
});
