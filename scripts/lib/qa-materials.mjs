// 资料库读取与匹配（2026-11-26）
//
// ## 资料库是什么
//
// `qa/资料/` 放的是**游戏机制 / 流程 / 活动规则**这些事实基础，
// 不是「玩家问 X → 答 Y」的答案。用途：
//   ① 答疑库没命中时，拿资料当**参考材料**让 LLM 自己组织话
//   ② 拆要点 / 错别字校验时，认出黑话（原大、甜甜魔甘甘）不当错误
//
// ## 为什么结构化
//
// 每个文件带 frontmatter（id/title/type/keywords/scope），正文用 `##` 分节。
// 读取器按 keywords 匹配、按节取用 —— 不用把整篇喂给模型，省 token 也更准。
//
// ## 文件格式（见 qa/资料/README.md）
//
//   ---
//   id: doc-duel-mode
//   title: 双人对决
//   type: mechanism        # mechanism | process | event | glossary
//   keywords: [双人对决, 不同步]
//   scope: 6.2 版本赛季     # 活动类必填
//   updated: 2026-11-26
//   confidence: 95
//   ---
//
//   ## 一句话结论
//   正文……
//
// ## 匹配算法（为什么不引依赖）
//
// 关键词命中（权重高）+ 中文 2-gram 覆盖率（兜底）。够用、可解释、零依赖。
// 判不准时**返回空**（宁可不参考，也不要拿错资料误导模型）。

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** frontmatter 极简解析（与 qa-entry.mjs 同风格，零依赖） */
function parseFrontmatter(text) {
  const raw = String(text || '');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, '').trim());
        j++;
      }
      if (items.length) {
        meta[key] = items;
        i = j;
        continue;
      }
      meta[key] = '';
      i++;
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
    i++;
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** 正文按 `##` 分节 */
export function splitSections(body) {
  const parts = String(body || '').split(/\n(?=##\s)/);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^##\s+(.+)$/m);
    if (!m) continue;
    const title = m[1].trim();
    const content = p.slice(p.indexOf('\n') + 1).trim();
    if (content) out.push({ title, content });
  }
  return out;
}

/** 解析一份资料文档 */
export function parseDoc(text) {
  const { meta, body } = parseFrontmatter(text);
  return {
    id: meta.id || '',
    title: meta.title || '',
    type: meta.type || 'mechanism',
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    scope: meta.scope || '',
    updated: meta.updated || '',
    confidence: meta.confidence != null ? Number(meta.confidence) : 95,
    source: meta.source || '',
    sections: splitSections(body),
    body,
  };
}

/** 读整个资料目录 */
export async function loadMaterials(dir) {
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.sort()) {
    try {
      const raw = (await readFile(join(dir, f), 'utf8')).replace(/^\uFEFF/, '');
      const doc = parseDoc(raw);
      doc.file = f;
      if (doc.id || doc.title) out.push(doc);
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

/** 中文 2-gram */
function grams(s) {
  const set = new Set();
  for (const m of String(s || '').matchAll(/[\u4e00-\u9fa5]{2}/g)) set.add(m[0]);
  for (const m of String(s || '').matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) set.add(m[0].toLowerCase());
  return set;
}

/**
 * 按问法挑相关资料
 *
 * 打分：关键词命中（每个 +10，问法包含整词才算）+ 2-gram 覆盖率（×5）
 * 低于门槛返回空 —— 宁可不参考，也不要拿错资料误导模型。
 *
 * @param {string} query 玩家问法
 * @param {Array} docs loadMaterials 结果
 * @param {object} [o]
 * @param {number} [o.topN] 最多返回几份文档
 * @param {number} [o.minScore] 门槛
 * @param {number} [o.sectionsPerDoc] 每份文档取几节
 * @returns {Array<{doc, sections, score}>}
 */
export function matchMaterials(query, docs = [], { topN = 2, minScore = 8, sectionsPerDoc = 2 } = {}) {
  const q = String(query || '');
  if (!q.trim()) return [];
  const qg = grams(q);

  const scored = [];
  for (const doc of docs || []) {
    let score = 0;
    // ① 关键词命中（整词出现在问法里）
    for (const kw of doc.keywords || []) {
      if (kw && q.includes(kw)) score += 10;
    }
    // ② 2-gram 覆盖（问法的字有多少出现在标题+关键词里）
    const pool = new Set([...grams(doc.title), ...(doc.keywords || []).flatMap((k) => [...grams(k)])]);
    let hit = 0;
    for (const g of qg) if (pool.has(g)) hit++;
    if (qg.size) score += (hit / qg.size) * 5;

    if (score < minScore) continue;

    // 挑最相关的节
    const secs = (doc.sections || [])
      .map((s, i) => {
        let h = 0;
        for (const g of qg) if (s.title.includes(g) || s.content.includes(g)) h++;
        return { ...s, _score: h, _i: i };
      })
      .filter((s) => s._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, sectionsPerDoc)
      .sort((a, b) => a._i - b._i);

    scored.push({
      doc,
      sections: secs.length ? secs : (doc.sections || []).slice(0, 1),
      score,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * 把命中的资料整理成「参考资料」文本（给 LLM 看）
 * 明确标注是「资料，不是答案」—— 模型要用自己的话讲，不许照抄。
 */
export function formatMaterials(hits = [], { maxCharsPerSection = 400 } = {}) {
  const out = [];
  for (const h of hits) {
    const d = h.doc;
    const head = `- 【资料｜${d.title}${d.scope ? `｜${d.scope}` : ''}${d.confidence != null ? `｜置信度${d.confidence}%` : ''}】`;
    const lines = [head];
    for (const s of h.sections || []) {
      const body = String(s.content || '').replace(/\s+/g, ' ').slice(0, maxCharsPerSection);
      lines.push(`  · ${s.title}：${body}`);
    }
    out.push(lines.join('\n'));
  }
  return out.join('\n');
}

/** 所有已知黑话（供拆要点 / 校验豁免用） */
export function slangOf(docs = []) {
  const out = new Set();
  for (const d of docs) {
    if (d.type !== 'glossary') continue;
    for (const kw of d.keywords || []) if (kw) out.add(kw);
  }
  return [...out];
}