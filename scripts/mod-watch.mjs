#!/usr/bin/env node
// 版主管理任务 · 常驻（检查每 2 分钟一次；处理一直连着跑）
//
// 用户 2026-10-29 的最终要求：
//   「不要求每轮处理量，就一直处理就行，2 分钟重排队列。」
//
// 所以这里有两个**独立的节奏**：
//   ① 检查：每 intervalSeconds（默认 120s = 2 分钟）重新获取一次 → 判定 → 并进队列 → 重排（最新在前）
//   ② 处理：一直从队首取（永远是最新的那条）→ 回复 → 移除 → 出队，中间只等 1s 冷却
//
// 实现上刻意用**单线程时间片调度**（不是两个并发循环）：
//   每处理完一条就看一眼「距上次检查过了 2 分钟没」，够了就插一次检查再接着处理。
//   好处：state 只有一处写、不会两个循环抢着存盘；队列也不会被检查和处理同时改。
//
// 用法：
//   node scripts/mod-watch.mjs                    # 常驻
//   node scripts/mod-watch.mjs --interval 120     # 自定义检查间隔（秒）
//   node scripts/mod-watch.mjs --once --dry-run   # 只检查一次，看看会动哪些帖子
//   node scripts/mod-watch.mjs --reset-cursor     # 首次检查时回溯重扫今天全部

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { loadState } from './lib/state.mjs';
import { makeRunner, doctorOk } from './lib/replier.mjs';
import { checkAndEnqueue, processQueueHead } from './mod-task.mjs';
import { openPostDb } from './lib/post-records.mjs';
import { renderModReport } from './lib/mod-report.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();
const cfg = config.modTasks?.friendRequest || {};
const intervalSec = Number(argOf('--interval', config.modTasks?.intervalSeconds ?? 120));
const once = has('--once');
const dryRun = has('--dry-run');
const resetCursor = has('--reset-cursor');

const state = await loadState(config.paths.modStateFile || config.paths.stateFile);
state.modTask = state.modTask || { cursors: {}, backlog: [] };

// 帖子记录库（逐行写，和 state.json 并存）
let db = null;
try {
  db = openPostDb(config);
} catch (e) {
  console.log(`  [记录] SQLite 不可用（${e.message}）→ 只用 state.json 记账`);
}

const session = config.modTasks?.session || config.reply.session;
const runner = makeRunner({ opencliMain: config.reply.opencliMain, session });

console.log('═══════════════════════════════════════');
console.log(
  `  TapTap 版主管理任务  |  检查每 ${intervalSec}s  |  处理：一直跑  |  范围 ${cfg.scope || 'today'}  |  session ${session}`
);
console.log(`  目标：${(config.modTasks?.targets || []).map((t) => t.label || t.type).join('、') || '(未配置)'}`);
console.log(`  ${dryRun ? 'dry-run（只检查不处理）' : '真执行（回复 + 移除）'}　停止：Ctrl+C`);
console.log('═══════════════════════════════════════');

if (!dryRun) {
  const d = doctorOk(runner);
  if (!d.ok) {
    console.error(`  [FAIL] opencli 不可用：${d.text.split('\n')[0]}`);
    process.exit(1);
  }
}

let lastCheckAt = 0;
let firstCheck = true;
let processed = 0;

// ⚠️ 调度保证（用户 2026-10-29：「重排队列，不取消正在处理的那条。在处理完，才接新队列。」）：
//    检查（重新获取 + 重排队列）**只在两条帖之间**发生 —— 也就是每次 processQueueHead 返回之后。
//    正在处理的那条一定是处理完（回复+移除+出队）才轮到检查，永远不会被打断。
//    队列重排按 id 去重/排序，出队也按 id，所以重排不会认错人。
for (;;) {
  // ---------- ① 到点就检查一次（重新获取 + 重排队列） ----------
  const due = Date.now() - lastCheckAt >= intervalSec * 1000;
  if (due) {
    try {
      await checkAndEnqueue({
        config,
        cfg,
        state,
        db,
        resetCursor: resetCursor && firstCheck,
        log: console.log,
      });
      // 每次检查顺手刷新报表（待人工移除清单 + 队列 + 已移除）
      await renderModReport({ config, state }).catch(() => {});
    } catch (e) {
      console.error(`  [检查] 异常：${e.message}`);
    }
    lastCheckAt = Date.now();
    firstCheck = false;

    if (once) {
      console.log('\n--once 模式，检查完即结束。');
      break;
    }
  }

  // ---------- ② 一直处理队首（最新那条） ----------
  if (dryRun) {
    await sleep(Math.max(1000, intervalSec * 1000 - (Date.now() - lastCheckAt)));
    continue;
  }

  if (!state.modTask.backlog?.length) {
    // 队列空了：等到下次检查
    const wait = Math.max(1000, intervalSec * 1000 - (Date.now() - lastCheckAt));
    await sleep(wait);
    continue;
  }

  try {
    const r = await processQueueHead({ config, cfg, state, runner, db, log: console.log });
    if (r.processed) processed++;
  } catch (e) {
    console.error(`  [处理] 异常：${e.message}`);
    await sleep(3000);
  }
}

console.log(`\n本次共处理 ${processed} 条，队列剩 ${(state.modTask.backlog || []).length} 条`);
