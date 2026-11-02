/**
 * 引文校验与降级。
 *
 * 核心思想：模型说的"证据"必须能在受测者原话里逐字找到。
 * 找不到就丢弃该条证据并下调置信度；一条都找不到就把该维判为 ambiguous。
 */

import { DIMENSION_ORDER } from './prompts.js';

/** 全角转半角、去零宽字符、引号归一、空白折叠。两侧同样处理，因此对称。 */
export function normalizeText(value) {
  let out = String(value ?? '');
  out = out.replace(/[\u200b-\u200d\ufeff]/g, '');
  out = out.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  out = out.replace(/\u3000/g, ' ');
  out = out.replace(/[\u2018\u2019]/g, "'");
  out = out.replace(/[\u201c\u201d\u300c\u300d]/g, '"');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** 引文是否命中原文。规范化后子串匹配，不做模糊匹配。 */
export function quoteMatches(quote, text) {
  const q = normalizeText(quote);
  const t = normalizeText(text);
  if (q.length < 4) return false;
  return t.includes(q);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const LEAN_VALUES = ['E', 'I', 'S', 'N', 'T', 'F', 'J', 'P'];

/**
 * 校验 /api/score 的返回。
 * @param {object} raw 模型原始输出
 * @param {Array<{itemId:string,text:string}>} answers 本维度的作答
 */
export function validateScore(raw, answers, { poles = [] } = {}) {
  const answerMap = new Map((answers || []).map((a) => [String(a.itemId), String(a.text ?? '')]));
  const dropped = [];

  const keep = (list) => {
    if (!Array.isArray(list)) return [];
    const kept = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const itemId = String(entry.itemId ?? '');
      const quote = String(entry.quote ?? '');
      if (!answerMap.has(itemId)) {
        dropped.push({ itemId, reason: 'unknown-item' });
        continue;
      }
      if (!quoteMatches(quote, answerMap.get(itemId))) {
        dropped.push({ itemId, reason: 'quote-not-found' });
        continue;
      }
      kept.push({
        itemId,
        quote,
        signal: String(entry.signal ?? ''),
        strength: entry.strength === 'weak' ? 'weak' : 'strong',
      });
    }
    return kept;
  };

  const evidence = keep(raw?.evidence);
  const counterEvidence = keep(raw?.counterEvidence);

  let confidence = clamp01(raw?.confidence);
  if (dropped.length) confidence = Math.max(0, confidence - 0.08 * dropped.length);

  let lean = LEAN_VALUES.includes(raw?.lean) ? raw.lean : 'ambiguous';
  let score = clamp01(raw?.score);

  if (evidence.length === 0) {
    lean = 'ambiguous';
    score = 0.5;
    confidence = Math.min(confidence, 0.35);
  } else if (evidence.every((e) => e.strength === 'weak')) {
    confidence = Math.min(confidence, 0.45);
  }

  // 方向自洽：模型可能采用相反的轴约定（例如把 E 当作 1）。这里按 lean 校正，
  // 保证 score 恒为「0 = 第一极、1 = 第二极」。
  const [poleA, poleB] = Array.isArray(poles) ? poles : [];
  if (lean !== 'ambiguous' && poleA && poleB) {
    if (lean === poleA && score > 0.5) score = 1 - score;
    else if (lean === poleB && score < 0.5) score = 1 - score;
  }
  if (lean === 'ambiguous') score = 0.5;

  return {
    dimension: String(raw?.dimension ?? ''),
    lean,
    score,
    strength: score,
    axis: { from: poleA || '', to: poleB || '' },
    confidence,
    evidence,
    counterEvidence,
    misreadChecks: Array.isArray(raw?.misreadChecks) ? raw.misreadChecks.map(String).slice(0, 12) : [],
    missing: Array.isArray(raw?.missing) ? raw.missing.map(String).slice(0, 12) : [],
    note: String(raw?.note ?? ''),
    validation: {
      keptEvidence: evidence.length,
      keptCounterEvidence: counterEvidence.length,
      dropped,
    },
  };
}

/** 汇总所有维度里已通过校验的引文。 */
export function collectValidatedQuotes(dimensionResults) {
  const seen = new Set();
  const list = [];
  for (const result of dimensionResults || []) {
    for (const entry of [...(result.evidence || []), ...(result.counterEvidence || [])]) {
      if (entry && typeof entry.quote === 'string') {
        const normalized = normalizeText(entry.quote);
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized);
          list.push(normalized);
        }
      }
    }
  }
  return list;
}

