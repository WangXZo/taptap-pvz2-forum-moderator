#!/usr/bin/env node
// 帖子记录库（SQLite）管理
//
// 用法：
//   node scripts/post-records.mjs stats               # 统计
//   node scripts/post-records.mjs list                # 最近 30 条
//   node scripts/post-records.mjs list --status removed
//   node scripts/post-records.mjs events <momentId>   # 某帖的事件流水
//   node scripts/post-records.mjs archive --days 45    # 把 state.json 里的老记录搬进库
//   node scripts/post-records.mjs prune --days 90     # 裁剪库里超过 N 天的记录

import { loadConfig } from './lib/paths.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { openPostDb, archiveOldPosts, listPosts, listEvents, stats, prunePosts } from './lib/post-records.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const config = await loadConfig();
const db = openPostDb(config);

/**
 * 需人工清单（用户 2026-11-10 要一个**文件地址**）
 *
 * 为什么单独一个命令：`reports/questions.md` 里的「需人工」是**全量**（含往期），
 * 值班时想看的是「最近几天还没人答的」。这里按发布时间倒序导一份 Markdown + CSV。
 *
 * 用法：
 *   node scripts/post-records.mjs manual                    # 最近 7 天
 *   node scripts/post-records.mjs manual --days 3           # 最近 3 天
 *   node scripts/post-records.mjs manual --days 0           # 全量
 *   node scripts/post-records.mjs manual --out <文件路径>     # 指定输出
 */
function cmdManual() {
  const days = Number(flag('days', 7));
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const rows = db
    .prepare(
      `SELECT id, title, author, publish_time, keyword, qa_status, url
       FROM post_record
       WHERE qa_status='manual' ${days > 0 ? 'AND publish_time >= ?' : ''}
       ORDER BY publish_time DESC`
    )
    .all(...(days > 0 ? [Math.floor(since / 1000)] : []));

  const stamp = new Date().toISOString().slice(0, 10);
  const out =
    flag('out', null) ||
    join(config.paths?.reportsDir || 'reports', `需人工清单-${days > 0 ? days + '天-' : ''}${stamp}.md`);
  const csvOut = out.replace(/\.md$/i, '.csv');

  const head =
    `# 需人工清单（最近 ${days > 0 ? days + ' 天' : '全量'}）\n\n` +
    `> 生成时间：${new Date().toLocaleString('zh-CN')}　条数：${rows.length}\n` +
    `> 这些帖**已经判定过但没人回**（答疑库没命中 / 涉敏感 / 情绪帖等）——需要版主自己看。\n\n` +
    `| # | 时间 | 作者 | 标题 | 状态 | 链接 |\n|---|---|---|---|---|---|\n`;
  const body = rows
    .map((r, i) => {
      const d = r.publish_time ? new Date(r.publish_time * 1000).toLocaleString('zh-CN') : '-';
      const t = String(r.title || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
      return `| ${i + 1} | ${d} | ${r.author || '-'} | ${t} | ${r.qa_status || '-'} | https://www.taptap.cn/moment/${r.id} |`;
    })
    .join('\n');
  const foot = `\n\n---\n共 ${rows.length} 条。\n`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, head + body + foot, 'utf8');
  const csv = ['发布时间,作者,标题,状态,帖子ID,链接']
    .concat(
      rows.map((r) => {
        const d = r.publish_time ? new Date(r.publish_time * 1000).toLocaleString('zh-CN') : '';
        const t = String(r.title || '').replace(/,/g, '、').replace(/\s+/g, ' ').trim();
        return `${d},${r.author || ''},${t},${r.qa_status || ''},${r.id},https://www.taptap.cn/moment/${r.id}`;
      })
    )
    .join('\n');
  writeFileSync(csvOut, '﻿' + csv + '\n', 'utf8');

  console.log(`需人工 ${rows.length} 条（最近 ${days > 0 ? days + ' 天' : '全量'}）`);
  console.log(`  → ${out}`);
  console.log(`  → ${csvOut}`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  - [${r.qa_status || '-'}] ${String(r.title || '').slice(0, 40)}`);
  }
  if (rows.length > 10) console.log(`  … 还有 ${rows.length - 10} 条`);
}

if (cmd === 'stats') {
  const s = stats(db);
  console.log(`库：${config.paths.postDbFile}`);
  console.log(`帖子记录：${s.total} 条   事件流水：${s.events} 条`);
  console.log('按状态：');
  for (const [k, v] of Object.entries(s.byStatus)) console.log(`  ${k}: ${v}`);
} else if (cmd === 'list') {
  const rows = listPosts(db, { limit: Number(flag('limit', 30)), status: flag('status', null) });
  if (!rows.length) console.log('（空）');
  for (const r of rows) {
    console.log(
      `  ${r.id}  ${String(r.status || '-').padEnd(13)} ${String(r.stage || '-').padEnd(18)} ${String(r.title || '').slice(0, 26)}`
    );
  }
} else if (cmd === 'events') {
  const id = argv[1];
  if (!id) {
    console.error('用法：node scripts/post-records.mjs events <momentId>');
    process.exit(1);
  }
  for (const e of listEvents(db, id, 50)) {
    console.log(`  ${new Date(e.ts).toLocaleString('zh-CN')}  ${e.kind}  ${e.detail || ''}`);
  }
} else if (cmd === 'archive') {
  const state = await loadState(config.paths.stateFile);
  const r = archiveOldPosts(state, db, { olderThanDays: Number(flag('days', 45)) });
  await saveState(config.paths.stateFile, state);
  console.log(`搬走 ${r.moved} 条，state.json 保留 ${r.kept} 条`);
} else if (cmd === 'prune') {
  const r = prunePosts(db, { olderThanDays: Number(flag('days', 90)) });
  console.log(`裁剪 ${r.pruned} 条（已挪进事件流水）`);
} else if (cmd === 'manual') {
  cmdManual();
} else {
  console.log('用法：node scripts/post-records.mjs stats|list|events|manual|archive|prune');
}
