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
import { listFeed, WafBlocked, activityTime } from './lib/http.mjs';
import { fetchWindow, createCursorStore } from './lib/window-fetch.mjs';
import { openPostDb, isHandled, hasDoneEvent, markDoneEvent } from './lib/post-records.mjs';
import { pickCodeMatches, buildCodeMatchText } from './lib/code-match.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';
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

// ---------------- 📉 场景负反馈（跨帖）· 队列侧 ----------------
// 用户 2026-11-12：玩家反感某类行为 → **跨帖**收敛这一类：
//   ① 队列里该场景的帖子**踢出**（冷却：全踢；降权：只留最新一条，其余踢）
//   ② 踢掉的帖子**不再入队**（写独立凭据文件，到期自动解禁）
//   ③ 场景标签由 collect 写（state.posts[id].scene）—— 比按标题猜准
//
// ⚠️ 凭据**不能写 state.json**：state.json 归 collect.mjs 管，watch 长期持有会互相覆盖
//    （两边各持一份 → 剪枝被撤销 → 同一批帖每 2 分钟重复处理，这个坑踩过）。
//    所以用独立文件 data/watch-scene-skip.json，watch 独占读写。
import { sceneGate, resolveBands, CHATTER_SCENES, SCENE_LABEL } from './lib/scene-feedback.mjs';

const SCENE_SKIP_FILE = resolve(
  config.paths.dataDir || resolve(ROOT_DIR(), 'data'),
  'watch-scene-skip.json'
);
let sceneSkips = {};
try {
  sceneSkips = JSON.parse(await readFile(SCENE_SKIP_FILE, 'utf8')) || {};
  if (typeof sceneSkips !== 'object' || Array.isArray(sceneSkips)) sceneSkips = {};
} catch {}
const saveSceneSkips = async () => {
  await mkdir(dirname(SCENE_SKIP_FILE), { recursive: true }).catch(() => {});
  await writeFile(SCENE_SKIP_FILE, JSON.stringify(sceneSkips, null, 1), 'utf8');
};

/** 这个帖是不是被「场景收敛」踢过、且还没解禁 */
function sceneSkipActive(id, nowMs = Date.now()) {
  const sk = sceneSkips[String(id || '')];
  if (!sk) return false;
  if (sk.until && nowMs < Number(sk.until)) return true;
  if (sk.until) delete sceneSkips[String(id || '')]; // 过期 → 自动解禁
  return false;
}

/**
 * 按场景收敛队列（跨帖：按**场景**算，不按帖）
 * @returns {{removed:number, kept:number}}
 */
function applySceneGateToQueue(q, state, { nowMs = Date.now(), log = console.log } = {}) {
  const sf = config.sceneFeedback || {};
  const bands = resolveBands(sf);
  const skipMs = Number(sf.skipMinutes ?? 60) * 60 * 1000;
  const halfLifeMs = Number(sf.halfLifeHours ?? 24) * 3600 * 1000;
  const removed = [];
  const seenScene = new Map(); // 降权时每个场景只留最新一条（队列已按新→旧排）
  const keep = [];
  for (const item of q) {
    const id = String(item.id || '');
    const scene = state?.posts?.[id]?.scene;
    if (!scene || !CHATTER_SCENES.includes(scene)) {
      keep.push(item);
      continue;
    }
    const g = sceneGate(state, scene, { nowMs, bands, halfLifeMs });
    if (!g.ok) {
      removed.push({ item, scene, reason: g.reason }); // 冷却 → 该场景全踢
      continue;
    }
    if (g.level === 'downgraded') {
      if (!seenScene.has(scene)) {
        seenScene.set(scene, true);
        keep.push(item);
      } else {
        removed.push({ item, scene, reason: `场景「${SCENE_LABEL[scene]}」已降权 → 只回最新一条` });
      }
      continue;
    }
    keep.push(item);
  }
  for (const { item, scene, reason } of removed) {
    sceneSkips[String(item.id || '')] = {
      scene,
      at: new Date().toISOString(),
      until: nowMs + skipMs,
      reason,
    };
  }
  if (removed.length) {
    const byScene = {};
    for (const r of removed) byScene[r.scene] = (byScene[r.scene] || 0) + 1;
    log(
      `  [场景] 队列踢出 ${removed.length} 条（跨帖）：` +
        Object.entries(byScene)
          .map(([s, n]) => `${SCENE_LABEL[s] || s}×${n}`)
          .join('、') +
        ` → 解禁前不再入队`
    );
  }
  return { removed: removed.length, kept: keep.length, keep };
}