/** 去掉首尾的标点与空白，避免句末句号差异导致匹配失败。 */
function stripEdgePunctuation(value) {
  return String(value ?? '')
    .replace(/^[\s\p{P}]+/u, '')
    .replace(/[\s\p{P}]+$/u, '');
}

/**
 * 引文片段是否可溯源。
 *
 * 必须是已校验引文的**连续子串**（忽略首尾标点差异）——
 * 比"完全相等"宽容：模型常把句号包进引号内，或只引长句中的一段；
 * 但仍然拒绝模型自己改写、拼接或杜撰的内容。
 */
export function quoteTraceable(fragment, validatedQuotes) {
  const f = stripEdgePunctuation(normalizeText(fragment));
  if (f.length < 4) return false;

  for (const quote of validatedQuotes || []) {
    const q = stripEdgePunctuation(normalizeText(quote));
    if (q.length < 4) continue;
    if (q === f) return true;
    // 片段是已校验引文的连续一段：要求有足够长度，避免用两三个字敷衍过关
    if (f.length >= 6 && q.includes(f)) return true;
  }
  return false;
}

/** 取出段落里用「」“”""包住的引文片段。 */
export function extractQuotedFragments(text) {
  const out = [];
  const re = /[「“"]([^「」“”"]{1,})[」”"]/g;
  let match;
  while ((match = re.exec(String(text ?? ''))) !== null) {
    out.push(match[1]);
  }
  return out;
}

/**
 * 校验 /api/finalize 的返回。
 * 引证表只保留确实来自上游已校验引文的条目；
 * 小传段落若没有至少一处可溯源引文，记为无效段落。
 */
