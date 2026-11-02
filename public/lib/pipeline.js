/**
 * 判型流程 —— 服务端与浏览器共用的唯一实现。
 *
 * 本地模式由 server.mjs 调用它；GitHub Pages 静态部署时由浏览器直接调用它。
 * 两条路径共用同一份提示词与校验规则，因此不会出现"本地结果与线上结果不一致"。
 *
 * 本模块只依赖同目录下的 prompts / validate / llm，不含任何 Node 专属 API，
 * 可以在浏览器里原样 import。
 */

import {
  DIMENSION_ORDER,
  buildScoreMessages,
  buildFinalizeMessages,
  buildFinalizeRetryMessages,
} from './prompts.js';
import { validateScore, validateFinalize, degradeBiography } from './validate.js';

export { DIMENSION_ORDER };

/** 各维度的两极，键为 E/I、S/N、T/F、J/P。 */
export function polesByDimension() {
  return Object.fromEntries(DIMENSION_ORDER.map((d) => [d.key, d.poles]));
}

/**
 * 单维判型：调用模型 → 逐条校验引文 → 返回本维度结果。
 *
 * @param {object} params
 * @param {string} params.dimension
 * @param {Array<{itemId:string,text:string}>} params.answers
 * @param {Array} params.items 本维度全部题目（含锚点与误读防护）
 * @param {{call:Function}} params.client
 */
export async function scoreDimension({ dimension, answers, items, client }) {
  const { system, user } = buildScoreMessages({ dimension, items, answers });
  const raw = await client.call({ system, user, temperature: 0.2, maxTokens: 3000 });
  const poles = DIMENSION_ORDER.find((d) => d.key === dimension)?.poles || [];
  return validateScore(raw, answers, { poles });
}

/**
 * 合成最终画像：调用模型 → 校验引文与小传 → 不合格则重生成一次 → 仍不合格则降级。
 *
 * @param {object} params
 * @param {Array} params.dimensionResults 四维判型结果
 * @param {{call:Function}} params.client
 * @param {(message:string)=>void} [params.onNote] 过程提示（服务端写日志，浏览器写控制台）
 */
export async function finalizeReport({ dimensionResults, client, onNote = () => {} }) {
  const poles = polesByDimension();

  let raw = await client.call({
    ...buildFinalizeMessages({ dimensionResults }),
    temperature: 0.4,
    maxTokens: 6000,
  });

  let validated = validateFinalize(raw, dimensionResults, { polesByDimension: poles });
  reportTypeMismatch(validated, onNote);

  if (!validated.validation.biographyValid || !validated.type) {
    const problems = [
      validated.validation.invalidParagraphs.length
        ? `第 ${validated.validation.invalidParagraphs.map((i) => i + 1).join('、')} 段没有可溯源的引文`
        : '小传段落为空',
      validated.type ? '' : 'type 不是合法的四字母组合',
    ].filter(Boolean).join('；');

    onNote(`finalize 首轮未通过校验：${problems}，重新生成一次`);

    raw = await client.call({
      ...buildFinalizeRetryMessages({ dimensionResults, problems }),
      temperature: 0.4,
      maxTokens: 6000,
    });
    validated = validateFinalize(raw, dimensionResults, { polesByDimension: poles });
    reportTypeMismatch(validated, onNote);
  }

  if (!validated.validation.biographyValid) {
    validated.biography = degradeBiography(dimensionResults);
  }

  if (!validated.type) {
    // 最后的兜底：按维度顺序用单维结论拼出类型，并如实压低置信度。
    validated.type = DIMENSION_ORDER.map((d) => {
      const hit = (dimensionResults || []).find((r) => r?.dimension === d.key);
      const lean = hit && hit.lean !== 'ambiguous' ? hit.lean : '';
      return d.poles.includes(lean) ? lean : d.poles[0];
    }).join('');
    validated.typeConfidence = Math.min(validated.typeConfidence, 0.35);
  }

  return validated;
}

/**
 * 类型字母由逐维倾向拼出。模型自己写的 type 字符串与逐维结论打架时，
 * 以逐维结论为准，并留下一条说明这里被更正过。
 */
function reportTypeMismatch(validated, onNote) {
  if (!validated?.validation?.typeMismatch) return;
  onNote(
    `模型写的 type（${validated.validation.modelType}）与逐维倾向不一致，`
      + `已按逐维结论更正为 ${validated.type}`,
  );
}
