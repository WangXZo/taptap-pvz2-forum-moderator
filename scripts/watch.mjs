#!/usr/bin/env node
// 守护循环：**2 分钟检查 + 队列处理**（新到旧，不打断当前）
//
// 用户 2026-11-02 要求：
//   「改成一直跑，每 2 分钟新到旧，重排一次队列，不打断当前」（参考版主管理任务的队列设计）
//   「即加快处理，尝试 WAF 限流边界」
//
// 两个**独立**的节奏（单线程时间片，不是两个并发循环）：
//   ① 检查：每 intervalSeconds（默认 120s）重新取一次最新帖 → 挑出「需要处理」的 → 并入队列 → 重排（新→旧）
//   ② 处理：一直取队首（永远是最新的那条）→ 读评论 → 判定 → 回/夸/沉淀 → 出队
//
// 「不打断当前」：检查**只在两条帖之间**发生 —— 正在处理的那条一定处理完才轮到检查。
//
// 队列里放什么（轻量判定，不读评论，省接口）：
//   · 新帖（状态库里没有）
//   · 上次判成「待回复」但没发出去的
//   · 喊话没回完的
//   · 评论数变了（有人又回帖了 → 可能又有人在喊我们）
//
// 用法：
//   node scripts/watch.mjs                 # 常驻，2 分钟一轮
//   node scripts/watch.mjs --once          # 只跑一轮
//   node scripts/watch.mjs --interval 120  # 自定义检查间隔（秒）
//   node scripts/watch.mjs --dry-run       # 判定但不真发
//   node scripts/watch.mjs --no-reply      # 只采集判定，不回复
//   node scripts/watch.mjs --top 20        # 覆盖每轮条数

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { loadState, STATUS } from './lib/state.mjs';
import { listFeed, WafBlocked } from './lib/http.mjs';
import { openPostDb, isHandled } from './lib/post-records.mjs';
import { runOnce } from './collect.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();
const intervalSec = Number(argOf('--interval', config.watch?.intervalSeconds ?? 120));
const once = has('--once');
const doReply = !has('--no-reply');
const dryRun = has('--dry-run') ? true : config.reply.dryRun !== false;
const top = argOf('--top', null);

const TOP = Number(top ?? config.collect.topN ?? 8);

// ⚠️ 队列**单独存一个文件**，不塞进 state.json。
//    原因（体检发现的真 bug）：state.json 由 collect.mjs 负责读写（它会剪枝、老记录搬库），
//    如果守护循环也持有一份 state.json，两边各写各的 → 后写的把先写的覆盖掉，
//    表现是「剪枝被撤销、老记录反复搬库、同一批帖每轮重复处理」。
//    队列是自己的东西，就用自己的文件，互不干扰。
const QUEUE_FILE = resolve(config.paths.dataDir || resolve(ROOT_DIR(), 'data'), 'watch-queue.json');
function ROOT_DIR() {
  return resolve(fileURLToPath(import.meta.url), '../..');
}
let queue = [];
try {
  queue = JSON.parse(await readFile(QUEUE_FILE, 'utf8'));
  if (!Array.isArray(queue)) queue = [];
} catch {}
queue = queue.map((q) => ({ ...q, id: String(q.id) }));

// 帖子记录库：判断「这个帖子是不是已经处理过」（老记录搬库后 state.json 里没有了）
let db = null;
try {
  db = openPostDb(config);
} catch {}

const saveQueue = async () => {
  await mkdir(dirname(QUEUE_FILE), { recursive: true }).catch(() => {});
  await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 1), 'utf8');
};

console.log('═══════════════════════════════════════');
console.log(
  `  TapTap 论坛答疑守护  |  检查每 ${intervalSec}s  |  队列：新到旧、不打断当前  |  每轮 ${TOP} 条  |  回复 ${doReply ? (dryRun ? 'dry-run' : '开启') : '关闭'}`
);
console.log('  停止：Ctrl+C');
console.log('═══════════════════════════════════════');

/**
 * 检查一轮：重新取最新帖 → 挑出需要处理的 → 并入队列 → 按新到旧重排
 * @returns {Promise<{added:number, total:number, scanned:number}>}
 */
