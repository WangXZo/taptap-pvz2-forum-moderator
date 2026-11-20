// C6 结构化上下文组装（2026-11-17 P2）：替换抽取式 top2 句（condenseMaterial）。
// = facts.attrs 全保留（数值/条件/例外）+ 问答层结构化摘要 + provenance+置信度；多候选合成；
// 长知识结构化摘要（不硬截 140 字：条件/数值句优先保留）；总预算裁剪（保 facts、保高相关）。
import { listFacts } from './facts.mjs';
import { confLabelOf } from './qa.mjs';

// 条件/例外/数值句标记：这些句子宁可超预算也要保（丢条件=误答根源）
const COND = /但|例外|如果|若|仅|只|除非|需要|条件|期间|活动|注意|\d/;

function grams(q) {
  const g = new Set();
  for (const m of String(q || '').matchAll(/[一-龥]{2}/g)) g.add(m[0]);
  for (const m of String(q || '').matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) g.add(m[0].toLowerCase());
  return g;
}

/** 结构化摘要：条件/数值句全留 + 话题最相关 2 句；超 cap 时先丢非条件句（句界裁剪，不硬截字） */
export function summarizeAnswer(answer, query, cap = 300) {
  const flat = String(answer || '').replace(/\s+/g, ' ').trim();
  const sents = flat.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter((s) => s.length >= 4);
  if (!sents.length) return flat.slice(0, cap);
  const g = grams(query);
  const scored = sents.map((s, i) => {
    let hit = 0;
    for (const x of g) if (s.includes(x)) hit++;
    return { s, i, hit, cond: COND.test(s) };
  });
  const condKeep = scored.filter((x) => x.cond);
  const relTop = scored.filter((x) => !x.cond).sort((a, b) => b.hit - a.hit || a.i - b.i).slice(0, 2);
  const keep = [...condKeep, ...relTop].sort((a, b) => a.i - b.i);
  let body = keep.map((x) => x.s).join('');
  if ([...body].length > cap) {
    let out = '';
    for (const x of keep) {
      if (x.cond || [...out + x.s].length <= cap) out += x.s;
    }
    body = out || body.slice(0, cap);
  }
  return body;
}

/**
 * 组装参考资料块（v2 管线喂 compose-reply）。
 * @param {object} o.entry      检索 top1（fact 带 attrs/provenance；qa 带 answer/confidence）
 * @param {Array}  o.candidates 检索候选（带 entry，多候选合成）
 * @returns {string} 结构化资料块；无内容返回 ''
 */
export function assembleMaterial({ entry, candidates = [], db, config, query = '' } = {}) {
  const maxChars = Number(config?.retrieve?.maxMaterialChars ?? 1000);
  const minScore = Number(config?.retrieve?.minScore ?? 0.2);
  const blocks = []; // {prio, text}：prio 越大越保；facts=Infinity

  // ① facts 块：attrs 全保留 + provenance + 冲突双方
  if (entry?.attrs && Object.keys(entry.attrs).length) {
    const prov = entry.provenance || {};
    const src = prov.verifiedAt ? '官方/人工核实' : prov.source || '社区';
    const pct = entry.confidence != null ? Number(entry.confidence) : 50;
    let text = `- 【事实｜置信度${pct}%·${confLabelOf(pct)}｜来源 ${src}】${entry.name || entry.question}\n  ` +
      Object.entries(entry.attrs).map(([k, v]) => `${k}：${v}`).join('；');
    if (db) {
      const others = listFacts(db).filter((f) => f.name === entry.name && f.id !== entry.id && (f.status === 'active' || f.status === 'conflict'));
      if (others.length) {
        text += '\n  另有说法（未定论，口语说出矛盾）：' +
          others.map((o) => Object.entries(o.attrs || {}).map(([k, v]) => `${k}：${v}`).join('；')).join(' / ');
      }
    }
    blocks.push({ prio: Infinity, text });
  }

  // ② 问答层块：top≤3 相关候选（含 qa top1 自身），结构化摘要（条件/数值不丢）
  const seen = new Set();
  let qaCount = 0;
  for (const c of candidates || []) {
    if (qaCount >= 3) break;
    const e = c?.entry;
    if (!e?.answer || seen.has(e.id) || (c.score ?? 0) < minScore) continue;
    if (entry?.attrs && e.id === entry.id) continue; // fact top1 已在 facts 块，不重复
    seen.add(e.id);
    qaCount++;
    const pct = e.confidence != null ? Number(e.confidence) : 50;
    blocks.push({
      prio: Number(c.score ?? 0),
      text: `- 【问答｜置信度${pct}%·${confLabelOf(pct)}】问：${e.question}\n  要点：${summarizeAnswer(e.answer, query, 300)}`,
    });
  }

  // ③ 预算裁剪：高相关优先；facts 必保
  blocks.sort((a, b) => b.prio - a.prio);
  let total = 0;
  const out = [];
  for (const b of blocks) {
    const len = [...b.text].length;
    if (b.prio === Infinity || total + len <= maxChars) { out.push(b.text); total += len; }
  }
  return out.join('\n');
}