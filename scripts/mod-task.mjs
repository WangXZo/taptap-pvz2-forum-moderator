#!/usr/bin/env node
// 版主管理任务：检查帖子 → 命中「加好友行为」→ 先回固定文本 → 确认发送 → 再「移除」
//
// 用法：
//   node scripts/mod-task.mjs                     # 真跑（回复 + 移除）
//   node scripts/mod-task.mjs --dry-run           # 只判定，看看会动哪些帖子（不发不移）
//   node scripts/mod-task.mjs --only <id>         # 只处理某一条（调试用）
//   node scripts/mod-task.mjs --scope today|all   # 扫的范围（默认 today=今天发布的）
//   node scripts/mod-task.mjs --sweep             # 强制全量重扫（无视游标）
//   node scripts/mod-task.mjs --target activity_signup   # 只查某一个子版块
//
// 规则来自用户 2026-10-29：
//   「检查最新的10条帖子…使用短冷却检查，处理完等待1s后立即进行下一个」
//   「将存在"加好友"、"一起玩"、"好友位"、"扩列"等加好友行为，统一回复一下内容。并移除该帖。」
//   「今天存在的加好友帖统一回复并移除」
//   「这个要持续运行，检查无加好友行为，等待2分钟」
//
// ⚠️ 顺序很重要：**先回复 → 确认发出 → 再移除**（回复失败就不移除）。
// ⚠️ 「移除」不是删帖 —— TapTap 的「论坛管理 → 移除」只是移出版块，内容仍在、可恢复。
//
// 【持续运行怎么做到不重复、不漏、又不打爆接口】
//   游标（cursor）记「上次扫到哪一篇了」（按发布时间，不按 id —— 帖子被移除后 id 会消失）。
//   每轮从最新开始扫，扫到游标就停 → 只处理新增的帖子。
//   跨天自动重扫当天全部（新的一天，游标失效）。

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { listFeed, extractText, MOMENT_URL, WafBlocked } from './lib/http.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';
import { detectFriendRequest, checkAuthor, DEFAULT_FIXED_REPLY, startOfToday, todayKey } from './lib/mod-task.mjs';
import { removePost } from './lib/remove-post.mjs';
import { liteHash } from './lib/util.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

/** 扫一个子版块，把该扫的帖子捞出来 */
async function scanTarget({ config, target, scope, maxPages, cursor, log }) {
  const posts = [];
  const dayStart = scope === 'today' ? startOfToday() : null;
  // ⚠️ 停止判据要用**进入本轮时的游标**，不能用下面持续更新的 untilTs ——
  //    feed 是按时间倒序的，每扫一篇 untilTs 都会变旧，
  //    拿它当停止线的话，第二篇就会被误判成「已经扫过了」。
  const stopAt = cursor?.untilTs ?? null;
  let untilTs = stopAt;
  let scanned = 0;
  let pages = 0;

  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await listFeed({
        groupId: target.groupId ?? config.groupId,
        from: page * 10,
        limit: 10,
        sort: config.collect.sort || 'created',
        type: target.type || config.collect.type,
        status: 0,
        with_hot_comment: 'true',
      });
    } catch (e) {
      if (e instanceof WafBlocked) {
        log(`  [WAF] ${target.label} 被拦截，本目标跳过`);
        break;
      }
      throw e;
    }
    const list = data.list || [];
    if (!list.length) break;
    pages++;

    for (const it of list) {
      const m = it.moment || {};
      const id = String(m.id_str || '');
      if (!id) continue;
      const publishTime = Number(m.publish_time || m.created_time || 0);

      // 到游标了 → 后面都是扫过的
      if (stopAt && publishTime && publishTime <= stopAt) {
        return { posts, untilTs, pages, done: true };
      }
      // 不是今天的了 → 今天扫完
      if (dayStart && publishTime && publishTime < dayStart) {
        return { posts, untilTs, pages, done: true };
      }

      const { title, text } = extractText(it);
      posts.push({
        id,
        url: MOMENT_URL(id),
        title: title || text.slice(0, 40),
        text,
        author: m.author?.user?.name || '',
        authorId: String(m.author?.user?.id || ''),
        publishTime,
        commentCount: Number(it.comment_count ?? m.stat?.comments ?? 0),
        moment: m,
      });
      scanned++;
      // 游标 = 扫到的最老一篇（feed 是按时间倒序的）
      if (publishTime) untilTs = publishTime;
    }

    if (list.length < 10) break;
    await sleep(1100);
  }
  return { posts, untilTs, pages, done: false };
}

