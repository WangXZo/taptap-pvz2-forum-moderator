#!/usr/bin/env node
// 单轮：抓最新 N 条（按发布时间）→ 判定四类标记 → 回复 / 沉淀答疑库 → 出报表
//
// 用法：
//   node scripts/collect.mjs               # 只采集判定
//   node scripts/collect.mjs --dry-run     # 采集 + 预览回复（不发）
//   node scripts/collect.mjs --reply       # 采集 + 真发
//   node scripts/collect.mjs --top 20      # 覆盖配置里的 N

import { loadConfig, argvOf, sleep, SKILL_ROOT } from './lib/paths.mjs';
import { listFeed, listComments, extractText, MOMENT_URL, WafBlocked } from './lib/http.mjs';
import { isOurComment, isSummonText, teamUserIdsOf, commentText } from './lib/signature.mjs';
import { assertKind } from './lib/summon.mjs';
import { sendSummonReply } from './lib/summon-send.mjs';
import { pickInteractions, decideInteraction, replyTargetFor, playerKey } from './lib/interact.mjs';
import { sendInteractReply } from './lib/interact-send.mjs';
import { loadQaLibrary, looksLikeQuestion, looksLikeShare } from './lib/qa.mjs';
import { openDb } from './lib/db.mjs';
import { openPostDb, archiveOldPosts, pruneStatePosts, recordScanned, recordStatus } from './lib/post-records.mjs';
import { openPraiseDb, recentPraiseTexts } from './lib/praise-store.mjs';
import { buildThreadTree } from './lib/thread-context.mjs';
import { composeReply as composeLlmReply, condenseMaterial } from './lib/compose-reply.mjs';
import {
  archiveToCold,
  coldRows,
  wakeUp,
  wakeByNotifications,
  classifyPost,
  coldTtlDays,
  searchCold,
  coldStats,
  isCold,
} from './lib/cold-store.mjs';
import { listNotifications, isAboutMe, ourNames } from './lib/notify.mjs';
import { buildIndex, search, makeHttpDense, indexVersion, VEC_VERSION } from './lib/qa-vector.mjs';
import { loadState, saveState, hashText, normKey, STATUS, REASON } from './lib/state.mjs';
import { classify } from './lib/classify.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';
import { getTapApi } from './lib/taptap-api.mjs';
import { parseEmojiSegments } from './lib/emoji.mjs';
import { buildQaEntry, appendQaEntry } from './lib/summarize.mjs';
import { pickPraiseTarget } from './lib/praise.mjs';
import { replyToComment } from './lib/reply-nested.mjs';
import { sendPraise } from './lib/praise-send.mjs';
import { assertNoLeak } from './lib/variants.mjs';
import { answerPromisesCode, looksLikeCodeAsk, looksLikeCodeShare } from './lib/code-guard.mjs';
import { liteHash } from './lib/util.mjs';
import { loadUsage, saveUsage, recordCitation, statOf, shouldArchive, entryKeyOf } from './lib/usage.mjs';
import { archiveStale } from './lib/archive.mjs';
import { shouldHealthCheck, purgeTagged, tagsFromConfig } from './lib/qa-health.mjs';

const argv = process.argv.slice(2);
const { has, argOf } = argvOf(argv);

/**
 * 摊平评论树（含楼中楼），保留父评论 id
 * @returns {Array<{c:object, parentId:string|null}>}
 */
function flattenAll(list) {
  const out = [];
  for (const c of list || []) {
    out.push({ c, parentId: null });
    for (const ch of c.child_posts || []) out.push({ c: ch, parentId: String(c.id_str || '') });
  }
  return out;
}

/**
 * 同一个玩家在「互动候选」里出现了几次 → 连续追问次数
 *
 * 用户 2026-11-05 的例外之一：「连续追问 → 必回」。
 * 这里按「该玩家在候选里出现 ≥2 次」算连续追问（纯客套早已被过滤掉）。
 */
function countFollowUps(candidates, cand) {
  const key = String(cand?.authorId || cand?.author || '');
  return (candidates || []).filter((c) => String(c?.authorId || c?.author || '') === key).length;
}

/**
 * 构造「这一楼在聊什么」的上下文
 *
 * 用户 2026-11-02：「请检查此帖子，标题、内容、各玩家回复、楼中楼内容，作为上下文资料，
 *                   判断后，自行思考编辑对话内容，回复相关内容。」
 *
 * 所以上下文要齐四样：帖子标题、正文、各玩家的一级回复、楼中楼回复。
 * 只留文本（摊平后的纯文字），长度砍到能塞进一条楼中楼回复的量级。
 */
function buildPostContext({ post, flat, config }) {
  const max = Number(config.summon?.contextReplies ?? 6);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const replies = [];
  for (const { c } of flat) {
    const t = clean(commentText(c));
    if (!t) continue;
    replies.push({
      author: c.author?.name || '',
      text: t.slice(0, 120),
      isChild: Boolean(c.parent_post_id) || false,
    });
    if (replies.length >= max) break;
  }
  return {
    title: clean(post.title).slice(0, 40),
    text: clean(post.text).slice(0, 200),
    replies,
  };
}

/**
 * 从摊平的评论里挑出「玩家在喊我们」的几条（已回过的不算）
 *
 * 优先序：① 明确点了签名 ② 只是喊「版主」 ③ 时间新的优先
 * 单帖上限 config.summon.maxPerPost（默认 1）—— 一帖里被喊好几次只回一次，别刷屏。
 *
 * @param context 帖子上下文（标题/正文/其他人的回复）—— 用来让回复「看得懂这一楼在聊什么」
 */
function pickSummons(flat, { config, teamIds, prev, context = null }) {
  const done = new Set((prev?.summonReplied || []).map(String));
  const perPost = Math.max(1, Number(config.summon?.maxPerPost ?? 1));
  const out = [];

  for (const { c, parentId } of flat) {
    const commentId = String(c.id_str || '');
    if (!commentId || done.has(commentId)) continue;
    if (isOurComment(c, { config, teamIds })) continue; // 自己/队友发的不算
    const text = commentText(c);
    if (!text) continue;
    const hit = isSummonText(text, config);
    if (!hit.summon) continue;
    out.push({
      commentId,
      parentId,
      author: c.author?.name || '',
      authorId: String(c.author?.id || ''),
      text,
      why: hit.why || '',
      alias: hit.alias || null,
      time: Number(c.created_time || 0),
      prio: hit.why === 'signature' ? 1 : 0,
      context, // ← 上下文随候选一起带走（回复要用它组织内容）
    });
  }

  out.sort((a, b) => b.prio - a.prio || b.time - a.time);
  return out.slice(0, perPost);
}

/**
 * 队列模式：按 id 取帖（先用最新列表；滑出窗口的用只读详情接口补）
 *
 * 为什么需要：守护循环改成「2 分钟检查 + 队列处理」后，队首那条可能已经不在最新 N 条里了，
 * 但它还没处理完 —— 不能因为滑出窗口就丢掉。详情接口是只读的，且移除过的帖也能取到。
 */
async function fetchItemsByIds(ids, { config, top, log = () => {} }) {
  const want = new Set(ids.map(String));
  const out = [];
  try {
    const data = await listFeed({
      groupId: config.groupId,
      from: 0,
      limit: Math.max(Number(top ?? config.collect.topN ?? 8), 10),
      sort: config.collect.sort || 'created',
      type: config.collect.type,
    });
    for (const it of data.list || []) {
      const id = String(it.moment?.id_str || '');
      if (want.has(id)) {
        out.push(it);
        want.delete(id);
      }
    }
  } catch (e) {
    if (e instanceof WafBlocked) log('  [WAF] 取列表被拦截');
    else log(`  [FAIL] 取列表失败：${e.message}`);
  }
  // 还缺的（滑出最新窗口）→ 详情接口补
  for (const id of want) {
    const it = await fetchMomentItem(id, { config });
    if (it) out.push(it);
    else log(`  [队列] ${id} 已滑出窗口且取不到详情 → 本轮跳过`);
  }
  return out;
}

