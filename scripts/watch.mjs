#!/usr/bin/env node
// 守护模式：每 N 分钟跑一轮（默认 10 分钟，每轮 1 次列表请求）
//
// 用法：
//   node scripts/watch.mjs                 # 常驻，10 分钟一轮
//   node scripts/watch.mjs --once          # 只跑一轮
//   node scripts/watch.mjs --interval 600  # 自定义间隔（秒）
//   node scripts/watch.mjs --dry-run       # 判定但不真发
//   node scripts/watch.mjs --no-reply      # 只采集判定，不回复
//   node scripts/watch.mjs --top 20        # 覆盖每轮条数

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { runOnce } from './collect.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();
const intervalSec = Number(argOf('--interval', config.watch?.intervalSeconds ?? 600));
const once = has('--once');
const doReply = !has('--no-reply');
const dryRun = has('--dry-run') ? true : config.reply.dryRun !== false;
const top = argOf('--top', null);

console.log('═══════════════════════════════════════');
console.log(`  TapTap 论坛答疑守护  |  间隔 ${intervalSec}s  |  每轮 ${top ?? config.collect.topN} 条  |  回复 ${doReply ? (dryRun ? 'dry-run' : '开启') : '关闭'}`);
console.log('  停止：Ctrl+C');
console.log('═══════════════════════════════════════');

let round = 0;
for (;;) {
  round++;
  try {
    await runOnce({ doReply, dryRun, top });
  } catch (e) {
    console.error(`[第 ${round} 轮] 异常：${e.message}`);
  }

  if (once) {
    console.log('\n--once 模式，结束。');
    break;
  }

  const next = new Date(Date.now() + intervalSec * 1000);
  console.log(`\n  下一轮：${next.toLocaleTimeString('zh-CN')}（${intervalSec}s 后）`);
  await sleep(intervalSec * 1000);
}