/**
 * 检查一轮：扫子版块 → 判定 → 并进待办队列 → **按发布时间倒序重排** → 落盘
 *
 * 用户 2026-10-29：「只是重排队列，检查还是2分钟」——
 * 这个函数就是那「2 分钟一次」的检查。它只负责把队列刷新好，不处理任何帖子。
 *
 * @returns {Promise<{backlog:number, fresh:number, skipped:number}>}
 */
export async function checkAndEnqueue({
  config,
  cfg,
  state,
  scope = null,
  targetFilter = null,
  only = null,
  sweep = false,
  resetCursor = false,
  log = console.log,
} = {}) {
  const SCOPE = scope || cfg.scope || 'today';
  const targets = (config.modTasks?.targets || []).filter((t) => !targetFilter || t.type === targetFilter);

  if (resetCursor) {
    state.modTask.cursors = {};
    log('  [检查] 已重置扫描游标');
  }
  if (!state.modTask.cursors) state.modTask.cursors = {};
  if (!Array.isArray(state.modTask.backlog)) state.modTask.backlog = [];

  // ---------- 1. 各目标扫帖子 ----------
  const allTargets = [];
  const pendingCursors = [];
  for (const target of targets) {
    const key = `${target.groupId ?? config.groupId}:${target.type || config.collect.type}`;
    const saved = state.modTask.cursors[key] || {};
    const dayChanged = saved.day !== todayKey();
    const cursor = sweep || dayChanged ? null : saved;

    const { posts, untilTs, pages, done } = await scanTarget({
      config,
      target,
      scope: SCOPE,
      maxPages: sweep || dayChanged ? Number(cfg.maxSweepPages ?? 30) : Number(cfg.maxPages ?? 4),
      cursor,
      log,
    });

    pendingCursors.push({ key, untilTs: untilTs ?? saved.untilTs ?? null, day: todayKey() });
    log(`  [${target.label || key}] 扫了 ${pages} 页 / ${posts.length} 条${done ? '（到边界了）' : '（可能还没扫完）'}`);
    for (const p of posts) allTargets.push({ ...p, targetKey: key, targetLabel: target.label || key });
  }

  // ---------- 2. 判定 ----------
  const hits = [];
  const skipped = [];
  for (const p of allTargets) {
    if (only && p.id !== String(only)) continue;

    // ① 官方/版主/自己发的帖一律跳过（用户要求）
    const who = checkAuthor(p.moment, { myUserId: config.myUserId });
    if (who.official) {
      skipped.push({ ...p, why: who.reason });
      continue;
    }

    const hit = detectFriendRequest({
      title: p.title,
      text: p.text,
      bareCodeIsIntent: cfg.bareCodeIsIntent !== false,
    });
    const done = state.posts[p.id]?.modTask?.removedAt;
    if (hit.hit && !done) {
      hits.push({ ...p, keyword: hit.keyword, inviteCode: hit.inviteCode, reason: hit.reason });
    }
  }

  if (skipped.length) {
    log(`  [检查] 跳过 ${skipped.length} 条（官方/版主/自己的帖）`);
    for (const s of skipped.slice(0, 4)) log(`    ⊘ 《${s.title.slice(0, 22)}》 ${s.author} —— ${s.why}`);
  }

  // ---------- 3. 并进队列 + 去重 + 按最新在前重排 ----------
  const BACKLOG_MAX = Number(cfg.backlogMax ?? 500);
  const doneIds = new Set(
    Object.entries(state.posts)
      .filter(([, p]) => p?.modTask?.removedAt)
      .map(([id]) => String(id))
  );
  const byId = new Map();
  for (const b of [...state.modTask.backlog, ...hits]) {
    const id = String(b.id);
    if (!id || doneIds.has(id)) continue;
    if (!byId.has(id)) byId.set(id, {
      id,
      url: b.url,
      title: b.title,
      author: b.author,
      keyword: b.keyword,
      inviteCode: b.inviteCode || null,
      reason: b.reason,
      publishTime: Number(b.publishTime) || 0,
      // 记下属于哪个子版块：activity_signup 板网页端没有移除入口，只能回复
      targetKey: b.targetKey || b.targetLabel || '',
    });
  }
  state.modTask.backlog = [...byId.values()]
    .sort((a, b) => {
      const ta = Number(a.publishTime) || 0;
      const tb = Number(b.publishTime) || 0;
      if (ta !== tb) return tb - ta;
      return String(b.id).localeCompare(String(a.id)); // id 随时间递增，兜底
    })
    .slice(0, BACKLOG_MAX);

  // 游标落盘（队列已经把待处理的都记下了，推进游标不会丢帖）
  for (const c of pendingCursors) state.modTask.cursors[c.key] = { ...c, at: new Date().toISOString() };
  await saveState(config.paths.stateFile, state);

  const head = state.modTask.backlog[0];
  log(
    `  [检查] 队列 ${state.modTask.backlog.length} 条（本轮新增 ${hits.length}，跳过 ${skipped.length}，已按最新在前重排）` +
      (head ? ` 队首：《${String(head.title).slice(0, 20)}》` : '')
  );
  return { backlog: state.modTask.backlog.length, fresh: hits.length, skipped: skipped.length };
}

