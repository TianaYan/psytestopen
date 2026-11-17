/**
 * 套件契约 + 浏览器调用链的离线测试（不发网络请求，用假模型客户端）。
 * 运行：node --test test/
 *
 * 为什么单独一份：
 * 套件化重构（题库从 public/items.json 拆到 public/suites/<id>.json）之后，
 * 浏览器直连路径曾漏传 dimensionMeta / dimensions，四个维度全部报"维度缺少透镜定义"，
 * 而 pipeline 层的纯函数测试照样全绿——它测的是 pipeline 本身，不是调用点。
 * 所以这里把 app.js 的调用参数组装抽成纯函数（scoreCallArgs / finalizeCallArgs）后直接断言，
 * 并对每个套件文件做内容契约校验：维度透镜齐全、题目挂对维度、题目 id 全局唯一。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { state, scoreCallArgs, finalizeCallArgs } from '../public/app.js';
import { scoreDimension, finalizeReport } from '../public/lib/pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.join(HERE, '..', 'public', 'suites');

const INDEX = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, 'index.json'), 'utf8'));
const FILES = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');

function loadSuite(id) {
  return JSON.parse(fs.readFileSync(path.join(SUITES_DIR, `${id}.json`), 'utf8'));
}

/** 假引文：必须是作答原文的连续片段，否则会被校验规则丢弃。 */
const QUOTE = '我遇到这种情况通常先记一笔';

function answersFor(suite, dimension) {
  return suite.items
    .filter((item) => item.dimension === dimension)
    .map((item) => ({
      itemId: item.id,
      text: `${QUOTE}。${item.id} 那天的记录本上就是这么写的，过几天回看也认得出来。`,
    }));
}

/* ---------- 套件文件契约 ---------- */

test('套件目录里的每个文件都在入口目录中登记', () => {
  const registered = INDEX.map((entry) => entry.id).sort();
  const onDisk = FILES.map((file) => file.replace(/\.json$/, '')).sort();
  assert.deepEqual(registered, onDisk, '入口目录与套件文件必须一一对应');

  for (const entry of INDEX) {
    assert.ok(entry.name, `${entry.id} 缺展示名`);
    assert.ok(entry.tagline, `${entry.id} 缺一句话说明`);
  }
});

/**
 * 入口目录里的题量必须等于套件文件的真实题量。
 * 之前这里是手写字符串（"4 维 · 24 题（快速版 16 题）"），一旦套件增删题就会说谎。
 */
test('入口目录里的题量与套件文件一致', () => {
  for (const entry of INDEX) {
    const suite = loadSuite(entry.id);
    const core = suite.items.filter((item) => item.tier === 'core').length;
    assert.equal(entry.dimensionCount, suite.dimensions.length, `${entry.id} 维度数对不上`);
    assert.equal(entry.itemCount, suite.items.length, `${entry.id} 题量对不上`);
    assert.equal(entry.coreItemCount, core, `${entry.id} 快速版题量对不上`);
  }
});

test('每个套件的维度都带完整透镜与两极', () => {
  for (const entry of INDEX) {
    const suite = loadSuite(entry.id);
    assert.equal(suite.id, entry.id, `${entry.id} 文件里的 id 与文件名不一致`);
    assert.ok(suite.dimensions.length >= 3, `${entry.id} 维度太少`);
    assert.ok(suite.intro && suite.intro.length > 10, `${entry.id} 缺开场说明`);

    const seen = new Set();
    for (const dim of suite.dimensions) {
      assert.ok(dim.key && dim.label, `${entry.id} 维度缺 key/label`);
      assert.equal(seen.has(dim.key), false, `${entry.id} 维度 key 重复：${dim.key}`);
      seen.add(dim.key);

      assert.equal((dim.poles || []).length, 2, `${entry.id}/${dim.key} 必须有且只有两个极`);
      assert.equal(new Set(dim.poles).size, 2, `${entry.id}/${dim.key} 两个极不能相同`);
      assert.equal((dim.poleLabels || []).length, 2, `${entry.id}/${dim.key} 缺两极可读名`);

      const lens = dim.lens;
      assert.ok(lens, `${entry.id}/${dim.key} 缺透镜`);
      assert.ok(lens.definition && lens.definition.length > 10, `${entry.id}/${dim.key} 透镜缺定义`);
      assert.ok(lens.heart && lens.heart.length > 5, `${entry.id}/${dim.key} 透镜缺判型心法`);
      assert.ok(Array.isArray(lens.signals) && lens.signals.length > 0, `${entry.id}/${dim.key} 透镜缺识别信号`);
      assert.ok(Array.isArray(lens.misreads) && lens.misreads.length > 0, `${entry.id}/${dim.key} 透镜缺易误读清单`);
      assert.ok(lens.threshold && lens.threshold.length > 0, `${entry.id}/${dim.key} 透镜缺证据门槛`);
    }
  }
});

