#!/usr/bin/env node
// 版主管理任务：检查最新 N 条帖子 → 命中「加好友行为」→ 先回固定文本 → 确认发送 → 再「移除」
//
// 用法：
//   node scripts/mod-task.mjs                # 真跑（回复 + 移除）
//   node scripts/mod-task.mjs --dry-run      # 只判定，看看会动哪些帖子（不发不移）
//   node scripts/mod-task.mjs --only <id>    # 只处理某一条（调试用）
//   node scripts/mod-task.mjs --top 10       # 检查条数（默认 10）
//
// 规则来自用户 2026-10-29：
//   「将存在"加好友"、"一起玩"、"好友位"等加好友行为，统一回复一下内容。并移除该帖。」
//   「该内容，使用短冷却检查，处理完等待1s后立即进行下一个」
//
// ⚠️ 顺序很重要：**先回复 → 确认发出 → 再移除**（回复失败就不移除）。
// ⚠️ 「移除」不是删帖 —— TapTap 的「论坛管理 → 移除」只是移出版块，内容仍在、可恢复。

import { loadConfig, argvOf, sleep } from './lib/paths.mjs';
import { listFeed, extractText, MOMENT_URL, WafBlocked } from './lib/http.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';
import { detectFriendRequest, DEFAULT_FIXED_REPLY } from './lib/mod-task.mjs';
import { removePost } from './lib/remove-post.mjs';
import { liteHash } from './lib/util.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

/**
 * 跑一轮版主管理任务
 * @param {object} o
 * @param {boolean} [o.dryRun]
 * @param {number}  [o.top]
 * @param {string}  [o.only]  只处理某个 moment_id
 * @param {Function}[o.log]
 */