/** 用只读详情接口拼一个与 feed 等价的 item（字段对齐 lib/http.mjs 的 extractText 所需） */
async function fetchMomentItem(id, { config }) {
  try {
    const runner = makeRunner({ opencliMain: config.reply.opencliMain, session: config.reply.session });
    if (!runner.available) return null;
    const api = getTapApi({ runner });
    if (!api.ensureOrigin().ok) return null;
    const r = await api.get('/webapiv2/moment/v3/detail', { id: String(id) });
    const m = r.json?.data?.moment;
    if (!m) return null;
    const topic = m.topic || {};
    const comments = Number(m.stat?.comments || 0);
    return {
      moment: {
        id_str: String(m.id_str || id),
        topic: { title: topic.title || '', summary: topic.summary || '' },
        author: {
          user: { name: m.author?.user?.name || '', id: String(m.author?.user?.id || '') },
        },
        publish_time: Number(m.publish_time || 0),
        commented_time: Number(m.commented_time || 0),
        stat: { comments },
      },
      comment_count: comments,
    };
  } catch {
    return null;
  }
}

export async function runOnce({ doReply = false, dryRun = true, top = null, only = null, quiet = false } = {}) {
  const config = await loadConfig();
  const qa = await loadQaLibrary(config.paths.qaFile);
  const usage = await loadUsage(config.paths.usageFile);
  const state = await loadState(config.paths.stateFile);
  const TOP = Number(top ?? config.collect.topN ?? 8);
  const log = (...a) => (quiet ? null : console.log(...a));
  /** 我们这边的人（我的 + config.teamUserIds 里列的其他成员） */
  const TEAM_IDS = teamUserIdsOf(config);
  /** 「玩家喊我们」互动开关 */
  const summonOn = config.summon?.enabled !== false;
  /** 「互动续聊」开关（玩家回信我们 → 继续互动，用户 2026-11-05） */
  const interactOn = config.interact?.enabled !== false;

  log(`\n== ${new Date().toLocaleString('zh-CN')} 本轮开始（答疑库 ${qa.length} 条，目标最新 ${TOP} 条）`);

  // ---------- 0z. 向量索引（答疑库改了自动重建） ----------
  //   相似度项 = max(旧 bigram dice, 向量余弦)；向量只加分不扣分。
  //   记录**实际用了哪条路径**（char-tfidf / dense / fallback），出问题好回溯。
  let vecDb = null;
  let vecDense = null;
  let matchPath = null;
  try {
    const { stat } = await import('node:fs/promises');
    const idxFile = config.paths.qaIndexFile || resolve(SKILL_ROOT, 'data/qa-index.sqlite');
    vecDb = openDb(idxFile);
    const qaStat = await stat(config.paths.qaFile).catch(() => null);
    const idxStat = await stat(idxFile).catch(() => null);
    // 索引过期有两种：答疑库改了（mtime 变新）、向量格式变了（版本号对不上）
    const stale =
      !idxStat || (qaStat && qaStat.mtimeMs > idxStat.mtimeMs) || indexVersion(vecDb) !== VEC_VERSION;
    if (stale) {
      const r = buildIndex(vecDb, qa);
      log(`  [向量] 索引已重建（${r.entries} 条 / ${r.tokens} 特征词）`);
    }
    const vcfg = config.qa?.vector || {};
    vecDense = vcfg.backend === 'http' ? makeHttpDense(vcfg) : null;
    matchPath = vecDense ? 'dense' : 'char-tfidf';
  } catch (e) {
    vecDb = null;
    matchPath = null;
    log(`  [向量] 索引不可用（${e.message}）→ 本轮只用原有关键词匹配`);
  }

  // ---------- 0y. 帖子记录库：老记录搬进 SQLite，state.json 只留热数据 ----------  //   解决「记录太多」：state.json 每次都要整份重写，几百条就几百 KB。
  //   搬走的是「已判定完、不再参与判定」的老记录；待回复/需人工的留在 state.json（判重要用）。
  let postDb = null;
  try {
    postDb = openPostDb(config);
    const arch = archiveOldPosts(state, postDb, { olderThanDays: Number(config.archive?.olderThanDays ?? 45) });
    // 按数量再裁一次（用户 2026-11-02：「记录太多」）—— 只留最近 N 条 + 没处理完的
    const cap = pruneStatePosts(state, postDb, { keepMax: Number(config.archive?.keepStatePosts ?? 500) });
    // 运行日志也截断（只留最近 50 轮）
    if (Array.isArray(state.runs) && state.runs.length > 50) state.runs = state.runs.slice(-50);
    const moved = arch.moved + cap.moved;
    if (moved) {
      log(`  [记录] 老记录搬进 SQLite：${moved} 条（state.json 保留 ${cap.kept} 条）`);
      await saveState(config.paths.stateFile, state);
    }
  } catch (e) {
    postDb = null;
    log(`  [记录] SQLite 不可用（${e.message}）→ 只用 state.json 记账`);
  }

  // ---------- 0x. 夸奖向量库：跨天/跨帖避免重复用同一句（用户 2026-11-02） ----------
  let praiseDb = null;
  let praiseHistoryTexts = [];
  try {
    praiseDb = openPraiseDb(config);
    praiseHistoryTexts = recentPraiseTexts(praiseDb, 500);
  } catch (e) {
    praiseDb = null;
    log(`  [夸库] 不可用（${e.message}）→ 只在内存里去重`);
  }

  // ---------- 0. 答疑库备份（每轮一份，防误覆盖） ----------
  // 教训：曾用「构建源」的旧副本覆盖运行中的答疑库，一夜沉淀的 10 条全丢。
  // 现在每轮开始先把当前库备份到 qa/答疑库.backup.md，出问题可一条命令还原。
  try {
    const { copyFile, stat } = await import('node:fs/promises');
    const qaStat = await stat(config.paths.qaFile).catch(() => null);
    if (qaStat && qaStat.size > 0) {
      await copyFile(config.paths.qaFile, `${config.paths.qaFile}.backup.md`).catch(() => {});
    }
  } catch {}

  // ---------- 0b. 每天一次：答疑库体检（剔除「携带自己标签」的条目） ----------
  // 规则：答疑库里不能收自己的夸奖/回复（特征 = 正文带我们自己的签名）。
  // 频率：用户明确要求「每天就行，不要太高」，所以是 **24 小时一次**，不是每轮。
  // 想更频繁必须先问用户，别擅自改小 everyHours。
  if (
    config.qaHealth?.enabled !== false &&
    shouldHealthCheck(usage, new Date(), config.qaHealth?.everyHours ?? 24)
  ) {
    try {
      const res = await purgeTagged({
        qaFile: config.paths.qaFile,
        archiveDir: config.paths.archiveDir,
        tags: tagsFromConfig(config),
        apply: config.qaHealth?.autoPurge !== false,
      });
      usage.lastHealthAt = new Date().toISOString();
      await saveUsage(config.paths.usageFile, usage);

      if (!res.hits.length) {
        log(`  [体检] 答疑库干净（${res.before} 条，无自己标签条目）`);
      } else {
        log(`  [体检] 发现 ${res.hits.length} 条携带自己标签的条目：`);
        res.hits.forEach((h) => log(`    ✗ 《${h.question.slice(0, 26)}》 命中「${h.tag}」`));
        if (config.qaHealth?.autoPurge === false) {
          log('    （autoPurge 已关闭：只报警，不剔除）');
        } else {
          log(`    已剔除并归档 → ${res.archivedFile}`);
          log(`    主库 ${res.before} → ${res.after} 条`);
          qa.length = 0;
          qa.push(...(await loadQaLibrary(config.paths.qaFile)));
        }
      }
    } catch (e) {
      log(`  [体检] 失败：${e.message}`);
    }
  }

  // ---------- 0. 每天整理一次（2026-11-02：从「每月 1~5 号」改成每天） ----------
  //  ① 答疑库条目：30 天没被引用 → 冷数据 Markdown（人能看、能手拷回来）
  //  ② 帖子：**按帖子维度**的冷热分离 → 冷数据进向量库（见 lib/cold-store.mjs）
  if (config.archive?.enabled !== false && shouldArchive(usage)) {
    log('\n  [整理] 每日整理…');
    try {
      const res = await archiveStale({
        qaFile: config.paths.qaFile,
        archiveDir: config.paths.archiveDir,
        entries: qa,
        usage,
        staleDays: config.archive?.staleDays ?? 30,
      });
      usage.lastArchiveAt = new Date().toISOString();
      await saveUsage(config.paths.usageFile, usage);
      res.log.forEach((l) => log('    ' + l));
      if (res.archived.length) {
        log(`    答疑库归档 ${res.archived.length} 条 → ${res.coldFile || '(无)'}`);
        log(`    保留 ${res.kept.length} 条`);
        qa.length = 0;
        qa.push(...(await loadQaLibrary(config.paths.qaFile)));
      }
    } catch (e) {
      log(`    [警告] 答疑库归档失败：${e.message}`);
    }

    // ② 帖子冷热分离：按类别 TTL 超时 → 搬进冷库（带向量）
    try {
      const cold = archiveToCold(state, postDb, { config, log });
      if (cold.moved) {
        log(`    帖子冷藏 ${cold.moved} 条 → 冷库（按类别 TTL）`);
        for (const [cat, n] of Object.entries(cold.byCategory || {})) {
          log(`      ${cat}: ${n} 条`);
        }
        await saveState(config.paths.stateFile, state);
      }
    } catch (e) {
      log(`    [警告] 帖子冷藏失败：${e.message}`);
    }
  }

  // ---------- 1. 一次请求：按发布时间降序 ----------
  //    `only` = 队列模式：只处理指定的这几条（守护循环 2 分钟一轮 + 队列用）。
  //              先从最新列表里捞；已经滑出窗口的，用只读详情接口补一个等价的 item。
  let items = [];
  try {
    if (only && only.length) {
      items = await fetchItemsByIds(only, { config, top, log });
    } else {
      const data = await listFeed({
        groupId: config.groupId,
        from: 0,
        limit: TOP,
        sort: config.collect.sort || 'created',
        type: config.collect.type,
      });
      items = data.list || [];
    }
  } catch (e) {
    if (e instanceof WafBlocked) log('  [WAF] 被拦截，本轮跳过，下轮再试');
    else log(`  [FAIL] 采集失败：${e.message}`);
    return { skipped: true, reason: e.message };
  }

  // ---------- 2. 逐条判定 ----------
  const results = [];
  const now = Math.floor(Date.now() / 1000);
  let learned = 0;

  for (const item of items) {
    const m = item.moment || {};
    const id = String(m.id_str || '');
    const { title, text } = extractText(item);
    const prev = state.posts[id];
    const publishTime = Number(m.publish_time || m.created_time || 0);
    // 回复数在 moment.stat.comments（顶层 item.comment_count 不存在 → 永远是 0，
    // 曾导致「评论数>0」这个前置条件永不成立，评论从未被读取、沉淀与夸奖也就从不触发）
    const commentCount = Number(item.comment_count ?? m.stat?.comments ?? 0);

    const post = {
      id,
      url: MOMENT_URL(id),
      title: title || text.slice(0, 40) || '(无标题)',
      text,
      author: m.author?.user?.name || '',
      authorId: String(m.author?.user?.id || ''),
      publishTime,
      commentCount,
      iReplied: false,
      othersReplied: false,
      replyCount: commentCount,
    };

    // 2a. 读评论：判断「我们回过没 / 别人回过没 / 有谁在喊我们」
    //
    // ⚠️ 「回过没」改成**按签名识别**（用户 2026-10-29 要求）：
    //    答疑组是多人协作，同一个签名「版主助手-小鲸鱼」会出现在几个账号的回复里，
    //    只看 myUserId 会漏掉队友的回复 → 同一个问题被两个人各回一遍。
    //    反过来，玩家拿签名喊我们（「小鲸鱼在吗」）**不算**「回过」，见 lib/signature.mjs。
    const isNew = !prev;
    const looksQ = looksLikeQuestion(text);
    const commentsChanged = prev?.scannedComments !== commentCount;
    // 非提问帖以前不读评论；为了抓「喊话」也要读，但只在评论数变了/上次没回完时才读，别每轮白打接口
    // ⚠️ interactPending：通知里有人说「回复了我 / @我」→ 这一帖必须重新读评论
    //    （楼中楼回复不一定改顶层评论数，光看 commentsChanged 会漏掉）
    const interactPending = Boolean(prev?.interactPending);
    const needComments =
      commentCount > 0 &&
      ((looksQ
        ? isNew || !(prev?.replied && prev.reason === REASON.ALREADY_REPLIED) || commentsChanged
        : summonOn && (commentsChanged || prev?.summonPending === true)) ||
        interactPending);
    let comments = null;
    // 三层树（帖子 → 一级回复 → 楼中楼）：回复生成要用它作为上下文（2026-11-04）
    let threadTree = null;

    if (needComments) {
      try {
        const c = await listComments({ momentId: id, from: 0, limit: 30 });
        comments = c.list || [];
        // 注入纯文本 + 建**三层树**（2026-11-04）
        //   帖子 → 一级回复 → 楼中楼。后面所有回复都按这个上下文喂给 LLM，
        //   不再从答疑库整段抽取、也不用模板。
        for (const cm of comments) {
          cm.__text = commentText(cm);
          for (const ch of cm.child_posts || []) ch.__text = commentText(ch);
        }
        threadTree = buildThreadTree(
          { id, title: post.title, text: post.text, author: post.author, authorId: post.authorId },
          comments
        );
        const flat = flattenAll(comments);
        // 以前只看 author.id；现在用统一判定（团队成员 id + 签名结尾）
        const ours = flat.filter((x) => isOurComment(x.c, { config, teamIds: TEAM_IDS }));
        // ⚠️ 只有**提问帖**才用「回过没有」判定状态和沉淀。
        //    非提问帖（加好友广告、分享帖）读评论只是为了抓「喊话」——
        //    要是也拿去判「他人已回复 → 沉淀」，就会把「加好友呀」这种垃圾写进答疑库。
        post.iReplied = looksQ && ours.length > 0;
        post.othersReplied = looksQ && flat.length > ours.length && !post.iReplied;
        post.replyCount = comments.length;
        post.scannedComments = commentCount;
        // 上下文（用户 2026-11-02）：玩家喊我们时，要能「看懂这一楼在聊什么」再回话。
        //   包含：帖子标题 + 正文 + 其他玩家的一级回复 + 楼中楼。
        const ctx = buildPostContext({ post, flat, config });
        post.summonCandidates = summonOn
          ? pickSummons(flat, { config, teamIds: TEAM_IDS, prev, context: ctx })
          : [];
        // 互动续聊候选（用户 2026-11-05）：**@你 / 回复你 / 喊你** → 可以继续互动；
        // 纯客套（「哈哈谢谢」）自动排除。
        const ourIds = new Set(ours.map((x) => String(x.c?.id_str || '')).filter(Boolean));
        post.interactCandidates = interactOn
          ? pickInteractions(flat, { config, ourCommentIds: ourIds, prev })
          : [];
        await sleep(config.collect.commentDelayMs ?? 1500);
      } catch (e) {
        post.commentError = e.message;
      }
    } else if (prev && prev.replied) {
      post.iReplied = prev.reason !== REASON.OTHERS_REPLIED;
      post.othersReplied = prev.reason === REASON.OTHERS_REPLIED;
    }

    // 2b. 判定（相似度 = max(旧 dice, 向量余弦)；向量只加分不扣分）
    let vecScores = null;
    if (vecDb) {
      try {
        const vr = await search(vecDb, `${post.title || ''} ${post.text || ''}`, {
          topN: 5,
          dense: vecDense,
          minScore: 0.02,
        });
        vecScores = Object.fromEntries(vr.results.map((r) => [r.entryId, r.score]));
        if (vr.path && vr.path !== matchPath) matchPath = vr.path;
      } catch {
        vecScores = null;
      }
    }
    const verdict = classify(post, { qa, config, state, vecScores, matchPath });
    let finalStatus = verdict.status;
    let finalReason = verdict.reason;

    if (prev && prev.status === STATUS.REPLIED) {
      finalStatus = STATUS.REPLIED;
      finalReason = prev.reason || REASON.ALREADY_REPLIED;
    } else if (prev && prev.status === STATUS.NO_NEED && verdict.status === STATUS.NO_NEED) {
      // 只有新判定也是「无需回复」才沿用旧结论。
      // 若判定升级为「需人工 / 待回复」，以新判定为准 ——
      // 这样判定规则改了以后，历史误判的帖子能自动翻案。
      finalStatus = STATUS.NO_NEED;
      finalReason = prev.reason || verdict.reason;
    }
    if (prev && prev.status === STATUS.NO_NEED && verdict.status !== STATUS.NO_NEED) {
      log(`  [翻案] 《${post.title}》从「无需回复」重新判为 ${verdict.status}`);
    }

    // 2b-2. 记进帖子记录库（逐行写；state.json 里的老记录会被搬到这儿）
    if (postDb) {
      try {
        recordScanned(postDb, post, {
          // board 传 null：管理任务写的板块更精确（40173:feed），别被这里覆盖掉
          board: null,
          qaStatus: finalStatus,
          detail: {
            reason: finalReason,
            score: verdict.score,
            matchPath: verdict.matchPath || matchPath,
            candidates: (verdict.candidates || []).slice(0, 3).map((c) => ({ q: c.question, s: c.score })),
          },
        });
      } catch {}
    }

    // 2c. 他人已回复 → 自动总结并沉淀进答疑库（每帖只做一次）
    //     ⚠️ 必须是**提问帖**：广告/分享帖的评论不是答案，沉淀进去就是污染答疑库
    let learnedNow = false;
    if (finalReason === REASON.OTHERS_REPLIED && looksQ && comments && !prev?.learnedQa) {
      try {
        const entry = buildQaEntry({
          post,
          comments,
          // 必须传：否则我自己盖的搂（夸奖）会被当成最佳答案沉淀进库
          myUserId: config.myUserId,
          signature: config.reply?.signature || '',
        });
        if (entry) {
          const r = await appendQaEntry(config.paths.qaFile, entry);
          if (r.added) {
            const st = statOf(usage, entryKeyOf(entry.question), { source: entry.source });
            st.createdAt = new Date().toISOString();
            await saveUsage(config.paths.usageFile, usage);
            learnedNow = true;
            learned++;
            log(`  [沉淀] 《${entry.question}》 ← 摘自 ${entry.fromAuthor}`);
          }
        }
      } catch (e) {
        post.note = `沉淀失败: ${e.message}`;
      }
    }

    // 2d. 社区已有人回答 → 挑出「最值得夸的那条回答」（夸奖走楼中楼，发送在第 3b 步）
    let praisePlan = null;
    if (
      config.praise?.enabled !== false &&
      finalReason === REASON.OTHERS_REPLIED &&
      comments &&
      !prev?.praised &&
      // 失败次数上限：楼中楼 UI 偶尔找不到目标/发送按钮（体检见 comment_not_found / no_send_button），
      // 不能每轮都重试同一个失败目标 —— 白烧时间，还让日志一直红。
      Number(prev?.praiseFailCount || 0) < Number(config.praise?.maxFailRetries ?? 3)
    ) {
      try {
        const target = pickPraiseTarget(comments, {
          myUserId: config.myUserId,
          minScore: config.praise?.minScore ?? 1,
        });
        // 同一条回答只夸一次（praisedComments 记着已夸过的评论 ID）
        const done = prev?.praisedComments || [];
        if (target && done.includes(String(target.targetCommentId))) {
          log(`  [跳过] 《${post.title}》的这条回答 ${target.targetCommentId} 之前已夸过`);
        } else if (target) {
          // 夸奖也走 LLM（2026-11-04 起不用模板）：按三层上下文夸到具体点上
          const gen = await composeLlmReply({
            config,
            kind: 'praise',
            tree: threadTree,
            targetId: String(target.targetCommentId),
            // 最近夸过的话 → 让模型避开同样的说法（用户 2026-11-02：「不建议多次直接使用」）
            avoidTexts: praiseHistoryTexts,
            log,
          });
          if (!gen.ok) {
            log(`  [跳过] 夸奖生成失败（${gen.reason}）→ 不夸，不退回模板`);
          } else {
            praisePlan = {
              commentId: target.targetCommentId,
              author: target.author,
              authorId: target.authorId,
              answerExcerpt: target.text.slice(0, 40),
              commentText: target.text,
              point: '',
              emoji: gen.emoji,
              text: gen.text,
            };
          }
        }
      } catch (e) {
        post.note = `夸奖准备失败: ${e.message}`;
      }
    }

    // 2e. 新帖冷却
    const ageMin = publishTime ? (now - publishTime) / 60 : 1e9;
    if (finalStatus === STATUS.PENDING && ageMin < config.match.minPostAgeMinutes) {
      finalStatus = STATUS.MANUAL;
      finalReason = REASON.TOO_NEW;
    }

    // 组装回复：**LLM 生成**（2026-11-04 起不用模板、不整段抽取答案）
    //   答疑库命中 → 只作为「参考资料」喂进上下文（condenseMaterial 会先按话题挑相关句）；
    //   没命中 → 也让模型按三层上下文自己判断怎么说（可以说不知道）。
    const usedTexts = Object.values(state.recentReplies || {})
      .filter((r) => r && r.text)
      .map((r) => r.text);
    let composed = null;
    if (finalStatus === STATUS.PENDING && threadTree) {
      const gen = await composeLlmReply({
        config,
        kind: 'answer',
        tree: threadTree,
        targetId: threadTree.post.id,
        qaHits: verdict.matchedEntry ? [verdict.matchedEntry] : [],
        log,
      });
      if (gen.ok) {
        composed = { text: gen.text, fromLlm: true, channel: gen.channel };
      } else {
        // 生成失败 → 转人工，**不退回模板**（用户 2026-11-04 明确要求）
        log(`  [警告] 《${String(post.title).slice(0, 20)}》回复生成失败（${gen.reason}）→ 转人工`);
        finalStatus = STATUS.MANUAL;
        finalReason = REASON.LOW_CONFIDENCE;
      }
    }

    // 2d-3. 🚫 承诺换码拦截（用户 2026-11-02 的 bug）
    //   答疑库里有一条社区沉淀答案「你是安卓的吗，我们俩可以换」——
    //   原样发出去 = 我们以版主身份承诺跟玩家换码，兑现不了、也不该替人担保。
    //   处理：这条答案不许发；如果帖子确实在求码，改成**只陪聊一句**（不含任何承诺）。
    let codeChatNote = '';
    if (verdict.matchedEntry) {
      const pr = answerPromisesCode(verdict.matchedEntry.answer);
      if (pr.promise) {
        const asking = looksLikeCodeAsk(`${post.title}\n${post.text}`);
        log(
          `  [拦截] 《${String(post.title).slice(0, 24)}》的答案含换码承诺「${pr.hit}」→ 不发这条答案`
            + (asking ? '，改为陪聊一句' : '，转人工')
        );
        codeChatNote = `答案含换码承诺「${pr.hit}」`;
        if (asking) {
          // 陪聊也走 LLM：明令不许承诺换码/给码，只陪一句
          const chatGen = await composeLlmReply({
            config,
            kind: 'chat',
            tree: threadTree,
            targetId: threadTree.post.id,
            hint: '他在求天宫码。你手上没有多余的码，**绝对不能承诺换码、给码，也不能替他担保别人的码**；只陪一句，可以建议他问问同端的人。',
            log,
          });
          composed = chatGen.ok ? { text: chatGen.text, codeChat: true } : null;
        } else {
          composed = null;
        }
      }
    }
    const draft = composed ? composed.text : null;

    // 泄露自检：回复里不能出现内部信息/库外内容
    let leak = null;
    if (draft) {
      const chk = assertNoLeak(draft);
      if (!chk.ok) {
        leak = chk.hit;
        log(`  [拦截] 《${post.title}》的回复含疑似内部内容「${chk.hit}」→ 不发送，转人工`);
      }
    }

    // 2f. 玩家喊我们 → 生成一句回应（真正发送在 3e）
    //
    // 2026-11-04 起：**LLM 按三层上下文生成**，不用模板。
    //   敏感（退款/客服/封号/充值/外挂/账号交易…）→ kind='refuse'（礼貌说明帮不上）
    //   其余 → kind='summon'（应一声 + 顺着他的话接，父链和 @ 的上下文都给它）
    // 护栏：assertKind（不贬低/不替官方承诺）+ assertNoLeak（不泄露）+ 单行 + 长度
    let summonPlans = [];
    if (summonOn && post.summonCandidates?.length) {
      for (const s of post.summonCandidates) {
        try {
          const sensitive = /(退款|退钱|退费|客服|补偿|封号|被封|举报|充值|订单|支付|申诉|投诉|外挂|作弊|卖号|买号|交易|诈骗)/.test(
            String(s.text || '')
          );
          const gen = await composeLlmReply({
            config,
            kind: sensitive ? 'refuse' : 'summon',
            tree: threadTree,
            targetId: String(s.commentId),
            qaHits: [],
            log,
          });
          if (!gen.ok) {
            summonPlans.push({ ...s, origin: s.text, text: null, mood: 'other', blocked: `生成失败: ${gen.reason}` });
            continue;
          }
          const kindChk = assertKind(gen.body || gen.text);
          const safe = assertNoLeak(gen.body || gen.text);
          const blocked = !kindChk.ok ? kindChk.hit : !safe.ok ? `泄露自检命中「${safe.hit}」` : null;
          if (blocked) log(`  [拦截] 《${post.title}》的喊话回复被护栏拦下（${blocked}）→ 转人工`);
          summonPlans.push({ ...s, origin: s.text, text: gen.text, mood: sensitive ? 'sensitive' : 'summon', blocked });
        } catch (e) {
          summonPlans.push({ ...s, origin: s.text, text: null, mood: 'other', blocked: `生成失败: ${e.message}` });
        }
      }
    }

    // 2g. 互动续聊（用户 2026-11-05）
    //   玩家回应了我们（**@你 / 回复你 / 喊你**）→ 可以继续互动；
    //   纯客套（「哈哈谢谢」）已在 pickInteractions 里排除；
    //   同帖 × 同玩家回过 3 次后降到 50% 概率（情绪强烈 / 直接点名 → 例外必回）。
    let interactPlans = [];
    if (interactOn && post.interactCandidates?.length) {
      const maxPerPost = Number(config.interact?.maxPerPost ?? 1);
      for (const cand of post.interactCandidates) {
        if (interactPlans.length >= maxPerPost) {
          log(
            `  [互动] 《${String(post.title).slice(0, 18)}》本帖互动已达上限 ${maxPerPost} → 其余留到下一轮`
          );
          break;
        }
        const counts = prev?.interactCounts || {};
        const followUps = countFollowUps(post.interactCandidates, cand);
        const d = decideInteraction(cand, { counts, config, followUps });
        if (!d.reply) {
          log(`  [互动] ${cand.author || '玩家'}「${String(cand.text).slice(0, 18)}」→ 不回（${d.reason}）`);
          continue;
        }
        try {
          const target = replyTargetFor(cand);
          const gen = await composeLlmReply({
            config,
            kind: 'interact',
            tree: threadTree,
            targetId: String(cand.commentId),
            hint: target.mention
              ? `对方是「${target.mention}」。你是在**同层楼中楼**里回他 —— 文案开头用 @${target.mention} 称呼他，再接话。`
              : `你是在「${target.label}」里回他，称呼用「${cand.author || '对方'}」。`,
            log,
          });
          if (!gen.ok) {
            interactPlans.push({ ...cand, text: null, blocked: `生成失败: ${gen.reason}`, decision: d, target });
            continue;
          }
          const kindChk = assertKind(gen.body || gen.text);
          const safe = assertNoLeak(gen.body || gen.text);
          const blocked = !kindChk.ok ? kindChk.hit : !safe.ok ? `泄露自检命中「${safe.hit}」` : null;
          if (blocked) log(`  [拦截] 《${post.title}》的互动回复被护栏拦下（${blocked}）→ 不发`);
          const text = target.mention ? `@${target.mention} ${gen.text}` : gen.text;
          interactPlans.push({ ...cand, text, blocked, decision: d, target });
        } catch (e) {
          interactPlans.push({ ...cand, text: null, blocked: `生成失败: ${e.message}`, decision: d });
        }
      }
    }

    const rec = {
      ...post,
      status: leak ? STATUS.MANUAL : finalStatus,
      reason: leak ? REASON.LEAK : finalReason,
      score: verdict.score,
      matchedQa: verdict.matchedEntry?.id || null,
      matchedQuestion: verdict.matchedEntry?.question || null,
      matchedAuto: !!verdict.matchedEntry?.auto,
      candidates: verdict.candidates,
      note: leak ? `泄露自检命中「${leak}」` : verdict.note || post.note || '',
      replyDraft: leak ? null : draft,
      replyVariant: composed ? { opener: composed.opener, closer: composed.closer } : null,
      learnedNow,
      praise: praisePlan,
      summons: summonPlans,
      interact: interactPlans,
      emojis: draft ? parseEmojiSegments(draft).marks.map((x) => x.name) : [],
      firstSeen: prev?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    results.push(rec);

    state.posts[id] = {
      firstSeen: rec.firstSeen,
      lastSeen: rec.lastSeen,
      title: rec.title,
      url: rec.url,
      author: rec.author,
      publishTime: rec.publishTime,
      status: rec.status,
      reason: rec.reason,
      normKey: normKey(rec.title) || normKey(text),
      replied: rec.status === STATUS.REPLIED,
      commentCount: rec.commentCount,
      matchedQa: rec.matchedQa,
      score: rec.score,
      repliedAt: prev?.repliedAt || null,
      replyHash: draft ? hashText(draft) : null,
      learnedQa: prev?.learnedQa || learnedNow,
      praised: prev?.praised || false,
      praisedAt: prev?.praisedAt || null,
      shareCommented: prev?.shareCommented || false,
      shareAt: prev?.shareAt || null,
      // 签名识别 / 喊话互动的状态
      scannedComments: post.scannedComments ?? prev?.scannedComments ?? null,
      summonReplied: prev?.summonReplied || [],
      summonAt: prev?.summonAt || null,
      summonPending: false,
      // 互动续聊（用户 2026-11-05）：已回应过的评论 / 同帖同玩家累计次数
      interactReplied: prev?.interactReplied || [],
      interactCounts: prev?.interactCounts || {},
      interactAt: prev?.interactAt || null,
      interactPending: false,
    };
  }

  // ---------- 2z. 通知检查（冷帖唤醒 + 互动信号，**共用一次请求**）----------
  //  通知 = 「回复和@我收到的」（`/notification/v2/by-me?type=7`）：
  //  它直接给出「谁、在哪个帖子的哪条评论下说了什么」，比「评论数变了再去读评论猜」准，
  //  而且**只多 1 个请求**（不像原来还要 sort=commented 拉一遍列表 + 逐条读评论）。
  //
  //  ① 冷帖唤醒（用户 2026-11-02）：
  //     · 自己的帖：有人回（含楼中楼）→ 唤醒
  //     · 别人的帖：有人**@我**或**呼唤我** → 唤醒
  //  ② 互动信号（用户 2026-11-05）：「回复了你的评论 / @了你」→ 该帖标记待互动
  //     （楼中楼回复**不一定**改顶层评论数，光看 commentsChanged 会漏掉 → 用通知兜底）
  let notes = [];
  const noteEveryMin = Math.min(
    Number(config.archive?.wakeEveryMinutes ?? 30),
    Number(config.interact?.checkEveryMinutes ?? 30)
  );
  const lastNoteAt = Number(state.lastWakeCheckAt || 0);
  if (Date.now() - lastNoteAt > noteEveryMin * 60 * 1000) {
    state.lastWakeCheckAt = Date.now();
    try {
      notes = await listNotifications({ config, log });
    } catch (e) {
      log(`  [通知] 拉取失败：${e.message}`);
    }
  }

  if (notes.length) {
    // 我们可能被 @ 的称呼：运行时从 state 推（真实昵称不进配置、不进仓库）
    const names = ourNames(state, config);
    const noteCfg = { ...config, ourNames: names };

    // ① 冷帖唤醒
    if (config.archive?.wakeEnabled !== false && postDb) {
      const w = wakeByNotifications(postDb, state, notes, {
        config: noteCfg,
        isAboutMe: (n, cfg) => isAboutMe(n, cfg),
      });
      if (w.woken) {
        log(`  [唤醒] ${w.woken} 条冷帖重新变热（通知触发的）：`);
        for (const it of w.items) log(`    · ${it.id} —— ${it.reason}${it.from ? `（${it.from}）` : ''}`);
      }
    }

    // ② 互动信号：热帖里有人回我 / @我 / 喊我 → 标记待互动
    if (interactOn) {
      let marked = 0;
      for (const n of notes) {
        const mid = String(n.momentId || '');
        if (!mid) continue;
        if (!isAboutMe(n, noteCfg)) continue;
        if (postDb && isCold(postDb, mid)) continue; // 冷帖已由上面处理
        state.interactPending = state.interactPending || {};
        state.interactPending[mid] = {
          at: Date.now(),
          reason: n.title || n.action || '回复/@我',
          from: n.senderName || '',
        };
        if (!state.posts[mid]) {
          state.posts[mid] = {
            id: mid,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            status: STATUS.REPLIED,
          };
        }
        state.posts[mid].interactPending = true;
        marked++;
      }
      if (marked) log(`  [互动] ${marked} 个帖子有「回复/@我」的信号 → 已标记待互动`);
    }

    await saveState(config.paths.stateFile, state);
  }

  // ---------- 3. 回复 ----------
  const pendings = results.filter((r) => r.status === STATUS.PENDING);
  if (doReply && pendings.length) {
    log(`\n  -> 待回复 ${pendings.length} 条${dryRun ? '（dry-run，不发送）' : ''}`);
    if (dryRun) {
      for (const p of pendings) {
        const { plainText, marks } = parseEmojiSegments(p.replyDraft);
        log(`\n  -- [dry-run] ${p.title}`);
        log(`    命中：${p.matchedQuestion} (${p.score}${p.matchedAuto ? '，社区沉淀' : ''})`);
        log(plainText.split('\n').map((l) => '      | ' + l).join('\n'));
        if (marks.length) {
          log('      | 表情插入点：' + marks.map((m) => `第${m.at}字后[表情_${m.name}]`).join('  '));
        }
      }
    } else {
      const runner = makeRunner({
        opencliMain: config.reply.opencliMain,
        session: config.reply.session,
      });
      const d = doctorOk(runner);
      if (!d.ok) {
        log(`  [FAIL] opencli 不可用：${d.text.split('\n')[0]}`);
      } else {
        const cap = config.match.maxAutoReplyPerRun;
        let sent = 0;
        for (const p of pendings) {
          if (sent >= cap) {
            p.status = STATUS.MANUAL;
            p.reason = REASON.OVER_CAP;
            continue;
          }
          log(`\n  -- 回复：${p.title}`);
          log(`    ${p.url}`);
          const r = await replyOne({
            runner,
            url: p.url,
            text: p.replyDraft,
            config,
            dryRun: false,
            log,
          });
          if (r.ok) {
            p.status = STATUS.REPLIED;
            p.reason = REASON.ALREADY_REPLIED;
            sent++;
            const em = r.detail?.emojis?.length ? ` + 表情(${r.detail.emojis.join(',')})` : '';
            log(`    [OK] 已发送${em}`);
            state.posts[p.id].status = STATUS.REPLIED;
            state.posts[p.id].replied = true;
            state.posts[p.id].repliedAt = new Date().toISOString();
            // 记下这条原文 → 以后再回同一份答案时换个说法，不重样
            const h = liteHash(p.replyDraft);
            state.recentReplies = state.recentReplies || {};
            state.recentReplies[h] = {
              text: p.replyDraft,
              at: new Date().toISOString(),
              count: (state.recentReplies[h]?.count || 0) + 1,
              postId: p.id,
            };
            // 只保留最近 200 条
            const entries = Object.entries(state.recentReplies).sort(
              (a, b) => String(b[1].at).localeCompare(String(a[1].at))
            );
            state.recentReplies = Object.fromEntries(entries.slice(0, 200));
            if (p.matchedQa) {
              recordCitation(usage, p.matchedQa);
              await saveUsage(config.paths.usageFile, usage);
            }
          } else {
            p.status = STATUS.MANUAL;
            p.reason = r.stage === 'no_input' ? REASON.NO_INPUT : REASON.SEND_FAILED;
            p.note = `回复失败@${r.stage}`;
            state.posts[p.id].status = STATUS.MANUAL;
            state.posts[p.id].reason = p.reason;
            log(`    [FAIL] 失败（${r.stage}）${r.detail ? '：' + JSON.stringify(r.detail).slice(0, 140) : ''}`);
          }
          await sleep(config.reply.delayMs ?? 6000);
        }
      }
    }
  }

  // ---------- 3b. 夸奖答题玩家（楼中楼回复） ----------
  const praisables = results.filter((r) => r.praise && !state.posts[r.id]?.praised);
  if (praisables.length) {
    log(`\n  -> 可夸奖 ${praisables.length} 条${dryRun ? '（dry-run，不发送）' : ''}`);
    if (!doReply) {
      log('    （未开 --reply，只记录不发送）');
    } else if (dryRun) {
      for (const p of praisables) {
        log(`\n  -- [dry-run] 夸奖 ${p.praise.author}：${p.title}`);
        log(`    目标评论 ID：${p.praise.commentId}`);
        log(`    对方答案：${p.praise.answerExcerpt}`);
        log(p.praise.text.split('\n').map((l) => '      | ' + l).join('\n'));
      }
    } else {
      const prunner = makeRunner({
        opencliMain: config.reply.opencliMain,
        session: config.reply.session,
      });
      const pd = doctorOk(prunner);
      if (!pd.ok) {
        log(`  [FAIL] opencli 不可用：${pd.text.split('\n')[0]}`);
      } else {
        const cap = config.praise?.maxPerRun ?? 3;
        let sent = 0;
        for (const p of praisables) {
          if (sent >= cap) {
            log(`    [跳过] 超出本轮夸奖上限 ${cap}`);
            break;
          }
          log(`\n  -- 夸奖 ${p.praise.author}（帖：${p.title}）`);
          const r = await sendPraise({
            config,
            state,
            postId: p.id,
            commentId: p.praise.commentId,
            url: p.url,
            text: p.praise.text,
            commentText: p.praise.commentText || '',
            point: p.praise.point || '',
            runner: prunner,
            praiseDb,
            log,
          });
          if (r.ok) {
            sent++;
            p.praised = true;
          } else {
            p.note = `夸奖失败@${r.stage}`;
            // 记失败次数：同一个目标连错 N 次就不再试（见上面 maxFailRetries 的判断）
            const key = `${p.id}:${p.praise.commentId}`;
            const prevFail = state.praiseFails?.[key] || 0;
            state.praiseFails = { ...(state.praiseFails || {}), [key]: prevFail + 1 };
            if (state.posts[p.id]) {
              state.posts[p.id].praiseFailCount = Number(state.posts[p.id].praiseFailCount || 0) + 1;
              state.posts[p.id].praiseFailStage = r.stage || '';
            }
            log(
              `    [FAIL] 失败（${r.stage}）` +
                (r.detail ? '：' + JSON.stringify(r.detail).slice(0, 140) : '') +
                `（第 ${prevFail + 1} 次，达上限后不再重试）`
            );
          }
          await sleep(config.reply.delayMs ?? 6000);
        }
      }
    }
  }

  // ---------- 3c. 不知道的问题：委婉拒绝（可选） ----------
  // 默认「不理会」（转人工，版主自己看）。把 config.reply.refuseOnUnknown 打开才会回一句婉拒。
  if (doReply && !dryRun && config.reply?.refuseOnUnknown === true) {
    const unknowns = results.filter(
      (r) => r.status === STATUS.MANUAL && (r.reason === REASON.NO_QA_MATCH || r.reason === REASON.LOW_CONFIDENCE)
    );
    if (unknowns.length) {
      log(`\n  -> 库里没有答案的问题 ${unknowns.length} 条（开启婉拒）`);
      const rrunner = makeRunner({
        opencliMain: config.reply.opencliMain,
        session: config.reply.session,
      });
      if (doctorOk(rrunner).ok) {
        for (const u of unknowns.slice(0, config.match.maxAutoReplyPerRun ?? 8)) {
          // 婉拒也走 LLM（2026-11-04 起不用模板）：拿不准就实话说拿不准
          const gen = await composeLlmReply({
            config,
            kind: 'answer',
            tree: buildThreadTree(
              { id: u.id, title: u.title, text: u.text, author: u.author, authorId: u.authorId },
              []
            ),
            targetId: `post:${u.id}`,
            hint: '你查不到这个问题的确切答案。**不要编造任何游戏数据或步骤**，就实话说这块你也不确定、可以问问别的老玩家。别用套路话敷衍。',
            log,
          });
          if (!gen.ok) {
            log(`    [跳过] 婉拒生成失败（${gen.reason}）`);
            continue;
          }
          const text = gen.text;
          log(`\n  -- 婉拒：${u.title}`);
          const r = await replyOne({
            runner: rrunner,
            url: u.url,
            text,
            config,
            dryRun: false,
            log,
          });
          if (r.ok) {
            u.status = STATUS.REPLIED;
            u.reason = REASON.ALREADY_REPLIED;
            state.posts[u.id].status = STATUS.REPLIED;
            state.posts[u.id].replied = true;
            state.posts[u.id].repliedAt = new Date().toISOString();
            const h = liteHash(text);
            state.recentReplies = state.recentReplies || {};
            state.recentReplies[h] = { text, at: new Date().toISOString(), count: 1, postId: u.id };
            log('    [OK] 已婉拒');
          } else {
            log(`    [FAIL] 婉拒失败（${r.stage}）`);
          }
          await sleep(config.reply.delayMs ?? 6000);
        }
      }
    }
  }

  // ---------- 3d. 分享帖轻互动 ----------
  // 分享/记录/进度类帖子不是提问，套答疑内容会答非所问；
  // 但用户明确说了「分享的也可以进去说说话」→ 去说一句通用鼓励 + 1 个表情。
  // 硬约束：只说话不输出信息，不评价具体数值，不引用答疑库内容。
  if (doReply && config.share?.enabled !== false) {
    // 🎁 有人贴出天宫码（JFA…）= 无私分享 → 优先去**夸行为**（用户 2026-11-02）
    const isCodeShare = (r) => looksLikeCodeShare(`${r.title || ''}\n${r.text || ''}`);
    const CODE_CAP = Number(config.share?.maxCodePraisePerRun ?? 2);
    const codeShares = results
      .filter((r) => r.status === STATUS.NO_NEED && !state.posts[r.id]?.shareCommented && isCodeShare(r))
      .slice(0, CODE_CAP);
    const shares = results.filter(
      (r) =>
        r.status === STATUS.NO_NEED &&
        r.reason === REASON.NOT_QUESTION &&
        looksLikeShare(r.title) &&
        !state.posts[r.id]?.shareCommented &&
        !isCodeShare(r) // 发码帖走上面那条
    );
    if (codeShares.length) {
      log(
        `\n  -> 天宫码分享可夸 ${codeShares.length} 条（无私分享，上限 ${CODE_CAP}）${
          dryRun ? '（dry-run，不发送）' : ''
        }`
      );
      const usedT = Object.values(state.recentReplies || {}).map((x) => x.text);
      for (const s of codeShares) {
        // 发码夸奖也走 LLM：夸「愿意贴出来分享」这个行为，不评价码能不能用
        const gen = await composeLlmReply({
          config,
          kind: 'praise',
          tree: buildThreadTree(
            { id: s.id, title: s.title, text: s.text, author: s.author, authorId: s.authorId },
            []
          ),
          targetId: `post:${s.id}`,
          hint: '他把天宫码直接贴出来给大家用。这是无私分享的行为，夸这个行为本身；不要评价码还有没有效、不要索要、不要说自己也想要。',
          log,
        });
        if (!gen.ok) {
          log(`    [跳过] 生成失败（${gen.reason}）`);
          continue;
        }
        const text = gen.text;
        if (dryRun) {
          log(`\n  -- [dry-run] 夸无私分享：${s.title}`);
          log(`      | ${text}`);
          continue;
        }
        const cRunner = makeRunner({ opencliMain: config.reply.opencliMain, session: config.reply.session });
        if (!doctorOk(cRunner).ok) {
          log('    [跳过] opencli 不可用');
          break;
        }
        log(`\n  -- 夸无私分享：${s.title}`);
        const r = await replyOne({ runner: cRunner, url: s.url, text, config, dryRun: false, log });
        if (r.ok) {
          state.posts[s.id] = {
            ...(state.posts[s.id] || {}),
            shareCommented: true,
            codePraiseAt: new Date().toISOString(),
          };
          state.recentReplies = state.recentReplies || {};
          state.recentReplies[liteHash(text)] = {
            text,
            at: new Date().toISOString(),
            count: 1,
            postId: s.id,
          };
          await saveState(config.paths.stateFile, state);
          log('    [OK] 已夸（无私分享）');
        } else {
          log(`    [FAIL] 失败（${r.stage}）`);
        }
      }
    }
    if (shares.length) {
      const cap = config.share?.maxPerRun ?? 2;
      log(`\n  -> 分享帖可互动 ${shares.length} 条（上限 ${cap}）${dryRun ? '（dry-run，不发送）' : ''}`);
      // 分享互动也走 LLM（2026-11-04 起不用模板）：凑一句热闹，不评价数值、不套答疑内容
      const shareGens = [];
      for (const s of shares.slice(0, cap)) {
        const gen = await composeLlmReply({
          config,
          kind: 'share',
          tree: buildThreadTree(
            { id: s.id, title: s.title, text: s.text, author: s.author, authorId: s.authorId },
            []
          ),
          targetId: `post:${s.id}`,
          hint: '他在分享进度或攻略。你去凑一句热闹。别评价具体数值对不对，别提任何攻略库内容，别说教。',
          log,
        });
        if (!gen.ok) {
          log(`    [跳过] 分享互动生成失败（${gen.reason}）`);
          continue;
        }
        shareGens.push({ s, text: gen.text });
      }
      if (dryRun) {
        for (const { s, text } of shareGens) {
          log(`\n  -- [dry-run] 分享互动：${s.title}`);
          log(`      | ${text}`);
        }
      } else if (shareGens.length) {
        const srunner = makeRunner({
          opencliMain: config.reply.opencliMain,
          session: config.reply.session,
        });
        if (doctorOk(srunner).ok) {
          let n = 0;
          for (const { s, text } of shareGens) {
            if (n >= cap) {
              log('    [跳过] 超出本轮分享互动上限');
              break;
            }
            log(`\n  -- 分享互动：${s.title}`);
            const r = await replyOne({
              runner: srunner,
              url: s.url,
              text,
              config,
              dryRun: false,
              log,
            });
            if (r.ok) {
              n++;
              state.posts[s.id].shareCommented = true;
              state.posts[s.id].shareAt = new Date().toISOString();
              const h = liteHash(text);
              state.recentReplies = state.recentReplies || {};
              state.recentReplies[h] = {
                text,
                at: new Date().toISOString(),
                count: 1,
                postId: s.id,
              };
              log(`    [OK] 已互动（表情 ${emoji}）`);
            } else {
              log(`    [FAIL] 互动失败（${r.stage}）`);
            }
            await sleep(config.reply.delayMs ?? 6000);
          }
        }
      }
    }
  }

  // ---------- 3e. 玩家喊我们 → 按语义互动 ----------
  // 用户要求：「如果发现玩家喊你，过去，根据语义互动一下玩家」。
  //   敏感（退款/客服/补偿/封号/举报/充值/外挂/账号交易…）→ 礼貌拒绝，不替官方表态
  //   问了具体问题 → 先用答疑库答（事实只来自库），答不上来 → 安慰 + 鼓励
  //   其余 → 按语气鼓励 / 赞扬 / 欣赏 / 同情
  // 硬护栏：不贬低不辱骂不越权承诺（assertKind）、泄露自检、必须单行（楼中楼 fill 限制）
  if (summonOn) {
    const all = results.flatMap((r) => (r.summons || []).map((s) => ({ r, s })));
    if (all.length) {
      const cap = Number(config.summon?.maxPerRun ?? 3);
      const live = all.filter((x) => !x.s.blocked && x.s.text);
      log(
        `\n  -> 玩家喊话 ${all.length} 条（可回 ${live.length}，上限 ${cap}）` +
          `${dryRun ? '（dry-run，不发送）' : ''}`
      );

      if (dryRun) {
        for (const { r, s } of live.slice(0, cap)) {
          log(`\n  -- [dry-run] 回应 ${s.author || '玩家'}（${s.mood}${s.fromQa ? '，引用答疑库' : ''}）：${r.title}`);
          log(`    对方说：${String(s.origin || '').slice(0, 60)}`);
          log(`      | ${s.text}`);
        }
      } else if (!doReply) {
        log('    （未开 --reply，只记录不发送）');
      } else {
        const xrunner = makeRunner({
          opencliMain: config.reply.opencliMain,
          session: config.reply.session,
        });
        const xd = doctorOk(xrunner);
        if (!xd.ok) {
          log(`  [FAIL] opencli 不可用：${xd.text.split('\n')[0]}`);
        } else {
          let n = 0;
          for (let i = 0; i < live.length; i++) {
            const { r, s } = live[i];
            if (i >= cap) {
              // 超上限：标记待办，下一轮接着处理（评论没变也会因为 summonPending 重新读）
              if (state.posts[r.id]) state.posts[r.id].summonPending = true;
              log(`    [跳过] 超出本轮喊话上限 ${cap}，留到下一轮`);
              continue;
            }
            log(`\n  -- 回应 ${s.author || '玩家'}（${s.mood}${s.fromQa ? '，引用答疑库' : ''}）：${r.title}`);
            log(`    对方说：${String(s.origin || '').slice(0, 60)}`);
            const res = await sendSummonReply({
              state,
              postId: r.id,
              commentId: s.commentId,
              url: r.url,
              text: s.text,
              runner: xrunner,
              via: config?.reply?.nestedVia || 'ui',
              log,
            });
            if (res.ok) {
              n++;
              s.sent = true;
            } else {
              if (state.posts[r.id]) state.posts[r.id].summonPending = true;
              log(
                `    [FAIL] 失败（${res.stage}）` +
                  (res.detail ? '：' + JSON.stringify(res.detail).slice(0, 140) : '')
              );
            }
            await sleep(config.reply.delayMs ?? 6000);
          }
        }
      }
    }
  }

  // ---------- 3f. 互动续聊（用户 2026-11-05） ----------
  //   玩家回应了我们（@你 / 回复你 / 喊你）→ 可以继续接一句；
  //   纯客套（「哈哈谢谢」）不回；同帖 × 同玩家回过 3 次后 50% 概率；情绪强烈必回。
  const interactAll = results.flatMap((r) => (r.interact || []).map((c) => ({ r, c })));
  if (interactAll.length) {
    const cap = Number(config.interact?.maxPerRun ?? 3);
    const live = interactAll.filter((x) => !x.c.blocked && x.c.text);
    log(
      `\n  -> 互动续聊 ${interactAll.length} 条（可回 ${live.length}，上限 ${cap}）` +
        `${dryRun ? '（dry-run，不发送）' : ''}`
    );
    if (dryRun) {
      for (const { r, c } of live.slice(0, cap)) {
        log(`\n  -- [dry-run] 接话 ${c.author || '玩家'}（${c.why}）：${r.title}`);
        log(`    对方说：${String(c.text || '').slice(0, 60)}`);
        log(`    回在：${c.target?.label || '楼中楼'}`);
        log(`      | ${c.text}`);
      }
    } else if (!doReply) {
      log('    （未开 --reply，只记录不发送）');
    } else {
      const irunner = makeRunner({
        opencliMain: config.reply.opencliMain,
        session: config.reply.session,
      });
      const idd = doctorOk(irunner);
      if (!idd.ok) {
        log(`  [FAIL] opencli 不可用：${idd.text.split('\n')[0]}`);
      } else {
        let n = 0;
        for (const { r, c } of live.slice(0, cap)) {
          log(`\n  -- 接话 ${c.author || '玩家'}（${c.why}）：${r.title}`);
          log(`    对方说：${String(c.text || '').slice(0, 60)}`);
          log(`    回在：${c.target?.label || '楼中楼'}`);
          const res = await sendInteractReply({
            state,
            postId: r.id,
            commentId: c.commentId,
            parentId: c.target?.parentId || '',
            text: c.text,
            url: r.url,
            playerKey: playerKey(c),
            runner: irunner,
            via: config?.reply?.nestedVia || 'ui',
            log,
          });
          if (res.ok) {
            n++;
            c.sent = true;
          } else {
            log(
              `    [FAIL] 失败（${res.stage}）` +
                (res.detail ? '：' + JSON.stringify(res.detail).slice(0, 140) : '')
            );
          }
          await sleep(config.reply.delayMs ?? 6000);
        }
      }
    }
  }

  // ---------- 4. 落盘 + 报表 ----------
  const summoned = results.reduce((n, r) => n + (r.summons || []).filter((s) => s.sent).length, 0);
  const interacted = results.reduce((n, r) => n + (r.interact || []).filter((c) => c.sent).length, 0);
  // 清掉已处理的互动标记（state.interactPending 是全局表，不能无限长）
  if (state.interactPending) {
    for (const mid of Object.keys(state.interactPending)) {
      if (!state.posts[mid]?.interactPending) delete state.interactPending[mid];
    }
  }
  state.runs = (state.runs || []).slice(-199);
  state.runs.push({
    at: new Date().toISOString(),
    scanned: results.length,
    pending: results.filter((r) => r.status === STATUS.PENDING).length,
    replied: results.filter((r) => r.status === STATUS.REPLIED).length,
    noNeed: results.filter((r) => r.status === STATUS.NO_NEED).length,
    manual: results.filter((r) => r.status === STATUS.MANUAL).length,
    summoned,
    learned,
  });
  await saveState(config.paths.stateFile, state);
  await saveUsage(config.paths.usageFile, usage);

  const { renderReport } = await import('./lib/report.mjs');
  await renderReport({
    results,
    config,
    qa,
    root: config.paths.dataDir,
    state,
    usage,
    learned,
  });

  const c = (s) => results.filter((r) => r.status === s).length;
  log(
    `  结果：待回复 ${c(STATUS.PENDING)}  已回复 ${c(STATUS.REPLIED)}  ` +
      `无需回复 ${c(STATUS.NO_NEED)}  需人工 ${c(STATUS.MANUAL)}` +
      (summoned ? `  回应喊话 ${summoned}` : '') +
      (interacted ? `  互动续聊 ${interacted}` : '') +
      (learned ? `  新沉淀 ${learned} 条` : '') +
      (matchPath ? `  匹配路径 ${matchPath}` : '')
  );

  return { results, config };
}

if (process.argv[1] && /collect\.mjs$/.test(process.argv[1])) {
  const config = await loadConfig();
  await runOnce({
    doReply: has('--reply') || has('--dry-run'),
    dryRun: has('--dry-run') ? true : has('--reply') ? false : config.reply.dryRun !== false,
    top: argOf('--top', null),
  });
}
