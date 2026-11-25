// 答疑库 N 路合并（2026-11-25 多协作改造 P2）
//
// ## 解决什么
//
// 合并的输入不再是「仓库 ⇄ 运行」两边，而是 **N 路**：
//
//   ① GitHub main         别人合过的
//   ② GitHub contrib/*    各人免 PR 直提的
//   ③ 本地运行副本         守护进程自动沉淀
//   ④ 本地真源             手上正在改的
//
// ## 两条合并轴
//
// **轴一：条目身份** —— 同一条目认出来
//   稳定 id（优先） → 来源链接 → 问法（兜底）
//
// **轴二：要点语义** —— 同一问题下的要点认出来
//   先字面（BM25 + Dice）筛候选 → LLM 判 sameQuestion/sameConclusion → 否决闸（数字/实体不同不合并）
//   判同义 → 并入来源、重算置信度（**不覆盖原要点**）
//   判异义 → 作为补充要点新增
//   判矛盾 → 两者都留，标 conflict
//
// ## 裁决规则（大哥 2026-11-25 定：按条目性质分流）
//
//   自动沉淀条目（有 source）→ updated 新的赢，旧的进归档
//   人工条目（无 source）    → 正文取长 + 关键词并集，冲突写报告待复核
//
// ## 幂等
//
// 合并是「按 id + claim 语义」的集合运算，同一份输入跑两次结果相同 ——
// 所以每日定时任务重复触发、重启补跑，都不会灌重复内容。

import { aggregateClaimConfidence, confLabelOf } from './qa-entry.mjs';
import { tokenize } from './qa-vector.mjs';

// ── 相似度工具 ──

