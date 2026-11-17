/**
 * 维度透镜与提示词渲染。
 *
 * 透镜内容改编自 OriSelf 的 MBTI 域透镜（Apache-2.0），
 * 保留其判型心法、识别信号、易误读清单与证据门槛，并按本项目的开放题形态重写。
 * 每题的锚点与误读防护来自 public/items.json，不在此处硬编码。
 */

/**
 * 维度透镜与提示词渲染。
 *
 * 透镜不再硬编码在代码里，而是随套件走：每个套件文件（public/suites/<id>.json）
 * 自带维度的定义、判型心法、识别信号、易误读清单与证据门槛。
 * 同一套引擎因此可以服务多个测试（MBTI、大五人格、职业画像、关系依恋……）。
 *
 * MBTI 域透镜的内容改编自 OriSelf 的 MBTI 域透镜（Apache-2.0），
 * 保留其判型心法、识别信号、易误读清单与证据门槛，并按本项目的开放题形态重写。
 * 每题的锚点与误读防护来自套件文件的 items，也不在此处硬编码。
 */

/** 渲染该维度的题目块（题干 + 锚点 + 误读防护）。 */
function renderItemsBlock(dimension, items) {
  const rows = items
    .filter((item) => item.dimension === dimension)
    .map((item) => {
      const anchors = Object.entries(item.anchors || {})
        .map(([pole, text]) => `    ${pole}：${text}`)
        .join('\n');
      const misreads = (item.misreads || []).map((m) => `    - ${m}`).join('\n');
      return [
        `  [${item.id}] 构念：${item.construct}`,
        `    题干：${item.prompt}`,
        `    锚点：`,
        anchors,
        `    易误读：`,
        misreads,
      ].join('\n');
    })
    .join('\n\n');
  return rows || '  （本维度没有题目）';
}

/** 渲染作答块。跳过的题要明确标出，避免模型替空题编造证据。 */
function renderAnswersBlock(answers, skippedIds = []) {
  const skipped = new Set(skippedIds);
  return answers
    .map((answer, index) => {
      const raw = String(answer.text ?? '').trim();
      const text = raw || (skipped.has(answer.itemId)
        ? '（本题未作答，受测者已跳过）'
        : '（本题未作答）');
      return `### 第 ${index + 1} 题 · ${answer.itemId}\n${text}`;
    })
    .join('\n\n');
}

/**
 * 输出格式示例。
 * 示例里的维度名与极值必须来自当前套件——写死 MBTI 的 E/I 会把模型带偏：
 * 大五人格是 5 维，职业画像与关系套件用的是另一套字母。
 */
function scoreSchema({ dimension, poles = [], sampleItemId = 'X-01', counterItemId = 'X-02' }) {
  const [poleA = 'A', poleB = 'B'] = poles;
  return `{
  "dimension": "${dimension}",
  "lean": "${poleA} | ${poleB} | ambiguous",
  "score": 0.0,
  "confidence": 0.0,
  "evidence": [
    { "itemId": "${sampleItemId}", "quote": "作答中一段连续原文，逐字照抄", "signal": "哪一句支撑该倾向", "strength": "strong | weak" }
  ],
  "counterEvidence": [
    { "itemId": "${counterItemId}", "quote": "…", "signal": "…", "strength": "strong | weak" }
  ],
  "misreadChecks": ["本维易误读项 → 本次是否命中，未命中也要写明"],
  "missing": ["证据不足的题号"],
  "note": "一两句话说明"
}`;
}

/** 汇总阶段的输出格式示例。维度条数与字母组合都随套件走。 */
function finalSchema(dims = []) {
  const typeExample = dims.map((d) => (d.poles || [])[0] || 'X').join('') || 'XXXX';
  const dimRows = dims.map((d) => (
    `    { "dimension": "${d.key}", "lean": "${(d.poles || [])[0] || 'X'} | ${(d.poles || [])[1] || 'Y'}"`
    + ', "score": 0.0, "confidence": 0.0, "rationale": "一两句话" }'
  )).join(',\n');
  const firstItemId = 'X-01';
  return `{
  "type": "${typeExample}",
  "typeConfidence": 0.0,
  "dimensions": [
${dimRows || '    { "dimension": "维度键", "lean": "A | B", "score": 0.0, "confidence": 0.0, "rationale": "一两句话" }'}
  ],
  "biography": {
    "title": "给小传的标题",
    "paragraphs": ["第一段，含「引文」", "第二段，含「引文」", "第三段，含「引文」"],
    "closing": "结尾一段"
  },
  "caveats": ["证据边界说明"],
  "evidenceMap": [
    { "dimension": "${dims[0] ? dims[0].key : '维度键'}", "itemId": "${firstItemId}", "quote": "逐字照抄输入中出现的引文" }
  ]
}`;
}

/**
 * 构造 /api/score 的 system / user 消息。
 * @param {{dimension:string, dimensionMeta:object, items:Array, answers:Array, skipped?:Array<string>}} params
 */
