#!/usr/bin/env node
// 已移除的「加好友帖」清单 → Markdown
//
// 要回答的问题：这些广告帖是谁发的、好友码是多少（去重）、一句话概括。
//
// 数据来源（两个，都要 —— 各记一半）：
//   - data/mod-state.json ：管理任务的记账（keyword / inviteCode / removedAt / title / author）
//   - data/post-records.sqlite ：post_record 里 status='removed' 的行（老记录搬库后还在）
//   - 标题里没有好友码的帖（码在正文里）→ 调只读接口 /webapiv2/moment/v3/detail 取正文
//     （移除只是移出版块，帖子详情页照样能打开 → 取得到）
//
// 好友码识别（不写死前缀，and / ios 都能认）：
//   候选 = 形如 [A-Za-z][A-Za-z0-9]{5,19} 的词块，且（含数字 或 含大写字母）——
//   这样 "taptap"、"android" 这种普通英文词不会被误当码。
//   去重：忽略大小写归并，保留出现次数最多的写法。
//
// 用法（**固定脚本，靠参数复用；不要另写新脚本**）：
//   node scripts/removed-list.mjs                              # 全量报告
//   node scripts/removed-list.mjs --since "2026-10-30 13:22:11" # 只要这个时间**之后**移除的（增量）
//   node scripts/removed-list.mjs --since "..." --until "..."   # 指定区间
//   node scripts/removed-list.mjs --days 3                      # 只要最近 3 天移除的（等价于 --since 3天前）
//   node scripts/removed-list.mjs --refresh                     # 强制重新抓正文（默认有缓存就不重抓）
//   node scripts/removed-list.mjs --no-fetch                    # 完全不联网，只用已有字段
//   node scripts/removed-list.mjs --out reports/xx.md           # 自定义输出路径
//
// 时间窗按**移除时间**（removedAt）过滤；带时间窗时默认输出到
// reports/removed-friend-posts-<from>_<to>.md（ASCII 文件名），不覆盖全量清单。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/paths.mjs';
import { openDb } from './lib/db.mjs';
import { makeRunner } from './lib/replier.mjs';
import { makeTapApi } from './lib/taptap-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh');
const NO_FETCH = argv.includes('--no-fetch');

/** 取参数值：--since "2026-10-30 13:22:11" */
const argOf = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

/**
 * 解析时间字符串 → 毫秒时间戳
 * 支持："2026-10-30 13:22:11" / "2026/10/30 13:22:11" / "2026-10-30" / ISO
 * 解析不了返回 null（调用方负责报错）
 */
export function parseTime(s) {
  if (!s) return null;
  const v = String(s).trim().replace(/\//g, '-');
  if (!v) return null;
  const t = Date.parse(v.includes('T') ? v : v.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

/**
 * 按「移除时间」过滤（时间窗是**闭区间** [from, to]）
 * @param posts [{ removedAt }]
 * @param o.from 毫秒时间戳或 null
 * @param o.to   毫秒时间戳或 null
 */
export function filterByTimeWindow(posts, { from = null, to = null } = {}) {
  if (!from && !to) return [...posts];
  return posts.filter((p) => {
    const t = Date.parse(String(p?.removedAt || ''));
    if (Number.isNaN(t)) return false;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });
}

/** 时间戳 → 文件名用的紧凑串（本地时间）：20261030-1322 */
export function stampOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 普通英文词，不会是好友码 */
const STOPWORDS = new Set([
  'taptap', 'moment', 'comment', 'android', 'iphone', 'ios', 'google', 'wechat',
  'weixin', 'qqmusic', 'bilibili', 'douyin', 'kuaishou', 'zhihu', 'taobao',
  'friend', 'friends', 'hello', 'admin', 'group', 'momentid',
]);

/** 候选好友码：字母开头、长度 6~20、且含数字或含大写（排除纯小写英文词） */
export function extractCodes(...texts) {
  const out = [];
  for (const t of texts) {
    if (!t) continue;
    const s = String(t);
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9]{5,19}/g)) {
      const token = m[0];
      const low = token.toLowerCase();
      if (STOPWORDS.has(low)) continue;
      if (!/[0-9]/.test(token) && !/[A-Z]/.test(token)) continue; // 纯小写英文词
      out.push(token);
    }
  }
  return out;
}

