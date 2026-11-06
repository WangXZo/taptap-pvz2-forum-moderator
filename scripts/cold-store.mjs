#!/usr/bin/env node
// 冷库 CLI（帖子维度的冷数据，2026-11-02）
//
// 用法：
//   node scripts/cold-store.mjs stats                    # 冷库统计（按类别）
//   node scripts/cold-store.mjs list [--category q] [--limit 20]   # 看冷库里的帖
//   node scripts/cold-store.mjs search "困难6怎么过"       # 向量检索冷库（以前有人问过吗）
//   node scripts/cold-store.mjs wake <id> --reason "手动唤醒"        # 手动把某条冷帖搬回热数据
//
// 说明：冷数据不是删掉，是「凉但还在」—— 带着向量，以后遇到相似问题还能捞出来参考。

import { loadConfig } from './lib/paths.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { openPostDb } from './lib/post-records.mjs';
import { coldStats, coldRows, searchCold, markWoken } from './lib/cold-store.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const config = await loadConfig();
const db = openPostDb(config);

if (cmd === 'stats') {
  const s = coldStats(db);
  console.log(`冷库帖子：${s.total} 条`);
  for (const [cat, n] of Object.entries(s.byCategory)) {
    console.log(`  ${cat.padEnd(10)} ${n} 条`);
  }
  const total = db.prepare('SELECT COUNT(*) c FROM post_cold').get()?.c ?? 0;
  const woken = db.prepare('SELECT COUNT(*) c FROM post_cold WHERE woken_at IS NOT NULL').get()?.c ?? 0;
  console.log(`历史累计（含已唤醒）：${total} 条，已唤醒回热：${woken} 条`);
} else if (cmd === 'list') {
  const category = argOf('--category');
  const limit = Number(argOf('--limit', 20));
  const rows = coldRows(db, { limit: 500 }).filter((r) => !category || r.category === category).slice(0, limit);
  if (!rows.length) console.log('（冷库是空的）');
  for (const r of rows) {
    const days = Math.round((Date.now() - Number(r.last_interaction_at || r.cold_at || 0)) / 86400000);
    console.log(
      `  [${r.category}] ${r.id}  ${String(r.title || '').slice(0, 28)}  ` +
        `作者 ${r.author || '-'}  凉 ${days} 天  评论 ${r.comment_count}`
    );
  }
} else if (cmd === 'search') {
  const q = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ') || argOf('--q', '');
  if (!q) {
    console.log('用法：node scripts/cold-store.mjs search "关键词"');
    process.exit(1);
  }
  const hits = searchCold(db, q, { topN: 8 });
  if (!hits.length) console.log('冷库里没有相似的帖子');
  for (const h of hits) {
    console.log(`  ${h.score}  [${h.category}] ${String(h.title || '').slice(0, 30)}  ${h.id}`);
    if (h.text) console.log(`        ${String(h.text).slice(0, 70).replace(/\s+/g, ' ')}`);
  }
} else if (cmd === 'wake') {
  const id = argv[1];
  if (!id) {
    console.log('用法：node scripts/cold-store.mjs wake <id>');
    process.exit(1);
  }
  const reason = argOf('--reason', '手动唤醒');
  const state = await loadState(config.paths.stateFile);
  const row = db.prepare('SELECT * FROM post_cold WHERE id = ?').get(String(id));
  if (!row) {
    console.log(`冷库里没有 ${id}`);
    process.exit(1);
  }
  markWoken(db, id, reason);
  state.posts = state.posts || {};
  state.posts[String(id)] = {
    ...(state.posts[String(id)] || {}),
    id: String(id),
    url: row.url,
    title: row.title,
    author: row.author,
    author_id: row.author_id,
    publishTime: row.publish_time,
    status: 'pending',
    wokenAt: new Date().toISOString(),
    wakeReason: reason,
  };
  await saveState(config.paths.stateFile, state);
  console.log(`已唤醒 ${id} → 回到热数据（状态 pending，下轮重新判定）`);
} else {
  console.log(`用法：
  node scripts/cold-store.mjs stats
  node scripts/cold-store.mjs list [--category question] [--limit 20]
  node scripts/cold-store.mjs search "困难6怎么过"
  node scripts/cold-store.mjs wake <id> --reason "手动唤醒"`);
}
