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

const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const config = await loadConfig();
const db = openPostDb(config);

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
} else {
  console.log('用法：node scripts/post-records.mjs stats|list|events|archive|prune');
}
