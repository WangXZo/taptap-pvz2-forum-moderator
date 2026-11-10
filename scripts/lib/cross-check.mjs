// 交叉验证：玩家说法与「已可信」条目一致 → 复用那份可信度（用户 2026-11-06）
//
// 原话：
//   「如果玩家回答与官方一致，也视为可信（即按照已有可信程度高的保持一致的回复，复用其可信度）。」
//   「如果与已有答疑重复，也复用其可信度。」
//   ⚠️「上述说的，一致，与重复，是对话含义与内容，并非文字。」
//
// 所以判定必须看**含义**：
//   ① 主判定用 LLM —— 问「这两段是不是同一件事 / 同一个结论」
//   ② dice 只做两件事：**粗筛候选**（减少 LLM 输入）、以及 LLM 不可用时的降级兜底
//      （降级时 crossNote 会标明「文字相似度（降级）」）

import { chat } from './llm.mjs';

/**
 * 字符二元组 Dice 相似度（0~1）
 * @param {string} a
 * @param {string} b
 */
export function dice(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i + 2 <= s.length; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(x);
  const B = grams(y);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    inter += Math.min(n, B.get(g) || 0);
  }
  for (const n of B.values()) total += n;
  if (!total) return 0;
  return (2 * inter) / total;
}

/** 默认阈值：太松会把「沾点边」也当一致，太紧抓不到换说法的同一件事 */
export const MATCH_THRESHOLD = 0.45;

/** 视为「可信」的门槛（百分比） */
export const TRUSTED_MIN = 90;

/**
 * 找「重复问题」—— 问法高度相似就认为是同一件事
 *
 * 用户 2026-11-06：「如果与已有答疑重复，也复用其可信度。」
 * 重复的条目没必要重新判可信度，直接沿用已有的（哪怕它只有 50%）。
 *
 * @param {object} o
 * @param {string} o.question
 * @param {Array}  o.known
 * @param {number} [o.threshold] 问法相似度门槛（默认 0.6，比答案一致更严）
 * @returns {{matched:object|null, score:number}}
 */
export function findDuplicate({ question = '', known = [], threshold = 0.6 } = {}) {
  const q = String(question || '').trim();
  if (q.length < 4) return { matched: null, score: 0 };
  let best = { matched: null, score: 0 };
  for (const k of known || []) {
    const kq = String(k?.question || '');
    if (kq.length < 4) continue;
    const score = dice(q, kq);
    if (score > best.score) best = { matched: k, score };
  }
  return best.score >= threshold ? best : { matched: null, score: best.score };
}

/**
 * 用 LLM 做**语义**判定：新条目 vs 候选，是同一问题？是同一结论？
 *
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.entry   {question, answer, confidence}
 * @param {Array}  o.cands   候选（已粗筛，≤3 条）
 * @param {Function} [o.log]
 * @returns {Promise<{dup:object|null, same:object|null, how:string}>}
 */
async function judgeByLLM({ config, entry, cands = [], log = () => {} }) {
  if (!cands.length) return { dup: null, same: null, how: 'none' };
  const list = cands
    .map((c, i) => `[${i + 1}] 问：${String(c.question || '').slice(0, 60)}\n    答：${String(c.answer || '').slice(0, 160)}`)
    .join('\n');
  const sys =
    '你是中文语义判重器。只看**含义**，不要看字面用词是否一样。' +
    '「同一问题」= 玩家想知道的其实是同一件事（换个说法、换个数量的也算）。' +
    '「同一结论」= 关键结论一致（例如都说"每阶+50%"，或都说"某植物没用"）。' +
    '只输出 JSON，不要解释：{"sameQuestion":[编号],"sameConclusion":[编号]}';
  const user = `新条目：\n问：${String(entry.question || '').slice(0, 60)}\n答：${String(entry.answer || '').slice(0, 200)}\n\n候选：\n${list}`;
  const r = await chat(config, { system: sys, messages: [{ role: 'user', content: user }], temperature: 0, maxTokens: 200, log });
  if (!r.ok) return { dup: null, same: null, how: 'llm_failed' };
  try {
    const m = String(r.text || '').match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : '{}');
    const pick = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((n) => Number(n) - 1)
        .filter((i) => i >= 0 && i < cands.length)[0];
    const dupIdx = pick(j.sameQuestion);
    const sameIdx = pick(j.sameConclusion);
    return {
      dup: dupIdx == null ? null : cands[dupIdx],
      same: sameIdx == null ? null : cands[sameIdx],
      how: 'llm',
    };
  } catch {
    return { dup: null, same: null, how: 'parse_failed' };
  }
}

