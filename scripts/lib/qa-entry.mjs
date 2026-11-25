// QA 条目文件格式（一条一文件，2026-11-25 多协作改造）
//
// ## 为什么一条一文件
//
// 原来 192 条挤在一个 `qa/答疑库.md`（76KB）里。两人同时加条目 → git 文本冲突，
// 而且 diff 是一整坨，评审看不出改了哪条。拆成一条一文件后：
//   · 不同人加**不同条目** → 不同文件 → git 零冲突
//   · 同一条目两人都改 → 同一文件 → 冲突范围只有这一条
//
// ## 文件格式
//
// ```markdown
// ---
// id: q-tahuang-wujin-dapei
// question: 买了塔黄无尽用什么好
// keywords: [塔黄, 保龄球, 卡波]
// version: 通用
// updated: 2026-11-25
// ---
//
// ## 要点
// - [70%] 优先买神器保龄球
//   - 来源: https://www.taptap.cn/moment/xxx
//   - 来源: https://www.taptap.cn/moment/yyy
// - [50%] 卡波建议塔黄空吸到最高再点下一波
//   - 来源: https://www.taptap.cn/moment/zzz
// ```
//
// 要点（claim）的语义：
//   · 一条要点 = 一个**可独立评价**的具体点（大哥规格：「回答应被拆为各个点分别评价」）
//   · 每点自带置信度 → 同一问题下不同点可以有不同可信度
//   · 每点可挂多个来源 → 多渠道佐证，聚合出更高置信度
//
// 兼容：没有 `## 要点` 段的旧格式（单段正文）也支持 —— 整段正文当作**唯一一个要点**。

import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** 置信度阈值（搬自 lib/facts.mjs 的 calibratedConfidence，保持一致） */
export const CONF = {
  OFFICIAL: 95, // 官方来源 / 人工核实
  PENDING: 30, // 有未解决的反对票 → 待核实
  MANY: 80, // >3 渠道 且 ≥3 玩家说法一致
  TWO: 70, // ≥2 渠道一致
  SINGLE: 50, // 单一来源
};

/** 置信度 → 五档标签（与 lib/qa.mjs 的 confLabelOf 同规则） */
export function confLabelOf(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '中置信度';
  if (n < 10) return '不可信';
  if (n < 40) return '低置信度';
  if (n < 60) return '中置信度';
  if (n < 90) return '高置信度';
  return '可信';
}