/** 归并去重：忽略大小写，返回 [{code, variants, count}] */
export function dedupeCodes(codes) {
  const map = new Map();
  for (const c of codes) {
    const key = c.toLowerCase();
    if (!map.has(key)) map.set(key, { key, variants: new Map(), count: 0 });
    const e = map.get(key);
    e.variants.set(c, (e.variants.get(c) || 0) + 1);
    e.count++;
  }
  return [...map.values()]
    .map((e) => {
      const top = [...e.variants.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      return { code: top, key: e.key, variants: [...e.variants.keys()], count: e.count };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** 从 v3/detail 响应里取出正文文本，并判断是不是「图片帖」（正文在图里，提取不到码） */
function bodyOf(json) {
  const m = json?.data?.moment || {};
  const t = m.topic || {};
  const parts = [
    t.title,
    t.summary,
    t.content,
    JSON.stringify(m.contents?.json || ''),
    JSON.stringify(m.topic?.contents?.json || ''),
  ].filter(Boolean);
  const text = parts.join(' ');
  // 图文动态：topic 只有 summary / 图片，没有正文文本 → 码在图里
  const isImage = !t.title && !t.summary && !m.contents?.json;
  return { text, isImage, type: t.type };
}

async function main() {
  const config = await loadConfig();
  const modFile = config.paths.modStateFile || config.paths.stateFile;
  const dbFile = config.paths.postDbFile || resolve(ROOT, 'data/post-records.sqlite');
  const cacheFile = resolve(ROOT, 'data/removed-codes.json');

  const REFRESH = argv.includes('--refresh');
  const NO_FETCH = argv.includes('--no-fetch');

  // ---- 时间窗：--since / --until / --days（三者可组合，days 等价于「N 天前到现在」）----
  let SINCE = parseTime(argOf('since'));
  const UNTIL = parseTime(argOf('until'));
  const DAYS = Number(argOf('days', ''));
  if (argOf('since') && SINCE === null) {
    console.error(`--since 时间解析失败：${argOf('since')}（示例：--since "2026-10-30 13:22:11"）`);
    process.exit(1);
  }
  if (argOf('until') && UNTIL === null) {
    console.error(`--until 时间解析失败：${argOf('until')}（示例：--until "2026-10-31 23:59:59"）`);
    process.exit(1);
  }
  if (Number.isFinite(DAYS) && DAYS > 0 && !SINCE) SINCE = Date.now() - DAYS * 86400000;

  // 输出路径：带时间窗 → 独立「区间」文件，不覆盖全量清单
  const outArg = argOf('out');
  const toStamp = UNTIL ? stampOf(UNTIL) : stampOf(Date.now());
  const outFile = outArg
    ? resolve(ROOT, outArg)
    : SINCE
      ? resolve(ROOT, `reports/removed-friend-posts-${stampOf(SINCE)}_${toStamp}.md`)
      : resolve(ROOT, 'reports/removed-friend-posts.md');

  // ---------- 1. 收齐已移除的帖子 ----------
  const byId = new Map();
  try {
    const st = JSON.parse(await readFile(modFile, 'utf8'));
    for (const [id, p] of Object.entries(st.posts || {})) {
      const mt = p?.modTask;
      if (!mt?.removedAt) continue;
      byId.set(String(id), {
        id: String(id),
        title: p.title || '',
        author: p.author || '',
        keyword: mt.keyword || '',
        inviteCode: mt.inviteCode || '',
        normKey: p.normKey || '',
        removedAt: mt.removedAt,
        url: p.url || `https://www.taptap.cn/moment/${id}`,
      });
    }
  } catch {}

  try {
    const db = openDb(dbFile);
    const rows = db
      .prepare('SELECT id,title,author,status,keyword,invite_code,stage,updated_at FROM post_record WHERE status IN (?,?)')
      .all('removed', 'manual_remove');
    for (const r of rows) {
      const id = String(r.id);
      const old = byId.get(id);
      if (old) {
        old.keyword = old.keyword || r.keyword || '';
        old.inviteCode = old.inviteCode || r.invite_code || '';
        old.removedAt = old.removedAt || new Date(r.updated_at || Date.now()).toISOString();
      } else {
        byId.set(id, {
          id,
          title: r.title || '',
          author: r.author || '',
          keyword: r.keyword || '',
          inviteCode: r.invite_code || '',
          normKey: '',
          removedAt: new Date(r.updated_at || Date.now()).toISOString(),
          url: `https://www.taptap.cn/moment/${id}`,
        });
      }
    }
    db.close();
  } catch (e) {
    console.log(`（读记录库失败：${e.message}）`);
  }

  // 时间窗过滤（按移除时间）
  const all = [...byId.values()];
  const totalBefore = all.length;
  let posts = filterByTimeWindow(all, { from: SINCE, to: UNTIL });
  posts.sort((a, b) => String(a.removedAt).localeCompare(String(b.removedAt)));
  if (SINCE || UNTIL) {
    const f = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
    console.log(`时间窗：${f(SINCE)} → ${f(UNTIL) || '现在'}`);
    console.log(`已移除的加好友帖：${posts.length} 条（总记录 ${totalBefore} 条，过滤掉 ${totalBefore - posts.length} 条）`);
  } else {
    console.log(`已移除的加好友帖：${posts.length} 条`);
  }

  // ---------- 2. 先从已有字段抽码 ----------
  let cache = {};
  try {
    if (existsSync(cacheFile)) cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {}
  const bodyCache = cache.body || {};

  const allCodes = [];
  const needFetch = [];
  for (const p of posts) {
    const found = extractCodes(p.title, p.normKey, p.inviteCode, bodyCache[p.id]);
    p.codes = found;
    if (!found.length && !NO_FETCH) needFetch.push(p);
  }

  // ---------- 3. 缺码的帖子去取正文 ----------
  if (needFetch.length) {
    console.log(`有 ${needFetch.length} 条标题里没有码 → 调只读接口取正文`);
    const runner = makeRunner({ opencliMain: config.reply.opencliMain, session: config.modTasks?.session || 'tapmod' });
    const api = makeTapApi({ runner, intervalMs: 900 });
    if (runner.available && api.ensureOrigin().ok) {
      for (const p of needFetch) {
        try {
          const r = await api.get('/webapiv2/moment/v3/detail', { id: p.id });
          const b = bodyOf(r.json);
          bodyCache[p.id] = b.text.slice(0, 600);
          const found = extractCodes(b.text);
          p.codes = found;
          p.isImage = b.isImage;
          console.log(
            `  ${p.id} ${found.length ? '→ ' + found.join(',') : b.isImage ? '（图片帖，码在图里）' : '（正文里也没有）'}`
          );
        } catch (e) {
          console.log(`  ${p.id} 取正文失败：${e.message}`);
        }
      }
      cache.body = bodyCache;
      await writeFile(cacheFile, JSON.stringify(cache, null, 1), 'utf8');
    }
  }

  // ---------- 4. 去重 + 出报告 ----------
  //   先「帖内去重」：同一个码可能同时出现在标题、normKey、邀请码里（大小写还可能不同）
  //   再「全局汇总」：同一码出现在多个帖里只算一个
  for (const p of posts) {
    const pc = dedupeCodes(p.codes);
    p.codes = pc.map((u) => u.code);
    allCodes.push(...p.codes);
  }
  const unique = dedupeCodes(allCodes);
  const now = new Date();
  const fmtT = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
  const L = [];
  L.push(`# 已移除的「加好友帖」清单${SINCE ? '（增量）' : ''}`);
  L.push('');
  if (SINCE) {
    L.push(`> 时间窗：**${fmtT(SINCE)} → ${UNTIL ? fmtT(UNTIL) : fmtT(now)}**`);
    L.push('>');
  }
  L.push(`> 生成时间：${now.toLocaleString('zh-CN')}　|　已移除帖子：**${posts.length}** 条　|　去重后好友码：**${unique.length}** 个`);
  L.push('>');
  L.push('> 数据源：`data/mod-state.json`（管理任务记账）+ `data/post-records.sqlite`（记录库）');
  L.push('> 好友码：优先从标题 / 邀请码取；标题里没有的，从帖子正文取（`moment/v3/detail`）');
  L.push('> 「移除」= 移出版块（`moment/v3/unlink-group`），**不是删帖**，帖子详情页仍可打开');
  L.push('');

  L.push('## 一、好友码去重清单');
  L.push('');
  L.push(`共 ${unique.length} 个码（同一码出现在多个帖里只算一个）：`);
  L.push('');
  L.push('| # | 好友码 | 出现次数 | 写法变体 |');
  L.push('|---|---|---|---|');
  unique.forEach((u, i) => {
    L.push(`| ${i + 1} | \`${u.code}\` | ${u.count} | ${u.variants.length > 1 ? u.variants.map((v) => `\`${v}\``).join(' / ') : '—'} |`);
  });
  L.push('');

  const multi = unique.filter((u) => u.count > 1);
  if (multi.length) {
    L.push(`> 其中 ${multi.length} 个码在多个帖里出现过：${multi.map((u) => `\`${u.code}\`×${u.count}`).join('、')}`);
    L.push('');
  }

  L.push('## 二、逐帖明细');
  L.push('');
  L.push('| 玩家 | 好友码 | 一句话总结 | 移除时间 | 帖子 |');
  L.push('|---|---|---|---|---|');
  for (const p of posts) {
    const codes = p.codes.length ? p.codes.map((c) => `\`${c}\``).join('、') : p.isImage ? '（图片帖，码在图里）' : '（未取到）';
    const kw = p.keyword ? `「${p.keyword}」` : '加好友';
    const title = String(p.title || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 24);
    const summary = `《${title}》命中${kw}意图，已回固定提醒文案并移出讨论区`;
    const when = p.removedAt ? new Date(p.removedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    L.push(`| ${String(p.author || '（未知）').replace(/\|/g, '\\|')} | ${codes} | ${summary} | ${when} | [链接](${p.url}) |`);
  }
  L.push('');

  const noCode = posts.filter((p) => !p.codes.length);
  if (noCode.length) {
    L.push(`## 三、没提取到好友码的帖子（${noCode.length} 条）`);
    L.push('');
    L.push('| 玩家 | 标题 | 说明 | 移除时间 | 帖子 |');
    L.push('|---|---|---|---|---|');
    for (const p of noCode) {
      const when = p.removedAt ? new Date(p.removedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
      const title = String(p.title || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 24);
      const why = p.isImage ? '图片帖，好友码在图片里（文本提取不到）' : '正文里确实没有码';
      L.push(`| ${String(p.author || '（未知）').replace(/\|/g, '\\|')} | ${title} | ${why} | ${when} | [链接](${p.url}) |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('生成命令：`node scripts/removed-list.mjs`（`--refresh` 强制重抓正文，`--no-fetch` 完全不联网）');

  await writeFile(outFile, L.join('\n') + '\n', 'utf8');
  console.log(`\n已写入：${outFile}`);
  console.log(`好友码：${unique.length} 个（去重前 ${allCodes.length} 次出现），其中 ${noCode.length} 条帖没取到码`);
}

// 只有**直接当脚本跑**时才执行；被 import（测试）时只导出函数。
// ⚠️ 要用文件名严格比对 —— 正则 /removed-list\.mjs$/ 会把 test-removed-list.mjs 也匹配上。
const CLI_NAME = 'removed-list.mjs';
if (process.argv[1] && basename(process.argv[1]) === CLI_NAME) {
  await main();
}
