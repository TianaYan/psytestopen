/**
 * 维度透镜与提示词渲染。
 *
 * 透镜内容改编自 OriSelf 的 MBTI 域透镜（Apache-2.0），
 * 保留其判型心法、识别信号、易误读清单与证据门槛，并按本项目的开放题形态重写。
 * 每题的锚点与误读防护来自 public/items.json，不在此处硬编码。
 */

export const DIMENSIONS = ['E/I', 'S/N', 'T/F', 'J/P'];

export const DIMENSION_ORDER = [
  { key: 'E/I', label: '能量朝向', poles: ['E', 'I'] },
  { key: 'S/N', label: '信息摄取', poles: ['S', 'N'] },
  { key: 'T/F', label: '决策方式', poles: ['T', 'F'] },
  { key: 'J/P', label: '生活节奏', poles: ['J', 'P'] },
];

const LENS = {
  'E/I': {
    definition:
      'E：与人共处后感到被充电，独处一天会觉得有点闷。I：社交后需要独处恢复，一天不说话也完全 OK。',
    heart:
      '判型只看一件事：受测者放松时自然流露的样子代表主导倾向。压力或应激下冒出来的相反特质是"不舒服"的信号，不是判型依据，不要因为一两次出格就翻型。',
    signals: [
      '能量反馈优先：问"那之后你感觉怎么样"，而不是数他说了多少话。',
      '带人、带项目、把一件事推成时，他的状态最好——这是强 E 的核心来源。',
      '思考型 E（ENTJ / ENTP / ESTJ / ESFJ）在 1v1 里非常像 I：安静、深挖、数字化、不主动社交。真实能量来源是驱动他人、塑造环境、在讨论里不自觉接管方向。',
      '独处偏好必须配合"一个具体场景里的能量反馈"才算数。',
    ],
    misreads: [
      '话少 ≠ I，可能是累、不擅长打字、在等你接话。',
      '"一个人吃饭更自在" ≠ I，ENTJ / INTJ / ENTP 都可能这么答，因为那是"能边吃边想"。',
      '被问"累不累"后的疲惫 ≠ I 倾向，那可能只是真的累。',
      '用了很多表情或语气词 ≠ E。',
    ],
    threshold:
      '收束时，这一维要能讲出 1–2 个具体场景才可给高分。讲不出来就把 score 压到 0.6 以下，并在 missing 里写明哪几题没拿到有效证据。',
  },

  'S/N': {
    definition:
      'S：注意具体细节、过往经验、当下的画面。N：跳到模式、意义、未来可能性。',
    heart:
      '判型看注意力落在哪里：落在具体画面与既有经验上是 S，跳到联想、模式与未来可能是 N。被你问出来的"未来"不算 N，必须是他自发想到的。',
    signals: [
      '复现某一天的具体感官细节（那天很烫的光、某个声音、某个动作）→ S。',
      '自发地从 A 联想到不相关的 B，或主动设想多年后的情形 → N。',
      '谈一件事时习惯先调取"以前怎么处理过的"经验 → S。',
      '谈一件事时习惯先问"这件事到底意味着什么" → N。',
    ],
    misreads: [
      '用了比喻或意象 ≠ N，那是语言风格。一个 S 的人也可以很文艺地描述眼前的光。',
      '讲了很多细节 ≠ S，也可能是 N 的人在复述一个他抽象过的故事。',
      '你说"想想未来会怎样"而他顺着答了 → 不构成 N 证据，因为那是你问出来的。',
      '喜欢列清单、写得具体 ≠ S 的证据不足，可能只是 J。',
    ],
    threshold:
      '这一维要能讲出 1–2 个具体场景才可给高分。S 与 N 的判据必须落在"注意力落点"上，不能落在"文字是否具体"上。',
  },

  'T/F': {
    definition:
      'T：按逻辑、标准、对错决定。F：按影响人、关系、价值观决定。',
    heart:
      '判型看决策时以什么为先：对错与效率优先，还是影响人与和谐优先。不看说话风格，不看他是否共情。',
    signals: [
      '一次真实决策里，他先说出口的是"这不合理"还是"这样 TA 会难受"→ 前者 T，后者 F。',
      '别人情绪爆发时，他第一反应是先接住对方还是先分析问题。',
      '他事后复盘一件事时，脑内第一句是"我错了"还是"我当时没考虑到 TA 的感受"。',
      '他是否会因为"对某人不公平"而放弃一个本来合理的方案。',
    ],
    misreads: [
      '说话冷静、爱用数字 ≠ T。ENFJ 做公益项目管理也会说"5 个会、每 15 分钟切换一次"。',
      '共情朋友 ≠ F。ENTJ / ESTJ 也会先听朋友吐槽再分析，那是策略（要先有信息才能判断）。',
      '"怕给别人添麻烦" ≠ F。要看怕的具体是"关系受损"（F）还是"流程乱掉、下游受影响"（T）。',
      '讲了很多道理 ≠ T，可能是这个话题本身需要讲道理。',
    ],
    threshold:
      '这一维要能讲出 1–2 个具体场景才可给高分。若证据只来自"他说话听起来很理性"，一律不算证据。',
  },

  'J/P': {
    definition:
      'J：喜欢有计划、有名单、有结束感。P：开放式、临时起意、讨厌关门。',
    heart:
      '判型看结构感：他是靠"有计划、有边界、有结束"才安心，还是靠"留着口子、随时能改"才舒服。不是看整洁与否。',
    signals: [
      '一个此刻存在的可观察物：日历、待办、清单——什么状态，是真实状态还是理想状态。',
      '一次真实的临时改计划：他当时的感受，是被解放了还是被搅乱了。',
      '他对"收尾"的感受：把一件事画上句号时是轻松还是空落。',
      '他对"关门"的偏好：结束了就不想回头，还是反复惦记。',
    ],
    misreads: [
      '"看情况 / 到时候再说" ≠ P，要确认那是真实的开放态度，还是当下在敷衍你。',
      '桌面很干净、东西都归位 ≠ J，可能只是 S 对环境的偏好。',
      '临场发挥得很好 ≠ P，也可能是 T 在做临场分析。',
      '经常改主意 ≠ P，先问改完之后他是否更舒服。',
    ],
    threshold:
      '这一维要能讲出 1–2 个具体场景才可给高分。J 与 P 的判据必须落在"结构感与结束感"上，不能落在"是否守计划"这个行为表象上。',
  },
};