export function validateFinalize(raw, dimensionResults, { polesByDimension = {} } = {}) {
  const allowed = collectValidatedQuotes(dimensionResults);

  const evidenceMap = (Array.isArray(raw?.evidenceMap) ? raw.evidenceMap : [])
    .filter((entry) => entry && typeof entry.quote === 'string')
    .filter((entry) => quoteTraceable(entry.quote, allowed))
    .map((entry) => ({
      dimension: String(entry.dimension ?? ''),
      itemId: String(entry.itemId ?? ''),
      quote: String(entry.quote),
    }));

  const paragraphs = Array.isArray(raw?.biography?.paragraphs)
    ? raw.biography.paragraphs.map(String).filter((p) => p.trim())
    : [];

  const invalidParagraphs = [];
  paragraphs.forEach((paragraph, index) => {
    const fragments = extractQuotedFragments(paragraph);
    const grounded = fragments.some((fragment) => quoteTraceable(fragment, allowed));
    if (!grounded) invalidParagraphs.push(index);
  });

  const type = String(raw?.type ?? '').toUpperCase();
  const modelType = /^[EISNTFJP]{4}$/.test(type) ? type : '';

  const dimensions = (Array.isArray(raw?.dimensions)
    ? raw.dimensions
    : []).map((dim) => {
      const key = String(dim?.dimension ?? '');
      const [poleA, poleB] = polesByDimension[key] || [];
      const lean = String(dim?.lean ?? '');
      let score = clamp01(dim?.score);
      if (lean !== 'ambiguous' && poleA && poleB) {
        if (lean === poleA && score > 0.5) score = 1 - score;
        else if (lean === poleB && score < 0.5) score = 1 - score;
      }
      if (lean === 'ambiguous') score = 0.5;
      return {
        ...dim,
        dimension: key,
        lean,
        score,
        strength: score,
        axis: { from: poleA || '', to: poleB || '' },
      };
    });

  // 类型字母一律由逐维倾向拼出，不采信模型单写的 type 字符串。
  // 实测出现过 dimensions 给出 E/N/T/J、type 却写成 ESTJ 的情况，
  // 若直接展示 type 就会和同一页的四维读数自相矛盾。
  // 取值优先级：单维判型结论 → 汇总阶段的逐维结论 → 模型写的字母（必须属于本维度两极）。
  const upstreamByDim = new Map((dimensionResults || []).map((r) => [String(r?.dimension ?? ''), r]));
  const finalByDim = new Map(dimensions.map((d) => [d.dimension, d]));

  const typeLetters = [];
  const typeLetterSources = [];
  DIMENSION_ORDER.forEach((meta, index) => {
    const key = meta.key;
    const [poleA, poleB] = polesByDimension[key] || meta.poles || [];
    const isPole = (value) => value === poleA || value === poleB;

    const upstream = upstreamByDim.get(key);
    if (upstream && isPole(upstream.lean)) {
      typeLetters.push(upstream.lean);
      typeLetterSources.push('upstream');
      return;
    }
    const finalDim = finalByDim.get(key);
    if (finalDim && isPole(finalDim.lean)) {
      typeLetters.push(finalDim.lean);
      typeLetterSources.push('finalize');
      return;
    }
    // 逐维都定不出时，才退到模型写的字母，且必须属于本维度两极。
    const fromModel = modelType[index] || '';
    if (isPole(fromModel)) {
      typeLetters.push(fromModel);
      typeLetterSources.push('model');
      return;
    }
    typeLetters.push(poleA || '');
    typeLetterSources.push('fallback');
  });

  const derivedType = typeLetters.join('');
  const typeMismatch = Boolean(modelType) && modelType !== derivedType;

  let typeConfidence = clamp01(raw?.typeConfidence);
  // 字母是猜出来的，整体置信度必须相应压低。
  if (typeLetterSources.includes('model')) typeConfidence = Math.min(typeConfidence, 0.5);
  if (typeLetterSources.includes('fallback')) typeConfidence = Math.min(typeConfidence, 0.35);

  return {
    type: /^[EISNTFJP]{4}$/.test(derivedType) ? derivedType : '',
    typeConfidence,
    typeLetters,
    dimensions,
    biography: {
      title: String(raw?.biography?.title ?? ''),
      paragraphs,
      closing: String(raw?.biography?.closing ?? ''),
      degraded: Boolean(raw?.biography?.degraded),
    },
    caveats: Array.isArray(raw?.caveats) ? raw.caveats.map(String).slice(0, 8) : [],
    evidenceMap,
    validation: {
      evidenceMapCount: evidenceMap.length,
      paragraphCount: paragraphs.length,
      invalidParagraphs,
      biographyValid: paragraphs.length > 0 && invalidParagraphs.length === 0,
      modelType,
      typeMismatch,
      typeLetterSources,
    },
  };
}

/** 小传校验不过时的保守版本：只拼原话，不做叙述。 */
export function degradeBiography(dimensionResults) {
  const lines = [];
  for (const result of dimensionResults || []) {
    const quotes = (result.evidence || []).slice(0, 2).map((e) => e.quote);
    if (!quotes.length) continue;
    let line = `${result.dimension}：你写道「${quotes[0]}」`;
    if (quotes[1]) line += `，以及「${quotes[1]}」`;
    lines.push(line);
  }
  if (!lines.length) {
    lines.push('本次作答没有产出通过引文校验的证据片段，因此不生成叙述性小传。');
  }
  return {
    title: '本次作答的原话切片',
    paragraphs: lines,
    closing: '本次分析未生成叙述性小传（引文校验未通过）。以上仅列出通过校验的原话片段，结论请自行判断。',
    degraded: true,
  };
}
