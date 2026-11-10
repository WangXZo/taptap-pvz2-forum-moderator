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
import {
  enqueueNotifyIds,
  enqueueNotifyFromNotes,
  enqueueFeedItem,
  pruneSeen,
  shouldPullSource,
  sortAndCap,
} from './lib/watch-queue.mjs';
import { listNotifications, isAboutMe, ourNames } from './lib/notify.mjs';
import { readWafFlag, setPageFetcher } from './lib/http.mjs';
import { createPageFetcher } from './lib/page-fetch.mjs';
import { ensureSingleInstance } from './lib/single-instance.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

const config = await loadConfig();

// ⚠️ 单实例保护（2026-11-09 改为**端口锁**）：被启动多次会让同一队列被多个进程各处理一遍
//    （重复回复 + 请求翻倍直接招 WAF）。pid 文件锁有竞态，已换成端口占用（原子）。
await ensureSingleInstance({
  name: 'watch',
  port: Number(config.daemon?.ports?.watch ?? 45871),
  log: console.log,
});

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

// ---------------- 拉取节流与 WAF 熔断状态（进程级，内存） ----------------
// 每个源上次拉取的时间戳（ms）—— 三源各自节奏，避免齐拉打爆 WAF
const LAST_PULL = { created: 0, commented: 0, notify: 0 };
// WAF 提示的限频（每 10 分钟提示一次，别刷屏）
let WAF_NOTICE_AT = 0;
// 队列两项之间的最小间隔（用户 2026-11-06：「操作最短间隔 0.3s」）
const MIN_OP_GAP_MS = Number(config.watch?.minOpGapMs ?? 300);

// 页面上下文通道（带登录 Cookie）—— 匿名接口被 WAF 拦时的唯一出路
setPageFetcher(createPageFetcher({ config, log: console.log }));

// ---------------- 已入队指纹（用户 2026-11-06） ----------------
// 「同一帖子因明确回复内容按照内容含义去重，入队 1 次后不再入队」
// 指纹 = 帖子id:评论id（没评论 id 就用内容前 24 字）→ 同一条回复只入队一次；
// 同一帖来了新回复（新 commentId）→ 指纹不同 → 允许再入队一次。
const SEEN_FILE = resolve(
  config.paths.dataDir || resolve(ROOT_DIR(), 'data'),
  'watch-seen.json'
);
let seen = {};
try {
  seen = JSON.parse(await readFile(SEEN_FILE, 'utf8')) || {};
  if (typeof seen !== 'object' || Array.isArray(seen)) seen = {};
} catch {}
const saveSeen = async () => {
  await mkdir(dirname(SEEN_FILE), { recursive: true }).catch(() => {});
  await writeFile(SEEN_FILE, JSON.stringify(pruneSeen(seen, 800), null, 1), 'utf8');
};

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
 * 检查一轮：三个来源合并 → 挑出需要处理的 → 并入队列 → 按新到旧重排
 *
 * 用户 2026-11-06：
 *   「通知（回复、@、呼唤）驱动的帖子也要入队，我提供过接口 cURL。与获取最新列表。都可以加入队列。
 *     而且获取论坛帖子流，也可以切换 sort（created 发布时间降序 / commented 回复时间 / default 推荐），
 *     获取入队信息。」
 *
 * 所以队列有**三个来源**（任一开启都会并入，去重后只重排不删）：
 *   ① sort=created  —— 最新 N 条：新帖
 *   ② sort=commented —— **按回复时间**：能捞到「老帖又有人回」，不只看最新 10 条
 *   ③ 通知接口 type=7 —— 回复我 / @我 / 呼唤我（要 opencli 页面上下文，失败就降级跳过）
 *
 * @returns {Promise<{added:number, total:number, scanned:number}>}
 */