export function getLens(dimension) {
  return LENS[dimension] || null;
}

/** 该维度在报告里的人类可读名。 */
export function dimensionLabel(dimension) {
  const found = DIMENSION_ORDER.find((d) => d.key === dimension);
  return found ? `${dimension.key} · ${found.label}` : dimension;
}

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

/** 渲染作答块。 */
function renderAnswersBlock(answers) {
  return answers
    .map((answer, index) => {
      const text = String(answer.text ?? '').trim() || '（本题未作答）';
      return `### 第 ${index + 1} 题 · ${answer.itemId}\n${text}`;
    })
    .join('\n\n');
}

const SCORE_SCHEMA = `{
  "dimension": "E/I",
  "lean": "E | I | ambiguous",
  "score": 0.0,
  "confidence": 0.0,
  "evidence": [
    { "itemId": "EI-01", "quote": "作答中一段连续原文，逐字照抄", "signal": "哪一句支撑该倾向", "strength": "strong | weak" }
  ],
  "counterEvidence": [
    { "itemId": "EI-03", "quote": "…", "signal": "…", "strength": "strong | weak" }
  ],
  "misreadChecks": ["本维易误读项 → 本次是否命中，未命中也要写明"],
  "missing": ["证据不足的题号"],
  "note": "一两句话说明"
}`;

const FINAL_SCHEMA = `{
  "type": "INTJ",
  "typeConfidence": 0.0,
  "dimensions": [
    { "dimension": "E/I", "lean": "I", "score": 0.0, "confidence": 0.0, "rationale": "一两句话" }
  ],
  "biography": {
    "title": "给小传的标题",
    "paragraphs": ["第一段，含「引文」", "第二段，含「引文」", "第三段，含「引文」"],
    "closing": "结尾一段"
  },
  "caveats": ["证据边界说明"],
  "evidenceMap": [
    { "dimension": "E/I", "itemId": "EI-01", "quote": "逐字照抄输入中出现的引文" }
  ]
}`;

/**
 * 构造 /api/score 的 system / user 消息。
 * @param {{dimension:string, items:Array, answers:Array}} params
 */