// ---------------- 动态窗口游标（通用模块，2026-11-10） ----------------
// 每个源记住「上次扫到的最老一条的时间」。下次从最新往回翻，翻到比它还老就停。
// 存盘是为了**重启不丢**：否则每次重启都要从头翻，白烧接口。
const CURSOR_FILE = resolve(
  config.paths.dataDir || resolve(ROOT_DIR(), 'data'),
  'watch-cursor.json'
);
const CURSOR = createCursorStore(CURSOR_FILE);
const saveCursor = () => CURSOR.save();

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
  // 人工解除（scene-admin）可能改了踢出凭据 → 每轮重读，让解除即时生效，不用重启
  try {
    const fresh = JSON.parse(await readFile(SCENE_SKIP_FILE, 'utf8')) || {};
    if (fresh && typeof fresh === 'object' && !Array.isArray(fresh)) sceneSkips = fresh;
  } catch {}
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

  /**
   * 一条帖子的「时间轴」—— **按源取不同的字段**（2026-11-10 踩到）
   *
   * `sort=created`  → 用 `publish_time`（发帖时间）
   * `sort=commented`→ 必须用 `commented_time`（最后回复时间）！
   *   错用 publish_time 的后果：`commented` 榜里全是「老帖被顶」，publish_time 能是 2022 年
   *   → 游标一下跳到 2022 → 之后每轮都要翻满 maxPages 页去追那个游标 → 白烧接口、招 WAF。
   */
  const timeOf = (it, sort) => {
    const m = it.moment || {};
    if (sort === 'commented') {
      const t = Number(m.commented_time || m.stat?.commented_time || 0);
      if (t) return t * 1000;
    }
    return activityTime(it) * 1000;
  };

  /**
   * 拉 feed —— 走**通用**动态窗口模块（lib/window-fetch.mjs）
   *
   * 动态窗口的算法、游标语义、时间轴选择都在那个模块里，
   * 这里只负责「喂什么数据进去」和「算出这条的时间」。
   */
  const pull = async (sort, cursorMs) => {
    const r = await fetchWindow({
      fetchPage: (p) =>
        listFeed({
          groupId: config.groupId,
          from: p.from,
          limit: p.limit,
          sort,
          type: config.collect.type,
        }),
      cursorMs,
      maxPages: Number(src.maxPages ?? 20),
      timeOf: (it) => timeOf(it, sort),
      nowMs,
      log: (m) => console.log(m),
    });
    if (r.pages > 1) {
      console.log(`  [窗口] ${sort} 翻了 ${r.pages} 页 / ${r.items.length} 条（补历史缺口）`);
    }
    return r;
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
    // 📉 场景冷却中 → 这帖被踢出后就不再入队（用户 2026-11-12，跨帖按场景算）
    if (sceneSkipActive(id, nowMs)) {
      return;
    }
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
  //    ⚠️ 顺手做「天宫码撮合」：这里拿到的是**最新一批帖子**，正好是判断
  //    「5 分钟内有人发了码」+「30 分钟内有人在求码」所需要的原料。
  let pulledForMatch = [];
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
    const r = await pull(config.collect.sort || 'created', CURSOR.get('created'));
    scanned += r.items.length;
    for (const it of r.items) considerItem(it, 'created');
    pulledForMatch = r.items;
    // 游标 = 本轮扫到的**最新**一条（高水位）→ 下次从这里往回翻，深度收敛
    if (r.cursorMs) {
      CURSOR.set('created', r.cursorMs);
      saveCursor();
    }
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
    const r = await pull('commented', CURSOR.get('commented'));
    scanned += r.items.length;
    for (const it of r.items) considerItem(it, 'commented');
    if (r.cursorMs) {
      CURSOR.set('commented', r.cursorMs);
      saveCursor();
    }
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
        // 📉 被场景收敛踢出、还没解禁 → 不再入队（跨帖按场景算）
        if (sceneSkipActive(id, Date.now())) return true;
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

  // ⑤ 天宫码撮合（用户 2026-11-10）
  //    有人**5 分钟内**贴了天宫码 → 把该帖链接发给**30 分钟内**在求码的帖子。
  //    每条发码帖最多通知 3 个求码的人，**新贴优先**；同一对（求码帖×发码帖）只撮合一次。
  //    文案由 buildCodeMatchText 生成，签名由 clampReply 统一追加。
  let matched = 0;
  if (config.codeMatch?.enabled !== false && pulledForMatch.length && !feedBlocked) {
    try {
      const candidates = pulledForMatch.map((it) => {
        const m = it.moment || {};
        return {
          id: String(m.id_str || ''),
          title: m.topic?.title || '',
          text: m.topic?.summary || '',
          publishTime: Number(m.publish_time || m.created_time || 0) * 1000,
        };
      });
      const pairs = pickCodeMatches({
        items: candidates,
        nowMs,
        shareWindowMs: Number(config.codeMatch?.shareWindowMinutes ?? 5) * 60 * 1000,
        askWindowMs: Number(config.codeMatch?.askWindowMinutes ?? 30) * 60 * 1000,
        maxAskersPerShare: Number(config.codeMatch?.maxAskersPerShare ?? 3),
        // 同一对只撮合一次（凭据落事件流水，搬库不影响）
        isDone: (askerId, shareId) =>
          Boolean(db) &&
          hasDoneEvent(db, askerId, 'code_match', { key: 'shareId', value: shareId }),
      });
      if (pairs.length) {
        console.log(`  [撮合] 有 ${pairs.length} 对可撮合（发码帖 ${new Set(pairs.map((p) => p.share.id)).size} 条）`);
        const runner = makeRunner({
          opencliMain: config.reply.opencliMain,
          session: config.reply.session,
        });
        if (!doctorOk(runner).ok) {
          console.log('    [跳过] opencli 不可用');
        } else {
          for (const { asker, share } of pairs) {
            const text = buildCodeMatchText({ share });
            const r = await replyOne({
              runner,
              url: `https://www.taptap.cn/moment/${asker.id}`,
              text,
              config,
              dryRun: false,
              log: console.log,
            });
            if (r.ok) {
              matched++;
              markDoneEvent(db, asker.id, 'code_match', {
                shareId: share.id,
                at: new Date().toISOString(),
              });
              console.log(`    [OK] 已通知 ${asker.id} ← 发码帖 ${share.id}`);
            } else {
              console.log(`    [FAIL] 撮合 ${asker.id} 失败（${r.stage || ''}）`);
            }
            await sleep(Number(config.watch?.minOpGapMs ?? 300));
          }
        }
      }
    } catch (e) {
      console.log(`  [撮合] 本轮跳过：${e.message}`);
    }
  }

  queue = sortAndCap(queue, 200);
  await saveQueue();

  const parts = [];
  if (addedFeed) parts.push(`feed ${addedFeed}`);
  if (addedNotify) parts.push(`通知 ${addedNotify}`);
  if (matched) parts.push(`撮合 ${matched}`);
  console.log(
    `  [检查] 扫了 ${scanned} 条（created+commented）→ 新入队 ${addedFeed + addedNotify} 条` +
      (parts.length ? `（${parts.join(' + ')}）` : '') +
      `，队列 ${queue.length} 条（新→旧）`
  );
  return { added: addedFeed + addedNotify, total: queue.length, scanned, notify: addedNotify, matched, state };
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
    const r = await checkAndEnqueue();
    lastCheckAt = Date.now();
    // 📉 场景收敛（跨帖）：冷却 → 该场景的帖子全踢出；降权 → 只留最新一条
    //    踢掉的写进独立凭据文件 → 解禁前不再入队
    if (r?.state && config.sceneFeedback?.enabled !== false) {
      const g = applySceneGateToQueue(queue, r.state, { nowMs: Date.now(), log: console.log });
      if (g.removed) {
        queue.length = 0;
        queue.push(...g.keep);
        await saveQueue();
        await saveSceneSkips();
      }
    }
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