async function checkAndEnqueue() {
  let items = [];
  try {
    const data = await listFeed({
      groupId: config.groupId,
      from: 0,
      limit: Math.max(TOP, 10),
      sort: config.collect.sort || 'created',
      type: config.collect.type,
    });
    items = data.list || [];
  } catch (e) {
    if (e instanceof WafBlocked) console.log('  [WAF] 检查被拦截，本轮跳过（等下一轮）');
    else console.log(`  [FAIL] 检查失败：${e.message}`);
    return { added: 0, total: queue.length, scanned: 0 };
  }

  // 读一次 state（只读，用来判断「这个帖子是不是已经处理过」）——
  // ⚠️ 这里**不能**长期持有 state.json：collect.mjs 会剪枝 + 把老记录搬库，
  //    两边各持一份会互相覆盖（体检踩过：剪枝被撤销 → 同一批帖每 2 分钟重复处理）。
  const state = await loadState(config.paths.stateFile);

  const queued = new Set(queue.map((q) => String(q.id)));
  let added = 0;
  for (const it of items) {
    const m = it.moment || {};
    const id = String(m.id_str || '');
    if (!id || queued.has(id)) continue;
    const p = state.posts[id];
    const commentCount = Number(it.comment_count ?? m.stat?.comments ?? 0);
    // 已经在库里处理过（老记录被搬进 SQLite 了，state.json 里没有）→ 不再重复处理
    if (!p && db && isHandled(db, state, id)) continue;
    // ⚠️ 只在**两边都是数字**时才比评论数。
    //    体检踩过：state 里 scannedComments 可能是 null（没读到评论），而这里算出 0，
    //    null !== 0 永远成立 → 同一批帖每 2 分钟重复入队、重复处理，白烧接口还招 WAF。
    const scannedNum = typeof p?.scannedComments === 'number' ? p.scannedComments : null;
    // 互动信号（用户 2026-11-05）：通知里有人说「回复了我 / @我」→ 这帖要重新读评论
    const interactSignal =
      Boolean(p?.interactPending) || Boolean(state.interactPending?.[String(id)]);
    const need =
      !p || // 新帖
      p.status === STATUS.PENDING || // 上次没发出去
      p.summonPending === true || // 喊话没回完
      interactSignal || // 有人回我/@我 → 待互动
      (scannedNum !== null && scannedNum !== commentCount); // 又有人回帖了（可比时才比）
    if (!need) continue;
    queue.push({
      id,
      publishTime: Number(m.publish_time || m.created_time || 0),
      enqueuedAt: Date.now(),
      why: !p
        ? '新帖'
        : p.status === STATUS.PENDING
          ? '待回复未发出'
          : p.summonPending
            ? '喊话未回完'
            : interactSignal
              ? '有人回我/@我'
              : '评论有更新',
    });
    queued.add(id);
    added++;
  }

  // 重排：新到旧（发布时间倒序；id 兜底）
  queue.sort(
    (a, b) =>
      (Number(b.publishTime) || 0) - (Number(a.publishTime) || 0) || String(b.id).localeCompare(String(a.id))
  );
  if (queue.length > 200) queue = queue.slice(0, 200);
  await saveQueue();

  console.log(`  [检查] 扫了 ${items.length} 条 → 新入队 ${added} 条，队列 ${queue.length} 条（新→旧）`);
  return { added, total: queue.length, scanned: items.length };
}

/** 处理队首一条（最新的那条） */
async function processHead() {
  const head = queue[0];
  if (!head) return { processed: false };
  console.log(`\n  -- 处理 ${head.id}（${head.why || ''}）`);
  try {
    await runOnce({ doReply, dryRun, top: TOP, only: [head.id], quiet: false });
  } catch (e) {
    console.error(`  [处理] 异常：${e.message}`);
  }
  queue = queue.filter((q) => String(q.id) !== String(head.id));
  await saveQueue();
  return { processed: true, id: head.id };
}

let lastCheckAt = 0;
let processed = 0;

// ⚠️ 调度保证：检查**只在两条帖之间**发生 —— 正在处理的那条一定处理完才轮到检查。
//    队列重排按 id 去重/排序，出队也按 id，所以重排不会认错人。
for (;;) {
  // ---------- ① 到点就检查一次（重新获取 + 重排队列） ----------
  const due = Date.now() - lastCheckAt >= intervalSec * 1000;
  if (due) {
    await checkAndEnqueue();
    lastCheckAt = Date.now();
    if (once && !queue.length) {
      console.log('\n--once 模式，结束。');
      break;
    }
  }

  // ---------- ② 处理队首（最新的那条） ----------
  if (queue.length) {
    const r = await processHead();
    if (r.processed) processed++;
    continue;
  }

  if (once) {
    console.log('\n--once 模式，结束。');
    break;
  }

  // 队列空了 → 等到下次检查
  const wait = Math.max(1000, intervalSec * 1000 - (Date.now() - lastCheckAt));
  await sleep(wait);
}

console.log(`\n本次共处理 ${processed} 条，队列剩 ${queue.length} 条`);