/** 稳定 id：问法 → slug。同问法恒得同 id（首次入库后固化在文件里，不再随问法漂移） */
export function slugId(question) {
  const base = String(question || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base ? `q-${base}` : `q-${createHash('sha1').update(String(question || '')).digest('hex').slice(0, 12)}`;
}

// ── 极简 frontmatter 解析（零依赖，只支持本格式用到的语法） ──
//
// 支持：
//   key: value
//   key: [a, b, c]              行内数组
//   key:                        后跟缩进 "  - item" 列表
//   key: "带引号的值"
function parseFrontmatter(text) {
  const raw = String(text || '');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '') {
      // 可能是列表
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^\s+-\s+/, '').trim()));
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
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      meta[key] = unquote(val);
    }
    i++;
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** frontmatter → 条目对象 */
function metaToEntry(meta) {
  const keywords = Array.isArray(meta.keywords)
    ? meta.keywords
    : String(meta.keywords || '')
        .split(/[,，、;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  return {
    id: meta.id || '',
    question: meta.question || meta.问 || '',
    keywords,
    version: meta.version || '通用',
    updated: meta.updated || meta.updatedAt || '',
    author: meta.author || meta.signature || '',
    signature: meta.signature || meta.author || '',
    confidence: meta.confidence != null && meta.confidence !== '' ? Number(meta.confidence) : null,
    source: meta.source || '',
    semanticConfirm: /true|是|yes/i.test(String(meta.semanticConfirm || '')),
  };
}

// ── 要点解析 ──
//
// `- [70%] 正文` 可选跟随缩进的 `- 来源: url`
// 也支持 `- [70%] 正文 | 来源A, 来源B` 的行内写法
const CLAIM_LINE = /^[-*]\s*(?:\[(\d{1,3})\s*%?\])?\s*(.+)$/;
const SRC_LINE = /^\s+[-*]\s*来源[:：]\s*(\S+)/;

export function parseClaims(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  // 找 "## 要点" 段
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s*要点\s*$/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    // 旧格式：整段正文当唯一要点
    const body2 = text.replace(/^#{1,3}\s*答案\s*$/m, '').trim();
    return body2 ? [{ text: body2, confidence: null, sources: [] }] : [];
  }
  const claims = [];
  let cur = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const cm = line.match(CLAIM_LINE);
    if (cm && !/^\s/.test(line)) {
      if (cur) claims.push(cur);
      let t = cm[2].trim();
      const sources = [];
      const inline = t.split(/\s*\|\s*/);
      if (inline.length > 1) {
        t = inline[0].trim();
        for (const s of inline.slice(1)) if (s.trim()) sources.push(s.trim());
      }
      cur = { text: t, confidence: cm[1] != null ? Number(cm[1]) : null, sources };
      continue;
    }
    const sm = line.match(SRC_LINE);
    if (sm && cur) {
      cur.sources.push(sm[1]);
      continue;
    }
    // 续行（要点正文跨行）→ 并入上一个要点
    if (cur && line.trim() && !/^#{1,3}\s/.test(line)) {
      cur.text += ' ' + line.trim();
    }
  }
  if (cur) claims.push(cur);
  return claims.filter((c) => c.text);
}

/** 解析一个条目文件文本 → 条目对象 */
export function parseEntryFile(text) {
  const { meta, body } = parseFrontmatter(text);
  const entry = metaToEntry(meta);
  entry.claims = parseClaims(body);
  entry.body = body;
  // 没有 id 就按问法生成（首次入库时固化）
  if (!entry.id) entry.id = slugId(entry.question);
  return entry;
}

/** 条目对象 → 文件文本 */
export function renderEntryFile(entry) {
  const lines = ['---'];
  lines.push(`id: ${entry.id || slugId(entry.question)}`);
  lines.push(`question: ${entry.question || ''}`);
  const kw = Array.isArray(entry.keywords) ? entry.keywords : [];
  lines.push(`keywords: [${kw.join(', ')}]`);
  lines.push(`version: ${entry.version || '通用'}`);
  if (entry.confidence != null) lines.push(`confidence: ${entry.confidence}`);
  if (entry.updated) lines.push(`updated: ${entry.updated}`);
  if (entry.source) lines.push(`source: ${entry.source}`);
  if (entry.author) lines.push(`author: ${entry.author}`);
  if (entry.signature) lines.push(`signature: ${entry.signature}`);
  if (entry.semanticConfirm) lines.push('semanticConfirm: true');
  lines.push('---');
  lines.push('');
  const claims = entry.claims || [];
  // 要点段只在「有多点」或「有点带来源/置信度」时写；单点且无来源 → 保持纯正文（无损）
  const structured = claims.length > 1 || claims.some((c) => (c.sources && c.sources.length) || c.confidence != null);
  if (structured) {
    lines.push('## 要点');
    for (const c of claims) {
      const pct = c.confidence != null ? `[${c.confidence}%]` : '';
      lines.push(`- ${pct} ${c.text}`);
      for (const s of c.sources || []) lines.push(`  - 来源: ${s}`);
    }
  } else {
    lines.push(entry.body || (claims[0]?.text || ''));
  }
  return lines.join('\n') + '\n';
}

/** 目录里的条目文件列表 */
export async function listEntryFiles(dir) {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/** 读一个条目文件 */
export async function readEntryFile(dir, name) {
  const raw = await readFile(join(dir, name), 'utf8');
  return parseEntryFile(raw);
}

/** 读整个目录的条目 */
export async function readAllEntries(dir) {
  const files = await listEntryFiles(dir);
  const out = [];
  for (const f of files) {
    try {
      out.push(await readEntryFile(dir, f));
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

/** 原子写一个条目文件（同 id 冲突时自动改名，不覆盖别人的） */
export async function writeEntryFile(dir, entry, { overwrite = true } = {}) {
  await mkdir(dir, { recursive: true });
  const base = `${entry.id || slugId(entry.question)}.md`;
  let name = base;
  if (!overwrite) {
    let n = 2;
    const exists = await listEntryFiles(dir);
    while (exists.includes(name)) name = `${base.replace(/\.md$/, '')}-${n++}.md`;
  }
  const target = join(dir, name);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, renderEntryFile(entry), 'utf8');
  await rename(tmp, target);
  return name;
}

/** 条目的来源集合（所有要点上的来源并集） */
export function sourcesOfEntry(entry) {
  const s = new Set();
  for (const c of entry.claims || []) for (const x of c.sources || []) if (x) s.add(x);
  return [...s];
}

/**
 * 条目的纯文本（给下游当 answer 用，不带任何标记）
 *   · 有要点段 → 要点文本拼接（要点是原文的切分，信息等价）
 *   · 无要点段 → 原始正文
 */
export function plainTextOf(entry) {
  const claims = entry.claims || [];
  const hasSection = /^#{1,3}\s*要点\s*$/m.test(entry.body || '');
  if (hasSection && claims.length) return claims.map((c) => c.text).join('\n').trim();
  return String(entry.body || '').trim();
}

/**
 * 按事实层的规则聚合一个要点的置信度
 * @param {object} claim 要点 {confidence, sources[], confirms, negative}
 * @param {object} o {official:boolean}
 */
export function aggregateClaimConfidence(claim, { official = false } = {}) {
  if (official) return CONF.OFFICIAL;
  const negative = Number(claim?.negative || 0);
  if (negative > 0) return CONF.PENDING;
  const channels = new Set((claim?.sources || []).filter(Boolean));
  const confirms = Number(claim?.confirms || 0);
  if (channels.size > 3 && confirms >= 3) return CONF.MANY;
  if (channels.size >= 2) return CONF.TWO;
  return claim?.confidence != null ? Number(claim.confidence) : CONF.SINGLE;
}