export function buildScoreMessages({ dimension, dimensionMeta, items, answers, skipped = [] }) {
  const lens = dimensionMeta && dimensionMeta.lens;
  if (!lens) throw new Error(`维度缺少透镜定义：${dimension}`);
  const poles = (dimensionMeta && dimensionMeta.poles) || [];

  const skippedIds = Array.isArray(skipped) ? skipped.map(String) : [];
  const asked = skippedIds.length
    ? [...answers.map((a) => String(a.itemId)), ...skippedIds]
    : null;
  // 只渲染本次真正问到的题：快速版没问的题不该出现在题面里。
  const askedItems = asked ? items.filter((item) => asked.includes(item.id)) : items;
  const answeredCount = answers.filter((a) => String(a.text ?? '').trim()).length;

  const system = [
    `你是一个心理测量评分助手。你这次只评估「${dimension}」这一个维度，不得推测、不得提及其他维度。`,
    '',
    '【维度透镜】',
    `定义：${lens.definition}`,
    `判型心法：${lens.heart}`,
    '识别信号：',
    ...lens.signals.map((s) => `  - ${s}`),
    '易误读清单（先判断是否命中，再决定采不采信信号）：',
    ...lens.misreads.map((m) => `  - ${m}`),
    `证据门槛：${lens.threshold}`,
    '',
    '【本维度的题目与锚点】',
    renderItemsBlock(dimension, askedItems),
    '',
    '【硬性规则】',
    '1. 只依据受测者的原话作答。每条 evidence 的 quote 必须是该题作答中的一段连续原文，逐字照抄；不得改写、不得拼接两处、不得翻译、不得省略、不得补字。',
    '2. 不得编造作答里没有出现的内容。找不到支撑就把该题号写进 missing。',
    `3. score 只在本维度内归一化。计分轴固定为 ${poles[0]} → ${poles[1]}：0 表示完全倒向 ${poles[0]}，1 表示完全倒向 ${poles[1]}，0.5 表示中性。若无法判定倾向，lean 填 ambiguous、score 填 0.5。`,
    '4. confidence 衡量的是证据充分度，不是你的自信程度。证据少、证据弱、场景不具体时必须给低分。',
    '5. counterEvidence 填与结论相反的证据；没有就留空数组。',
    '6. 禁止使用泛化赞美，禁止"你是一个…的人"这类盖章句。',
    '7. 所有说明性文字（signal、note、misreadChecks、missing）一律用中文书写；除受测者原话里本来就有的英文外，不要在中文里夹用英文单词。',
    `8. 本次本维度共问了 ${askedItems.length} 题，其中受测者实际作答 ${answeredCount} 题`
      + `${skippedIds.length ? `、跳过 ${skippedIds.length} 题（${skippedIds.join('、')}）` : ''}。`
      + '被跳过的题没有任何作答材料：不得为其编造 evidence 或 counterEvidence，必须把它的题号写进 missing；'
      + '证据条数明显少于题数时，confidence 必须相应下调。',
    '',
    '【输出格式】',
    '严格输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：',
    scoreSchema({
      dimension,
      poles,
      sampleItemId: askedItems[0] ? askedItems[0].id : 'X-01',
      counterItemId: askedItems[1] ? askedItems[1].id : 'X-02',
    }),
  ].join('\n');

  const user = [
    `以下是受测者在「${dimension}」维度下的作答原文。请严格按 system 中的规则评分。`,
    '',
    renderAnswersBlock(answers, skippedIds),
  ].join('\n');

  return { system, user };
}

/**
 * 构造 /api/finalize 的 system / user 消息。
 * @param {{dimensionResults:Array, dimensions:Array<{key:string,poles:string[]}>}} params
 */
export function buildFinalizeMessages({ dimensionResults, dimensions = [] }) {
  const dims = dimensions.length ? dimensions : [];
  const axisLines = dims.map((d) => `  ${d.key}：0 = ${d.poles[0]}，1 = ${d.poles[1]}`);
  const orderText = dims.map((d) => d.key).join('、');
  const n = dims.length;

  const system = [
    `你是一个心理测量报告合成助手。你将收到 ${n} 个维度的判型结果（每条都带受测者原话引文）。`,
    '',
    '【计分轴】',
    ...axisLines,
    '',
    '【硬性规则】',
    `1. type 必须是 ${n} 个字母，顺序固定为 ${orderText}，每一位只能取该维度的两个极值之一。`,
    '2. evidenceMap 里的 quote 只能逐字复制输入中出现过的引文，不得改写或新造。',
    '3. 人物小传 biography.paragraphs 必须正好 3 段，并且：',
    '   - 每段至少包含一处用「」包住的引文，且该引文逐字出现在输入的证据引文中；',
    '   - 至少有一段要写出证据薄弱、彼此矛盾或随情境变化的地方——诚实，不是讨好；',
    '   - 不得出现"你是一个…的人""你天生…""你总是…"这类盖章句；',
    '   - 不得编造输入里没有的经历、事件或特质；',
    '   - 不得断言"这是诊断""准确无误"。',
    '4. caveats 至少 1 条，说明本次画像的证据边界（例如某维证据不足、某题作答过短）。',
    `5. dimensions 数组必须正好 ${n} 条，每条对应一个维度，rationale 里可以引用引文。`,
    '6. dimensions 里的 lean 必须沿用输入的判型结论。只有当输入该维度为 ambiguous 时才允许做微弱裁决，且必须在 rationale 里写明这是裁决而非确证。',
    '7. 所有说明性文字一律用中文书写；除受测者原话里本来就有的英文外，不要在中文里夹用英文单词。',
    '',
    '【输出格式】',
    '严格输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：',
    finalSchema(dims),
  ].join('\n');

  const user = [
    `以下是 ${n} 个维度的判型结果。请据此合成最终画像。`,
    '',
    JSON.stringify(dimensionResults, null, 2),
  ].join('\n');

  return { system, user };
}

/** 重生成小传时的补充指令（首轮校验不通过时追加）。 */
export function buildFinalizeRetryMessages({ dimensionResults, problems, dimensions }) {
  const base = buildFinalizeMessages({ dimensionResults, dimensions });
  return {
    system: `${base.system}\n\n【上次输出的问题】\n${problems}\n请修正后重新输出完整 JSON。`,
    user: base.user,
  };
}