/** Dice 系数（两个集合的交集占比） */
export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 归一化问句（去标点空白、小写） */
export function normQuestion(q) {
  return String(q || '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 抽关键数字（关卡号/钻数/阶数等）—— 否决闸用 */
export function keyNumbers(q) {
  const nums = new Set();
  for (const m of String(q || '').matchAll(/\d+/g)) nums.add(String(Number(m[0])));
  return nums;
}

/** 两句有没有「关键数字冲突」 */
export function numbersConflict(a, b) {
  const na = keyNumbers(a);
  const nb = keyNumbers(b);
  if (!na.size || !nb.size) return false;
  for (const x of na) if (!nb.has(x)) return true;
  return false;
}

/** 要点字面相似度（Dice on bigram） */
export function claimSimilarity(a, b) {
  const ta = String(a || '');
  const tb = String(b || '');
  if (!ta || !tb) return 0;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  return dice(bigrams(ta), bigrams(tb));
}

/** 语义候选筛选：字面相似度低的直接排除，省 LLM 调用 */
export function claimCandidates(text, claims, { threshold = 0.45, limit = 5 } = {}) {
  const out = [];
  for (const c of claims || []) {
    const sim = claimSimilarity(text, c.text);
    if (sim >= threshold) out.push({ claim: c, sim });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}

// ── 轴一：条目身份 ──

/** 条目身份键：稳定 id 优先 → 来源 → 问法 */
export function entryKeyOf(entry) {
  if (entry?.id) return `id:${entry.id}`;
  const src = sourcesOfEntry(entry)[0];
  if (src) return `src:${src}`;
  return `q:${normQuestion(entry?.question)}`;
}

function sourcesOfEntry(entry) {
  const s = new Set();
  if (entry?.source) s.add(entry.source);
  for (const c of entry?.claims || []) for (const x of c.sources || []) if (x) s.add(x);
  return [...s];
}

/** 条目是否自动沉淀（有来源） */
export function isAutoEntry(entry) {
  return !!sourcesOfEntry(entry).length;
}

// ── 轴二：要点合并 ──

/**
 * 把 incoming 的要点并进 base 的要点列表
 *
 * @param {Array} base 要点列表
 * @param {Array} incoming 要并入的要点
 * @param {object} o
 * @param {Function} [o.sameAs] (a,b) => Promise<boolean> 语义同义判定（LLM）；不给则只按字面
 * @param {number} [o.threshold] 字面相似度门槛
 * @returns {Promise<{claims:Array, merged:number, added:number, conflicts:Array}>}
 */
export async function mergeClaims(base, incoming, { sameAs = null, threshold = 0.45 } = {}) {
  const claims = (base || []).map((c) => ({ ...c, sources: [...(c.sources || [])] }));
  let merged = 0;
  let added = 0;
  const conflicts = [];

  for (const inc of incoming || []) {
    const text = String(inc?.text || '').trim();
    if (!text) continue;
    const cands = claimCandidates(text, claims, { threshold });
    let hit = null;

    for (const c of cands) {
      // 否决闸：关键数字不同 → 不是同一条（困难6 vs 困难8）
      if (numbersConflict(text, c.claim.text)) continue;
      if (sameAs) {
        const same = await sameAs(text, c.claim.text);
        if (same) {
          hit = c.claim;
          break;
        }
      } else if (c.sim >= 0.85) {
        hit = c.claim;
        break;
      }
    }

    if (!hit) {
      // 异义 → 作为补充要点新增（**不覆盖任何已有要点**）
      claims.push({ ...inc, text, sources: [...(inc.sources || [])] });
      added++;
      continue;
    }

    // 同义 → 并入来源 + 重算置信度（原要点内容保留）
    const before = hit.sources?.length || 0;
    hit.sources = [...new Set([...(hit.sources || []), ...(inc.sources || [])])];
    hit.confidence = aggregateClaimConfidence(hit, { official: false });
    if (hit.sources.length > before) merged++;
    // 矛盾信号：来源里出现互相矛盾的关键数字 → 记冲突待人看
    if (inc.conflictWith) {
      conflicts.push({ type: 'claim-conflict', text, against: hit.text });
      hit.status = 'conflict';
    }
  }

  return { claims, merged, added, conflicts };
}

// ── N 路合并 ──

/**
 * 合并多个来源的条目
 * @param {Array<{origin:string, entries:Array}>} sources
 * @param {object} o
 * @param {Function} [o.sameClaim] 语义判定（异步）
 * @param {Function} [o.sameEntry] 同义问题判定（可选，异步）
 * @returns {Promise<{entries:Array, conflicts:Array, stats:object}>}
 */
export async function mergeMany(sources, { sameClaim = null, sameEntry = null } = {}) {
  const byKey = new Map();
  const conflicts = [];
  const stats = { added: 0, merged: 0, conflict: 0, rejected: 0, byOrigin: {} };

  for (const src of sources || []) {
    const origin = src?.origin || 'unknown';
    let nAdd = 0;
    let nMerge = 0;
    for (const entry of src?.entries || []) {
      if (!entry?.question) continue;
      let key = entryKeyOf(entry);
      let cur = byKey.get(key);

      // id 没撞但问法高度相似 → 可能是同一条（id 不同源）
      if (!cur && sameEntry) {
        const found = await findSameEntry(entry, byKey, sameEntry);
        if (found) {
          cur = found.entry;
          key = found.key;
        }
      }

      if (!cur) {
        const copy = { ...entry, claims: (entry.claims || []).map((c) => ({ ...c, sources: [...(c.sources || [])] })) };
        byKey.set(key, copy);
        nAdd++;
        continue;
      }

      // 同一条目 → 合并要点 + 裁决元数据
      // ⚠️ 性质要在**合并前**判定：合并会把自动来源并进人工条目的要点里，
      //    合并后再判就变成「自动」了，人工优先的规则会失效。
      const curWasAuto = isAutoEntry(cur);
      const incWasAuto = isAutoEntry(entry);
      const r = await mergeClaims(cur.claims, entry.claims || [], { sameAs: sameClaim });
      cur.claims = r.claims;
      nMerge += r.merged;
      if (r.added) nAdd += r.added;
      conflicts.push(...r.conflicts.map((c) => ({ ...c, entry: cur.question, origin })));

      const mergedMeta = mergeEntryMeta(cur, entry, { curAuto: curWasAuto, incAuto: incWasAuto });
      if (mergedMeta.conflict) {
        conflicts.push({ type: 'entry-conflict', entry: cur.question, origin, detail: mergedMeta.note });
        stats.conflict++;
      }
      stats.merged += r.merged;
    }
    stats.byOrigin[origin] = { added: nAdd, merged: nMerge };
    stats.added += nAdd;
  }

  return { entries: [...byKey.values()], conflicts, stats };
}

/** 找同一条目（问法相似） */
async function findSameEntry(entry, byKey, sameEntry) {
  for (const [k, v] of byKey) {
    const sim = claimSimilarity(entry.question, v.question);
    if (sim < 0.5) continue;
    if (numbersConflict(entry.question, v.question)) continue;
    const same = await sameEntry(entry.question, v.question);
    if (same) return { entry: v, key: k };
  }
  return null;
}

/**
 * 条目级元数据合并
 * 规则（大哥定：按条目性质分流）
 *   自动沉淀条目 → updated 新的赢（旧的进归档由调用方处理）
 *   人工条目     → 正文取长 + 关键词并集
 */
export function mergeEntryMeta(cur, incoming, { curAuto = null, incAuto = null } = {}) {
  const curIsAuto = curAuto == null ? isAutoEntry(cur) : curAuto;
  const incIsAuto = incAuto == null ? isAutoEntry(incoming) : incAuto;
  const notes = [];

  // 关键词：取并集（永远安全）
  cur.keywords = [...new Set([...(cur.keywords || []), ...(incoming.keywords || [])])];

  // 版本：不同版本并存提示
  if (incoming.version && incoming.version !== cur.version) {
    notes.push(`版本不同（${cur.version} vs ${incoming.version}）`);
  }

  if (curIsAuto && incIsAuto) {
    // 两个都是自动沉淀 → 时间新的赢
    const curT = String(cur.updated || '');
    const incT = String(incoming.updated || '');
    if (incT && incT > curT) {
      cur.updated = incoming.updated;
      cur.source = incoming.source || cur.source;
      notes.push('自动沉淀条目：采用了更新的那份');
    }
    return { conflict: false, note: notes.join('；') };
  }

  // 一人工一自动 → 人工优先（内容取长），不丢自动沉淀的来源
  if (!curIsAuto && incIsAuto) {
    const longer = String(incoming.answer || '').length > String(cur.answer || '').length;
    if (longer) cur.answer = incoming.answer;
    notes.push('人工条目优先：保留人工内容，并入自动沉淀来源');
    return { conflict: false, note: notes.join('；') };
  }
  if (curIsAuto && !incIsAuto) {
    const longer = String(incoming.answer || '').length > String(cur.answer || '').length;
    if (longer) cur.answer = incoming.answer;
    notes.push('人工条目优先：采用人工内容');
    return { conflict: false, note: notes.join('；') };
  }

  // 两个都是人工 → 正文取长（通常是补全过的那份）；不同则记冲突待复核
  const a = String(cur.answer || '');
  const b = String(incoming.answer || '');
  if (a !== b) {
    const longer = b.length > a.length ? b : a;
    const changed = longer !== a;
    cur.answer = longer;
    notes.push('人工条目正文不同：保留更长的那份');
    return { conflict: changed, note: notes.join('；') };
  }
  return { conflict: false, note: notes.join('；') };
}

/** 置信度档位（供上层显示） */
export { confLabelOf };