test('每个套件的题目都挂在已登记的维度上，题号在套件内唯一', () => {
  for (const entry of INDEX) {
    const suite = loadSuite(entry.id);
    const dimKeys = new Set(suite.dimensions.map((d) => d.key));
    const coreCount = {};
    // 题号只需在套件内唯一：答案按维度分桶，引证表按「维度 + 题号」展示。
    const seen = new Set();

    for (const item of suite.items) {
      assert.ok(dimKeys.has(item.dimension), `${entry.id}/${item.id} 挂在不存在的维度上`);
      assert.equal(seen.has(item.id), false, `${entry.id} 内题目 id 重复：${item.id}`);
      seen.add(item.id);
      assert.ok(item.prompt && item.prompt.length > 5, `${entry.id}/${item.id} 题干太短`);
      assert.ok(['core', 'extended'].includes(item.tier), `${entry.id}/${item.id} 的 tier 非法：${item.tier}`);
      if (item.tier === 'core') {
        coreCount[item.dimension] = (coreCount[item.dimension] || 0) + 1;
      }
    }

    for (const dim of suite.dimensions) {
      assert.ok(
        (coreCount[dim.key] || 0) >= 4,
        `${entry.id}/${dim.key} 的 core 题不足 4 道，快速版会缺题`,
      );
    }
  }
});

/* ---------- 浏览器调用链 ---------- */

test('浏览器调用参数带上了透镜与题目（漏 dimensionMeta 会在运行时炸掉整维）', () => {
  try {
    for (const entry of INDEX) {
      const suite = loadSuite(entry.id);
      state.suite = suite;

      for (const mode of ['full', 'quick']) {
        state.mode = mode;
        for (const dim of suite.dimensions) {
          const args = scoreCallArgs(dim.key, [], []);
          assert.ok(args.dimensionMeta, `${entry.id}/${dim.key} 缺 dimensionMeta`);
          assert.ok(
            args.dimensionMeta.lens && args.dimensionMeta.lens.definition,
            `${entry.id}/${dim.key} 缺透镜定义`,
          );
          const expected = suite.items.filter((item) => (
            item.dimension === dim.key && (mode === 'full' || item.tier === 'core')
          )).length;
          assert.equal(args.items.length, expected, `${entry.id}/${dim.key} 的题量不对`);
        }
      }

      const finalizeArgs = finalizeCallArgs([]);
      assert.equal(finalizeArgs.dimensions.length, suite.dimensions.length, `${entry.id} 汇总阶段漏传维度清单`);
      assert.equal(
        finalizeArgs.dimensions[0].lens.definition.length > 10,
        true,
        `${entry.id} 汇总阶段拿到的维度必须带透镜`,
      );
    }
  } finally {
    state.suite = null;
  }
});

test('浏览器端的单维判型与汇总都能跑通（假模型，不发网络请求）', async () => {
  try {
    for (const entry of INDEX) {
      const suite = loadSuite(entry.id);
      state.suite = suite;
      state.mode = 'quick';

      const results = [];
      for (const dim of suite.dimensions) {
        const answers = answersFor(suite, dim.key);
        const client = {
          async call() {
            return {
              dimension: dim.key,
              lean: dim.poles[0],
              score: 0.7,
              confidence: 0.8,
              evidence: [{
                itemId: answers[0].itemId,
                quote: QUOTE,
                signal: '有记录习惯',
                strength: 'strong',
              }],
              counterEvidence: [],
              misreadChecks: [],
              missing: [],
            };
          },
        };

        // 关键：用 app.js 组装的参数调 pipeline。漏传 dimensionMeta 会在这里直接抛错。
        const result = await scoreDimension({ ...scoreCallArgs(dim.key, answers, []), client });
        assert.equal(result.dimension, dim.key);
        assert.equal(result.lean, dim.poles[0]);
        assert.equal(result.evidence.length, 1, `${entry.id}/${dim.key} 的引文应通过溯源校验`);
        results.push(result);
      }

      const finalClient = {
        async call() {
          return {
            // 故意写错：类型字母必须由逐维倾向拼出，不能采信模型自写的 type。
            type: 'ZZZZ',
            typeConfidence: 0.9,
            dimensions: suite.dimensions.map((d) => ({
              dimension: d.key, lean: d.poles[0], score: 0.6, confidence: 0.6, rationale: '',
            })),
            evidenceMap: [],
            biography: {
              title: '测试画像',
              paragraphs: [`你写道「${QUOTE}」，这是本次的依据。`],
              closing: '仅供自我参照。',
            },
            caveats: ['仅用于回归测试'],
          };
        },
      };

      const final = await finalizeReport({ ...finalizeCallArgs(results), client: finalClient });
      const expected = suite.dimensions.map((d) => d.poles[0]).join('');
      assert.equal(final.type, expected, `${entry.id} 的字母必须由逐维倾向拼出`);
      assert.equal(final.typeLetters.length, suite.dimensions.length, `${entry.id} 字母数应等于维度数`);
      assert.equal(final.validation.biographyValid, true, `${entry.id} 小传应通过引文溯源校验`);
    }
  } finally {
    state.suite = null;
  }
});