/**
 * 处理队首一条（最新的那条）：回复固定文案 → 确认发出 → 移除 → 出队
 *
 * 队列空就返回 {processed:false}。
 * @returns {Promise<{processed:boolean, ok?:boolean, id?:string, stage?:string, left:number}>}
 */
export async function processQueueHead({ config, cfg, state, runner, log = console.log }) {
  const REPLY_TEXT = String(cfg.reply || DEFAULT_FIXED_REPLY);
  const COOLDOWN = Number(cfg.cooldownMs ?? 1000);
  const backlog = state.modTask.backlog || [];
  const t = backlog[0];
  if (!t) return { processed: false, left: 0 };

  log(`\n    -- 《${String(t.title).slice(0, 28)}》 ${t.author || ''}`);

  // 3a. 回固定文本（已回过就跳过 —— 中途失败重跑不重复回）
  if (state.posts[t.id]?.modTask?.repliedAt) {
    log('      [跳过] 之前已经回过固定文案，跳过回复');
  } else {
    const r = await replyOne({ runner, url: t.url, text: REPLY_TEXT, config, dryRun: false, log });
    if (!r.ok) {
      log(`      [跳过] 回复失败（${r.stage}）→ 不移除，转人工（出队）`);
      state.posts[t.id] = {
        ...(state.posts[t.id] || {}),
        modTask: { type: 'friend_request', keyword: t.keyword, inviteCode: t.inviteCode, repliedAt: null, removedAt: null, failed: r.stage },
      };
      state.modTask.backlog = backlog.filter((b) => String(b.id) !== String(t.id));
      await saveState(config.paths.stateFile, state);
      await sleep(COOLDOWN);
      return { processed: true, ok: false, id: t.id, stage: r.stage, left: state.modTask.backlog.length };
    }
    log('      [OK] 固定文案已发送');
    state.posts[t.id] = {
      ...(state.posts[t.id] || {}),
      modTask: { type: 'friend_request', keyword: t.keyword, inviteCode: t.inviteCode, repliedAt: new Date().toISOString(), removedAt: null },
      title: t.title,
      url: t.url,
      author: t.author,
    };
    await saveState(config.paths.stateFile, state);
  }

  // 3b. 移除
  // ⚠️ 活动报名板（activity_signup）**网页端没有「管理」入口**（实测：详情页只有 返回/关注/更多，
  //    列表卡片 ⋯ 只有 转发/分享/投诉）→ 那个板只回复，移除留给人工在 App 里做。
  //    用户 2026-10-29 确认：「只回复 + 报表列待人工移除」。
  const boardType = t.targetKey ? String(t.targetKey).split(':')[1] : '';
  const removable = boardType !== 'activity_signup';

  let ok = false;
  let stage = '';
  if (!removable) {
    log('      [留人工] 活动报名板网页端没有移除入口 → 只回复，记入待人工移除清单');
    state.posts[t.id].modTask.stage = 'manual_remove_needed';
    state.posts[t.id].modTask.board = boardType;
    ok = false;
    stage = 'manual_remove_needed';
  } else {
    const rm = await removePost({ runner, url: t.url, log });
    log(rm.ok ? '      [OK] 已移除' : `      [注意] 移除结果待确认（${rm.stage}）`);
    state.posts[t.id].modTask.removedAt = rm.ok ? new Date().toISOString() : null;
    state.posts[t.id].modTask.stage = rm.ok ? 'removed' : rm.stage;
    ok = !!rm.ok;
    stage = rm.stage;
  }

  // 出队（不管成功没成功都摘掉，避免无限重试；失败的已记在 state.posts）
  state.modTask.backlog = (state.modTask.backlog || []).filter((b) => String(b.id) !== String(t.id));

  const h = liteHash(REPLY_TEXT);
  state.recentReplies = state.recentReplies || {};
  state.recentReplies[h] = {
    text: REPLY_TEXT,
    at: new Date().toISOString(),
    count: (state.recentReplies[h]?.count || 0) + 1,
    postId: t.id,
  };
  await saveState(config.paths.stateFile, state);
  await sleep(COOLDOWN); // 短冷却：处理完等 1s 立刻下一个

  return { processed: true, ok, id: t.id, stage, left: state.modTask.backlog.length };
}