async function checkAndEnqueue() {
  // 读一次 state（只读，用来判断「这个帖子是不是已经处理过」）——
  // ⚠️ 这里**不能**长期持有 state.json：collect.mjs 会剪枝 + 把老记录搬库，
  //    两边各持一份会互相覆盖（体检踩过：剪枝被撤销 → 同一批帖每 2 分钟重复处理）。
  const state = await loadState(config.paths.stateFile);
  const queued = new Set(queue.map((q) => String(q.id)));
  const src = config.watch?.sources || {};
  const nowMs = Date.now();
  let scanned = 0;
  let addedFeed = 0;

  // ⚠️ 用户 2026-11-06：「WAF 拦截，无时间限制，需要人工验证解除」
  //    所以 feed 两源一旦有熔断标记就整体停掉（不重试、不等自动解封），
  //    只保留走**页面上下文**的通知源（带登录 Cookie，不占匿名 IP 配额）。
  const wafFlag = readWafFlag();
  const feedBlocked = Boolean(wafFlag);
  if (feedBlocked && nowMs - WAF_NOTICE_AT > 10 * 60 * 1000) {
    WAF_NOTICE_AT = nowMs;
    console.log('  [WAF] feed 源已熔断（需人工验证，不会自动恢复）：');
    console.log(`        到 Chrome 打开 https://www.taptap.cn 完成人机验证，然后 node scripts/waf.mjs test / clear`);
  }

  /** 拉一次 feed（sort 可切换） */
  const pull = async (sort) => {
    try {
      const data = await listFeed({
        groupId: config.groupId,
        from: 0,
        limit: Math.max(TOP, 10),
        sort,
        type: config.collect.type,
      });
      return data.list || [];
    } catch (e) {
      // WAF 已在 http.mjs 里落标记 + 不再重试，这里只需记一笔
      if (e instanceof WafBlocked) console.log(`  [WAF] ${sort} 被拦截 → 已标记熔断，等人工验证`);
      else console.log(`  [FAIL] ${sort} 检查失败：${e.message}`);
      return [];
    }
  };

  /**
   * 判断一条 feed item 该不该入队
   *
   * ⚠️ **不许再用「评论数变了」当判据**（用户 2026-11-10 明确纠正）：
   *    「不要用统计数量来确认回复，我已经提供『通知-@/回复』接口了。」
   *
   *    原因（当天真事故）：我们自己发一条回复 → 评论数 +1、`commented_time` 刷新
   *    → 这帖重新出现在 `sort=commented` 榜单里，且「评论数变了」成立 → 再次入队
   *    → 因为分享互动的幂等标记只写在 state（记录已被搬进 SQLite，查不到）→ 再回一条
   *    → 自己喂自己，一条分享帖 **10 小时被回了 29 次**。
   *
   *    现在「有没有人回我」只认**通知接口**（type=7：回复我 / @我 / 呼唤我）——
   *    它精准、而且我们自己发的回复不会给自己产生通知，天生不会自我循环。
   */
  const considerItem = (it, fromSort) => {
    const m = it.moment || {};
    const id = String(m.id_str || '');
    if (!id || queued.has(id)) return;
    const p = state.posts[id];
    // 已经在库里处理过（老记录被搬进 SQLite 了，state.json 里没有）→ 不再重复处理
    if (!p && db && isHandled(db, state, id)) return;
    // 互动信号（用户 2026-11-05）：通知里有人说「回复了我 / @我」→ 这帖要重新读评论
    const interactSignal =
      Boolean(p?.interactPending) || Boolean(state.interactPending?.[String(id)]);
    const need =
      !p || // 新帖（且库里没有处理过的记录，见上面的 isHandled）
      p.status === STATUS.PENDING || // 上次没发出去
      p.summonPending === true || // 喊话没回完
      interactSignal; // 有人回我/@我（来自通知接口）
    if (!need) return;
    const okAdd = enqueueFeedItem(queue, queued, {
      id,
      publishTime: Number(m.publish_time || m.created_time || 0),
      why: !p
        ? fromSort === 'commented'
          ? '回复时间榜新帖'
          : '新帖'
        : p.status === STATUS.PENDING
          ? '待回复未发出'
          : p.summonPending
            ? '喊话未回完'
            : interactSignal
              ? '有人回我/@我'
              : '评论有更新',
    });
    if (okAdd) addedFeed++;
  };

  // ① 最新（发布时间降序）—— 每 createdEverySeconds 一次
  if (
    src.created !== false &&
    !feedBlocked &&
    shouldPullSource({
      lastAt: LAST_PULL.created,
      everyMs: Number(src.createdEverySeconds ?? 300) * 1000,
      nowMs,
    })
  ) {
    LAST_PULL.created = nowMs;
    const items = await pull(config.collect.sort || 'created');
    scanned += items.length;
    for (const it of items) considerItem(it, 'created');
  }

  // ② 按回复时间（能捞到「老帖又有人回」）—— 每 commentedEverySeconds 一次（默认最慢，它最费请求）
  if (
    src.commented !== false &&
    !feedBlocked &&
    shouldPullSource({
      lastAt: LAST_PULL.commented,
      everyMs: Number(src.commentedEverySeconds ?? 900) * 1000,
      nowMs,
    })
  ) {
    LAST_PULL.commented = nowMs;
    const items = await pull('commented');
    scanned += items.length;
    for (const it of items) considerItem(it, 'commented');
  }

  // ③ 通知（回复 / @ / 呼唤）—— 走页面上下文，不占匿名 IP 配额，所以跟队列重排同频
  let addedNotify = 0;
  if (
    src.notify !== false &&
    shouldPullSource({
      lastAt: LAST_PULL.notify,
      everyMs: Number(src.notifyEverySeconds ?? 120) * 1000,
      nowMs,
    })
  ) {
    LAST_PULL.notify = nowMs;
    try {
      const notes = await listNotifications({ config, log: console.log });
      const names = ourNames(state, config);
      const noteCfg = { ...config, ourNames: names };
      // ⚠️ 通知列表是滚动保留的：已处理完的帖还一直在里面。
      //    不排除的话每轮都重新入队 → 队列永远清不空（2026-11-06 真踩到，队列从 5 条涨到 7 条）。
      const shouldSkipNotify = (id) => {
        const p = state.posts[id];
        if (p) {
          const done = p.status === STATUS.REPLIED || p.status === STATUS.NO_NEED;
          // 已有结论、且没有待处理的互动标记 → 不再因为通知重复入队
          return done && !p.interactPending;
        }
        // state 里没有（老记录搬库了）→ 问记录库
        return Boolean(db && isHandled(db, state, id));
      };
      const r = enqueueNotifyFromNotes(
        queue,
        notes,
        queued,
        (n) => isAboutMe(n, noteCfg),
        shouldSkipNotify,
        seen
      );
      addedNotify += r.added;
      if (r.added) await saveSeen(); // 入队即记账：这些通知以后不再入
      if (r.dup) console.log(`  [通知] ${r.dup} 条是已入队过的同一条回复 → 不再重复入队`);
      if (r.skipped) console.log(`  [通知] ${r.skipped} 条已处理过 → 跳过（不进队列）`);
    } catch (e) {
      console.log(`  [通知] 拉取失败（本轮只靠 feed 两个源）：${e.message}`);
    }
  }

  // ④ 兜底：collect 已经写进 state 的互动标记（老帖/被搬库的也能捞回来）
  const fromState = enqueueNotifyIds(queue, state, queued);
  addedNotify += fromState.added;

  queue = sortAndCap(queue, 200);
  await saveQueue();

  const parts = [];
  if (addedFeed) parts.push(`feed ${addedFeed}`);
  if (addedNotify) parts.push(`通知 ${addedNotify}`);
  console.log(
    `  [检查] 扫了 ${scanned} 条（created+commented）→ 新入队 ${addedFeed + addedNotify} 条` +
      (parts.length ? `（${parts.join(' + ')}）` : '') +
      `，队列 ${queue.length} 条（新→旧）`
  );
  return { added: addedFeed + addedNotify, total: queue.length, scanned, notify: addedNotify };
}

/** 处理队首一条（最新的那条）—— 严格**逐个**处理，处理完才出队 */
async function processHead() {
  const head = queue[0];
  if (!head) return { processed: false };
  console.log(`\n  -- 处理 ${head.id}（${head.why || ''}）`);
  try {
    // needsComments=true（通知驱动的帖）→ 强制重新读评论：
    // 楼中楼回复不一定改顶层评论数，不强制读就会漏掉玩家的回信
    await runOnce({
      doReply,
      dryRun,
      top: TOP,
      only: [head.id],
      quiet: false,
      forceComments: Boolean(head.needsComments),
    });
  } catch (e) {
    console.error(`  [处理] 异常：${e.message}`);
  }
  queue = queue.filter((q) => String(q.id) !== String(head.id));
  await saveQueue();
  // 用户 2026-11-06：「操作最短间隔 0.3s」—— 两条帖之间至少停这么久，别连珠炮
  await sleep(MIN_OP_GAP_MS);
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