export async function runModTask({ dryRun = false, top = null, only = null, log = console.log } = {}) {
  const config = await loadConfig();
  const cfg = config.modTasks?.friendRequest || {};
  if (config.modTasks?.enabled === false || cfg.enabled === false) {
    log('  [管理任务] 已关闭（config.modTasks.enabled=false）');
    return { skipped: true };
  }

  const TOP = Number(top ?? cfg.topN ?? 10);
  const COOLDOWN = Number(cfg.cooldownMs ?? 1000); // 短冷却：处理完等 1s 立即下一个
  const REPLY_TEXT = String(cfg.reply || DEFAULT_FIXED_REPLY);

  const state = await loadState(config.paths.stateFile);

  // ---------- 1. 拉最新 N 条（一次请求） ----------
  let items = [];
  try {
    const data = await listFeed({
      groupId: config.groupId,
      from: 0,
      limit: TOP,
      sort: config.collect.sort || 'created',
      type: config.collect.type,
    });
    items = data.list || [];
    // --only 指定的帖子可能已经被新帖挤出最新 N 条 → 往后翻几页找它
    if (only && !items.some((it) => String(it.moment?.id_str || '') === String(only))) {
      for (let from = TOP; from < TOP * 5; from += TOP) {
        const more = await listFeed({
          groupId: config.groupId,
          from,
          limit: TOP,
          sort: config.collect.sort || 'created',
          type: config.collect.type,
        });
        items = items.concat(more.list || []);
        if (items.some((it) => String(it.moment?.id_str || '') === String(only))) break;
        await sleep(1200);
      }
    }
  } catch (e) {
    if (e instanceof WafBlocked) log('  [管理任务] 被 WAF 拦截，本轮跳过');
    else log(`  [管理任务] 拉取失败：${e.message}`);
    return { skipped: true, reason: e.message };
  }

  log(`\n  [管理任务] 检查最新 ${TOP} 条（冷却 ${COOLDOWN}ms）`);

  // ---------- 2. 逐条判定 ----------
  const targets = [];
  for (const item of items) {
    const m = item.moment || {};
    const id = String(m.id_str || '');
    if (!id) continue;
    if (only && id !== String(only)) continue;
    const { title, text } = extractText(item);
    const hit = detectFriendRequest({ title, text });
    const done = state.posts[id]?.modTask?.removedAt;
    if (hit.hit && !done) {
      targets.push({
        id,
        url: MOMENT_URL(id),
        title: title || text.slice(0, 40),
        author: m.author?.user?.name || '',
        keyword: hit.keyword,
        inviteCode: hit.inviteCode,
        reason: hit.reason,
      });
    }
  }

  if (!targets.length) {
    log('  [管理任务] 没有命中「加好友行为」的帖子');
    return { targets: [], handled: 0 };
  }

  log(`  [管理任务] 命中 ${targets.length} 条：`);
  for (const t of targets) {
    log(`    · ${t.id} 《${t.title.slice(0, 26)}》 ${t.author} —— ${t.reason}`);
  }

  if (dryRun) {
    log('  [管理任务] dry-run：只判定，不回复不移除');
    for (const t of targets) log(`      将回复：「${REPLY_TEXT.slice(0, 40)}…」 → 然后移除`);
    return { targets, handled: 0, dryRun: true };
  }

  // ---------- 3. 处理：先回复 → 确认发出 → 再移除 ----------
  const runner = makeRunner({
    opencliMain: config.reply.opencliMain,
    session: config.reply.session,
  });
  const d = doctorOk(runner);
  if (!d.ok) {
    log(`  [管理任务] opencli 不可用：${d.text.split('\n')[0]}`);
    return { targets, handled: 0, reason: 'opencli_unavailable' };
  }

  let handled = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    log(`\n    -- 《${t.title.slice(0, 30)}》`);

    // 3a. 回固定文本（已经回过就别重复回 —— 中途失败重跑时靠这个字段兜底）
    const alreadyReplied = !!state.posts[t.id]?.modTask?.repliedAt;
    if (alreadyReplied) {
      log('      [跳过] 这条之前已经回过固定文案，直接做移除');
    } else {
    const r = await replyOne({
      runner,
      url: t.url,
      text: REPLY_TEXT,
      config,
      dryRun: false,
      log,
    });
    if (!r.ok) {
      log(`      [跳过] 回复失败（${r.stage}）→ 不移除，转人工`);
      if (state.posts[t.id]) state.posts[t.id].modTask = { ...(state.posts[t.id].modTask || {}), type: 'friend_request', keyword: t.keyword, repliedAt: null, removedAt: null, failed: r.stage };
      await sleep(COOLDOWN);
      continue;
    }
    log('      [OK] 固定文案已发送');
      // 回复发出就立刻落盘：中途失败重跑时不会重复回同一段话
      state.posts[t.id] = {
        ...(state.posts[t.id] || {}),
        modTask: {
          type: 'friend_request',
          keyword: t.keyword,
          inviteCode: t.inviteCode,
          repliedAt: new Date().toISOString(),
          removedAt: null,
        },
        title: t.title,
        url: t.url,
        author: t.author,
      };
      await saveState(config.paths.stateFile, state);
    }

    // 3b. 移除
    const rm = await removePost({ runner, url: t.url, log });
    if (rm.ok) {
      handled++;
      log('      [OK] 已移除');
    } else {
      log(`      [注意] 移除结果待确认（${rm.stage}）`);
    }

    // 3c. 记账
    state.posts[t.id] = {
      ...(state.posts[t.id] || {}),
      modTask: {
        type: 'friend_request',
        keyword: t.keyword,
        inviteCode: t.inviteCode,
        repliedAt: new Date().toISOString(),
        removedAt: rm.ok ? new Date().toISOString() : null,
        stage: rm.stage,
      },
      title: t.title,
      url: t.url,
      author: t.author,
    };

    // 记进「已发文本」—— 同一段固定文案只发一次（这里只用于日志/去重参考）
    const h = liteHash(REPLY_TEXT);
    state.recentReplies = state.recentReplies || {};
    state.recentReplies[h] = {
      text: REPLY_TEXT,
      at: new Date().toISOString(),
      count: (state.recentReplies[h]?.count || 0) + 1,
      postId: t.id,
    };

    await saveState(config.paths.stateFile, state);

    // 3d. 短冷却：处理完等 1s 立刻下一个
    if (i < targets.length - 1) await sleep(COOLDOWN);
  }

  await saveState(config.paths.stateFile, state);
  log(`  [管理任务] 完成：处理 ${handled}/${targets.length} 条`);
  return { targets, handled };
}

if (process.argv[1] && /mod-task\.mjs$/.test(process.argv[1])) {
  await runModTask({
    dryRun: has('--dry-run'),
    top: argOf('--top', null),
    only: argOf('--only', null),
  });
}