/**
 * 一次性跑完（CLI 用）：检查一轮 → 一直处理到队列空（或跑到 maxPerRound 上限）
 *
 * 常驻请用 scripts/mod-watch.mjs（它把「每 2 分钟检查」和「一直处理」拆成两个节奏）。
 */
export async function runModTask({
  dryRun = false,
  scope = null,
  only = null,
  targetFilter = null,
  sweep = false,
  resetCursor = false,
  log = console.log,
} = {}) {
  const config = await loadConfig();
  const cfg = config.modTasks?.friendRequest || {};
  if (config.modTasks?.enabled === false || cfg.enabled === false) {
    log('  [管理任务] 已关闭（config.modTasks.enabled=false）');
    return { skipped: true };
  }

  const state = await loadState(config.paths.stateFile);
  state.modTask = state.modTask || { cursors: {}, backlog: [] };

  log(`\n  [管理任务] 检查中（范围：${(scope || cfg.scope || 'today') === 'today' ? '今天' : '全部'}）`);
  const q = await checkAndEnqueue({ config, cfg, state, scope, targetFilter, only, sweep, resetCursor, log });

  if (dryRun) {
    log('  [管理任务] dry-run：只检查不处理');
    return { ...q, dryRun: true };
  }
  if (!q.backlog) return { ...q, handled: 0 };

  const session = config.modTasks?.session || config.reply.session;
  const runner = makeRunner({ opencliMain: config.reply.opencliMain, session });
  const d = doctorOk(runner);
  if (!d.ok) {
    log(`  [管理任务] opencli 不可用：${d.text.split('\n')[0]}`);
    return { ...q, handled: 0, reason: 'opencli_unavailable' };
  }

  // maxPerRound > 0 才限制；0/不配 = 一直处理到队列空
  const cap = Number(cfg.maxPerRound ?? 0);
  let handled = 0;
  let n = 0;
  while (state.modTask.backlog?.length) {
    if (cap > 0 && n >= cap) break;
    const r = await processQueueHead({ config, cfg, state, runner, log });
    if (!r.processed) break;
    n++;
    if (r.ok) handled++;
  }

  const left = (state.modTask.backlog || []).length;
  log(`  [管理任务] 完成：处理 ${n} 条（成功移除 ${handled}）${left ? `，队列还剩 ${left} 条` : '，队列已清空'}`);
  return { ...q, handled, processed: n, backlog: left };
}

if (process.argv[1] && /mod-task\.mjs$/.test(process.argv[1])) {
  await runModTask({
    dryRun: has('--dry-run'),
    scope: argOf('--scope', null),
    only: argOf('--only', null),
    targetFilter: argOf('--target', null),
    sweep: has('--sweep'),
    resetCursor: has('--reset-cursor'),
  });
}
