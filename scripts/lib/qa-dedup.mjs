// QA 语义近重复合并（O3，2026-11-18）：把「同义不同说法」合成一条，其余归档。
//
// 为什么不能只看字面相似：不同关卡/不同植物的问法字面极像但语义不同
//   「困难6怎么过」vs「困难8怎么过」= 高相似 → 合并即误伤。
// 所以两道闸：
//   ① 相似度阈值（默认 0.94，高于原设 0.9）
//   ② **否决闸**：两条的关键数字不同（关卡号/钻数/阶数）或实体不同 → 不合并
import { bm25Scores } from './bm25.mjs';
import { tokenize } from './qa-vector.mjs';

/** 归一化问句：去标点空白、小写；用于快速完全重复判定 */
export function normQuestion(q) {
  return String(q || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 抽关键数字（关卡号/钻数/阶数/天数等）—— 否决闸用 */
export function keyNumbers(q) {
  const nums = new Set();
  for (const m of String(q || '').matchAll(/\d+/g)) nums.add(String(Number(m[0])));
  return nums;
}

/** 与另一组数字是否冲突：两边都有数字且没有一个共同数字 → 冲突（6 vs 8） */
export function numbersConflict(a, b) {
  if (!a.size || !b.size) return false;
  for (const x of a) if (b.has(x)) return false; // 有共同数字 → 不冲突（如都提 688）
  return true;
}

/** 同义问法相似度：token 集合**包含度**（双向取大）。
 *  不用 qa-vector 的 coverage：它的分母取整条 qvec，但命中只遍历较小向量（短问法被包含时会被压小）。
 *  也不单用 Dice：长问法包含短问法时 Dice 只有 0.8 左右，抓不到「同义不同长度」。
 *  包含度语义：一边的要素是否被另一边全覆盖 —— 正是「同一种问法」的判据（数字冲突另有否决闸）。 */
function tokenSet(text) {
  return new Set(tokenize(String(text || '')));
}
export function containment(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  const c1 = hit / A.size;
  let hit2 = 0;
  for (const t of B) if (A.has(t)) hit2++;
  return Math.max(c1, hit2 / B.size);
}
function similarity(a, b) {
  return containment(a, b);
}

/**
 * 找近重复组。
 * @param {Array<{id,question,answer}>} entries
 * @param {object} o
 * @param {number} [o.threshold=0.94]
 * @param {Function} [o.citedOf] (id)=>引用次数（决定留谁）
 * @param {Function} [o.entityOf] (entry)=>实体名（可注入；默认用关键词首个）
 * @returns {{groups:Array<{keep:object, drop:Array<object>, similarity:number}>, pairs:number}}
 */
export function findNearDuplicates(entries = [], { threshold = 0.94, citedOf = () => 0 } = {}) {
  const list = (entries || []).filter((e) => e && e.question);
  const groups = [];
  const used = new Set();
  let pairs = 0;

  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const a = list[i];
    const na = normQuestion(a.question);
    const numsA = keyNumbers(a.question);
    const dup = [];
    let best = 0;
    for (let j = i + 1; j < list.length; j++) {
      if (used.has(j)) continue;
      const b = list[j];
      const nb = normQuestion(b.question);
      // 完全同文（归一化后）→ 必合并
      if (na && na === nb) {
        used.add(j);
        dup.push(b);
        best = Math.max(best, 1);
        pairs++;
        continue;
      }
      // 否决闸：关键数字冲突 → 不合并（困难6 vs 困难8）
      if (numbersConflict(numsA, keyNumbers(b.question))) continue;
      // 长度差太大 → 不是同一问法
      const la = na.length, lb = nb.length;
      if (Math.min(la, lb) / Math.max(la, lb) < 0.5) continue;
      // 否决闸：**极短标题不做合并**（<4 字）。
      //   2026-11-18 dry-run 实测：《无尽》(2) 被《摇滚无尽》(4) 包含 → containment=1，
      //   差点把专指合并进泛称（方向反了）。极短标题多是泛实体/单名词，不能作为合并主体。
      if (Math.min(la, lb) < 4) continue;
      const sim = similarity(a.question, b.question);
      if (sim >= threshold) {
        used.add(j);
        dup.push(b);
        best = Math.max(best, sim);
        pairs++;
      }
    }
    if (dup.length) {
      // 留 cited 高者（原条目 a 若无引用而某条 drop 有引用 → 换留）
      let keep = a;
      for (const d of dup) {
        if (Number(citedOf(d.id) || 0) > Number(citedOf(keep.id) || 0)) keep = d;
      }
      const drop = [a, ...dup].filter((x) => x !== keep);
      groups.push({ keep, drop, similarity: Number(best.toFixed(3)) });
    }
  }
  return { groups, pairs };
}

/**
 * 生成合并后的条目：保留者正文追加「同义问法」（提升召回），关键词合并去重。
 * @returns {object} 新条目（不改原对象）
 */
export function mergeInto(keep, drops = []) {
  const aliases = drops.map((d) => String(d.question || '').trim()).filter(Boolean);
  const kw = new Set([...(keep.keywords || [])]);
  for (const d of drops) for (const k of d.keywords || []) kw.add(k);
  const aliasLine = aliases.length ? `\n\n（同义问法：${aliases.join('；')}）` : '';
  return {
    ...keep,
    keywords: [...kw],
    answer: String(keep.answer || '').trim() + aliasLine,
    mergedFrom: aliases,
  };
}