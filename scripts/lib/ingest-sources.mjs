// P4-b 摄入源适配器（2026-11-19）：把「官方公告 / 周报」等外部内容转成 ingest 需要的 items。
//
// 每个源：{ id, enabled, fetchSince(cursor, ctx) -> { items:[{text,source,url}], cursor } }
// 增量靠游标（data/ingest-cursor.json 每源一个 lastSeen / seenKeys），只取新增。
//
// 本批只实现**零风险源**：
//   · official：config.ingest.sources.official.urls 里的页面（抓正文文本）
//   · weekly：reports/ 下的周报 Markdown（新文件即增量）
// 评价/评论类源（需接口、有 WAF 与权限风险）留待 P4-c 之后单独确认。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** 粗提取 HTML 正文（够用即可：去脚本/样式/标签，压空白） */
export function htmlToText(html, { maxChars = 4000 } = {}) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, maxChars);
}

/**
 * official 源：按 url 列表抓正文。
 * @param {object} cfg config.ingest.sources.official
 * @param {Function} fetchImpl (url) => Promise<string>  可注入（测试）
 */
export async function fetchOfficial(cfg = {}, cursor = {}, { fetchImpl = null } = {}) {
  const urls = Array.isArray(cfg.urls) ? cfg.urls.filter(Boolean) : [];
  const seen = new Set(cursor.seen || []);
  const doFetch = fetchImpl || (async (u) => {
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const items = [];
  const nowSeen = [...seen];
  for (const u of urls) {
    if (seen.has(u)) continue; // 游标：已摄入过
    try {
      const html = await doFetch(u);
      const text = htmlToText(html, { maxChars: Number(cfg.maxChars ?? 4000) });
      if (text.length >= 40) {
        items.push({ text, source: `官方:${u}`, url: u });
        nowSeen.push(u);
      }
    } catch {
      /* 单条失败不影响其他源 */
    }
  }
  return { items, cursor: { ...cursor, seen: nowSeen } };
}

/**
 * weekly 源：reports/ 下的周报 Markdown，按文件名增量。
 * @param {object} cfg config.ingest.sources.weekly
 */
export function fetchWeekly(cfg = {}, cursor = {}, { dir = null } = {}) {
  const base = dir || cfg.dir;
  if (!base || !existsSync(base)) return { items: [], cursor };
  const seen = new Set(cursor.seen || []);
  const items = [];
  const nowSeen = [...seen];
  let files = [];
  try {
    files = readdirSync(base).filter((f) => /^论坛周报.*\.md$|^weekly.*\.md$/i.test(f)).sort();
  } catch {
    return { items: [], cursor };
  }
  for (const f of files) {
    if (seen.has(f)) continue;
    try {
      const text = readFileSync(resolve(base, f), 'utf8');
      const clean = text.replace(/\s+/g, ' ').trim().slice(0, Number(cfg.maxChars ?? 6000));
      if (clean.length >= 60) {
        items.push({ text: clean, source: `周报:${f}`, url: null });
        nowSeen.push(f);
      }
    } catch {}
  }
  return { items, cursor: { ...cursor, seen: nowSeen } };
}

/** 按 config 里启用的源逐个抓（顺序执行，单源失败隔离） */
export async function collectSources(config = {}, cursors = {}, { fetchImpl = null, weeklyDir = null } = {}) {
  const s = config.ingest?.sources || {};
  const out = { items: [], cursors: { ...cursors }, bySource: {} };
  if (s.official?.enabled) {
    const r = await fetchOfficial(s.official, cursors.official || {}, { fetchImpl });
    out.items.push(...r.items);
    out.cursors.official = r.cursor;
    out.bySource.official = r.items.length;
  }
  if (s.weekly?.enabled) {
    const r = fetchWeekly(s.weekly, cursors.weekly || {}, { dir: weeklyDir });
    out.items.push(...r.items);
    out.cursors.weekly = r.cursor;
    out.bySource.weekly = r.items.length;
  }
  return out;
}