/**
 * 精修可信度（语义版）：重复 → 沿用；与可信条目结论一致 → 提到可信
 *
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.entry     buildQaEntry 的产物（会读/写 confidence）
 * @param {Array}  o.known     现有答疑库条目
 * @param {Function} [o.log]
 * @returns {Promise<{confidence:number, note:string, how:string}>}
 */
export async function refineConfidence({ config = {}, entry = {}, known = [], log = () => {} } = {}) {
  const base = Number(entry?.confidence);
  let confidence = Number.isFinite(base) ? base : 50;
  if (!known.length) return { confidence, note: '', how: 'no_known' };

  // ① 粗筛候选：问题或答案沾边的 top3（只用于减少 LLM 输入，不参与判定）
  const scored = known
    .map((k) => ({
      k,
      s: Math.max(dice(entry.question, k.question), dice(entry.answer, k.answer)),
    }))
    .filter((x) => x.s >= 0.15)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.k);

  if (!scored.length) return { confidence, note: '', how: 'no_candidate' };

  const j = await judgeByLLM({ config, entry, cands: scored, log });

  if (j.how !== 'llm') {
    // 降级：文字相似度兜底（标明来源，别假装是语义判断）
    const cc = crossCheckConfidence({ answer: entry.answer, known: scored });
    if (cc.confidence != null) {
      return {
        confidence: cc.confidence,
        note: `文字相似度 ${cc.score.toFixed(2)}（LLM 不可用，降级判定）`,
        how: 'fallback_dice',
      };
    }
    return { confidence, note: '', how: 'fallback_none' };
  }

  // ② 语义重复 → 沿用它的可信度
  if (j.dup) {
    const c = Number(j.dup.confidence);
    return {
      confidence: Number.isFinite(c) ? c : confidence,
      note: `与已有条目语义重复 → 沿用其可信度（${String(j.dup.question).slice(0, 24)}）`,
      how: 'llm_dup',
    };
  }
  // ③ 语义结论一致 + 那条可信 → 提为可信
  if (j.same && Number(j.same.confidence) >= TRUSTED_MIN) {
    return {
      confidence: Number(j.same.confidence),
      note: `结论与可信条目一致 → 复用其可信度（${String(j.same.question).slice(0, 24)}）`,
      how: 'llm_same',
    };
  }
  return { confidence, note: '', how: 'llm_no_match' };
}

/**
 * 文字相似度兜底（**不是主判定**）：只在 LLM 不可用时用，结果里会标明「降级」。
 *
 * @param {object} o
 * @param {string} o.answer
 * @param {Array}  o.known            现有答疑库条目（{question, answer, confidence, source}）
 * @param {number} [o.threshold]
 * @returns {{confidence:number|null, matched:object|null, score:number}}
 */
export function crossCheckConfidence({ answer = '', known = [], threshold = MATCH_THRESHOLD } = {}) {
  const text = String(answer || '').trim();
  if (text.length < 8) return { confidence: null, matched: null, score: 0 };

  let best = { confidence: null, matched: null, score: 0 };
  for (const k of known || []) {
    const conf = Number(k?.confidence);
    if (!Number.isFinite(conf) || conf < TRUSTED_MIN) continue; // 只看已可信的
    const base = String(k?.answer || '');
    if (base.length < 8) continue;
    const score = dice(text, base);
    if (score > best.score) best = { confidence: conf, matched: k, score };
  }
  if (best.score >= threshold) return best;
  return { confidence: null, matched: null, score: best.score };
}