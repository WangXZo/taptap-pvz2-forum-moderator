// C11 摄入 CLI（2026-11-17 P1）：把 weekly/评论分析/官方 等内容源增量摄入 facts。
// 用法：node scripts/ingest.mjs --file <items.json> [--clear]
//   items.json = [{text, source, url}]；--clear 摄入后清空队列文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { openDb } from './lib/db.mjs';
import { ingest } from './lib/ingest.mjs';
// argvOf 约定裸参数名；CLI 文档用 --file/--clear → 入口剥前缀（修 P1 遗留：--file/--clear 曾不生效）
const { argOf, has } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const file = argOf('file', 'data/ingest-queue.json');
let items = [];
try { items = JSON.parse(readFileSync(file, 'utf8')); } catch { console.log(`[ingest] 读不到 ${file}，无摄入`); process.exit(0); }
const db = openDb(config.paths.postDbFile);
const stat = await ingest(items, { config, db, log: console.log });
console.log('[ingest] 统计', JSON.stringify(stat));
if (has('clear')) writeFileSync(file, '[]');