// 插件：ingest（增量知识摄入，P4-b，2026-11-19）
//
// 从 collect 的每日整理调用（scheduled 钩子）。做的事：
//   ① 按 config.ingest.sources 抓各源新增内容（游标增量，data/ingest-cursor.json）
//   ② 交给 lib/ingest.mjs 抽取 → facts + fact_sources
//   ③ 交给 C2 自治治理（govern）合并冲突/校准置信
//
// 安全边界（大哥约束）：只摄**零风险源**（官方公告 url / 本地周报 md）；
//   评价与评论类源涉及接口权限与 WAF，留待单独确认后再加。
//   置信闸：抽出的 fact 非官方且置信<70 不入库（在 facts-expand/ingest 侧已有闸，这里再加一道源级白名单）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectSources } from '../lib/ingest-sources.mjs';
import { ingest } from '../lib/ingest.mjs';
import { SKILL_ROOT } from '../lib/paths.mjs';

const cursorFile = (config) => resolve(String(config?.paths?.dataDir || resolve(SKILL_ROOT, 'data')).replace(/\{\{SKILL\}\}/g, SKILL_ROOT), 'ingest-cursor.json');

function loadCursors(config) {
  try { return JSON.parse(readFileSync(cursorFile(config), 'utf8')); } catch { return {}; }
}
function saveCursors(config, cursors) {
  try {
    const f = cursorFile(config);
    mkdirSync(resolve(f, '..'), { recursive: true });
    writeFileSync(f, JSON.stringify(cursors, null, 2));
  } catch {}
}

export default {
  id: 'ingest',
  name: '增量摄入',

  /**
   * @param {object} ctx {config, log, db, dryRun, fetchImpl?, weeklyDir?}
   * @returns {{items:number, stat?:object, bySource:object, dryRun:boolean}}
   */
  async scheduled(ctx = {}) {
    const { config = {}, log = () => {}, db = null, dryRun = false, fetchImpl = null, weeklyDir = null } = ctx;
    if (config.ingest?.enabled === false) return { items: 0, bySource: {}, dryRun };
    if (!db) return { items: 0, bySource: {}, dryRun, error: 'no_db' };

    const cursors = loadCursors(config);
    const got = await collectSources(config, cursors, { fetchImpl, weeklyDir });
    const n = got.items.length;
    if (!n) {
      log('  [摄入] 各源无新增');
      return { items: 0, bySource: got.bySource, dryRun };
    }
    if (dryRun) {
      log(`  [摄入] dry-run：抓到 ${n} 条新增（${JSON.stringify(got.bySource)}），不写入`);
      return { items: n, bySource: got.bySource, dryRun: true };
    }
    try {
      const stat = await ingest(got.items, { config: config, db: db, log: log });
      saveCursors(config, got.cursors); // 成功才推进游标（失败下轮重试）
      log(`  [摄入] 新增 ${n} 条 → facts+${stat.fact ?? 0}（qa ${stat.qa ?? 0} / talk ${stat.talk ?? 0} / 失败 ${stat.fail ?? 0}）｜来源 ${JSON.stringify(got.bySource)}`);
      return { items: n, stat, bySource: got.bySource, dryRun: false };
    } catch (e) {
      log(`  [摄入] 失败（${e.message}）→ 游标不推进，下轮重试`);
      return { items: n, bySource: got.bySource, dryRun: false, error: e.message };
    }
  },
};