export function buildScoreMessages({ dimension, items, answers }) {
  const lens = getLens(dimension);
  if (!lens) throw new Error(`未知维度：${dimension}`);
  const meta = DIMENSION_ORDER.find((d) => d.key === dimension);
  const poles = meta ? meta.poles : [];

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
    renderItemsBlock(dimension, items),
    '',
    '【硬性规则】',
    '1. 只依据受测者的原话作答。每条 evidence 的 quote 必须是该题作答中的一段连续原文，逐字照抄；不得改写、不得拼接两处、不得翻译、不得省略、不得补字。',
    '2. 不得编造作答里没有出现的内容。找不到支撑就把该题号写进 missing。',
    `3. score 只在本维度内归一化。计分轴固定为 ${poles[0]} → ${poles[1]}：0 表示完全倒向 ${poles[0]}，1 表示完全倒向 ${poles[1]}，0.5 表示中性。若无法判定倾向，lean 填 ambiguous、score 填 0.5。`,
    '4. confidence 衡量的是证据充分度，不是你的自信程度。证据少、证据弱、场景不具体时必须给低分。',
    '5. counterEvidence 填与结论相反的证据；没有就留空数组。',
    '6. 禁止使用泛化赞美，禁止"你是一个…的人"这类盖章句。',
    '7. 所有说明性文字（signal、note、misreadChecks、missing）一律用中文书写；除受测者原话里本来就有的英文外，不要在中文里夹用英文单词。',
    '',
    '【输出格式】',
    '严格输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：',
    SCORE_SCHEMA,
  ].join('\n');

  const user = [
    `以下是受测者在「${dimension}」维度下的作答原文。请严格按 system 中的规则评分。`,
    '',
    renderAnswersBlock(answers),
  ].join('\n');

  return { system, user };
}

/**
 * 构造 /api/finalize 的 system / user 消息。
 * @param {{dimensionResults:Array}} params
 */
export function buildFinalizeMessages({ dimensionResults }) {
  const system = [
    '你是一个心理测量报告合成助手。你将收到四个维度的判型结果（每条都带受测者原话引文）。',
    '',
    '【计分轴】',
    ...DIMENSION_ORDER.map((d) => `  ${d.key}：0 = ${d.poles[0]}，1 = ${d.poles[1]}`),
    '',
    '【硬性规则】',
    '1. type 必须是 4 个字母，顺序固定为 E/I、S/N、T/F、J/P，每一位只能取该维度的两个极值之一。',
    '2. evidenceMap 里的 quote 只能逐字复制输入中出现过的引文，不得改写或新造。',
    '3. 人物小传 biography.paragraphs 必须正好 3 段，并且：',
    '   - 每段至少包含一处用「」包住的引文，且该引文逐字出现在输入的证据引文中；',
    '   - 至少有一段要写出证据薄弱、彼此矛盾或随情境变化的地方——诚实，不是讨好；',
    '   - 不得出现"你是一个…的人""你天生…""你总是…"这类盖章句；',
    '   - 不得编造输入里没有的经历、事件或特质；',
    '   - 不得断言"这是诊断""准确无误"。',
    '4. caveats 至少 1 条，说明本次画像的证据边界（例如某维证据不足、某题作答过短）。',
    '5. dimensions 数组必须正好 4 条，每条对应一个维度，rationale 里可以引用引文。',
    '6. dimensions 里的 lean 必须沿用输入的判型结论。只有当输入该维度为 ambiguous 时才允许做微弱裁决，且必须在 rationale 里写明这是裁决而非确证。',
    '7. 所有说明性文字一律用中文书写；除受测者原话里本来就有的英文外，不要在中文里夹用英文单词。',
    '',
    '【输出格式】',
    '严格输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：',
    FINAL_SCHEMA,
  ].join('\n');

  const user = [
    '以下是四个维度的判型结果。请据此合成最终画像。',
    '',
    JSON.stringify(dimensionResults, null, 2),
  ].join('\n');

  return { system, user };
}

/** 重生成小传时的补充指令（首轮校验不通过时追加）。 */
export function buildFinalizeRetryMessages({ dimensionResults, problems }) {
  const base = buildFinalizeMessages({ dimensionResults });
  return {
    system: `${base.system}\n\n【上次输出的问题】\n${problems}\n请修正后重新输出完整 JSON。`,
    user: base.user,
  };
}
