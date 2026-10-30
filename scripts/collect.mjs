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
import { buildSummonReply, assertKind } from './lib/summon.mjs';
import { sendSummonReply } from './lib/summon-send.mjs';
import { loadQaLibrary, looksLikeQuestion, looksLikeShare } from './lib/qa.mjs';
import { openDb } from './lib/db.mjs';
import { openPostDb, archiveOldPosts, recordScanned, recordStatus } from './lib/post-records.mjs';
import { buildIndex, search, makeHttpDense, indexVersion, VEC_VERSION } from './lib/qa-vector.mjs';
import { loadState, saveState, hashText, normKey, STATUS, REASON } from './lib/state.mjs';
import { classify, composeReply } from './lib/classify.mjs';
import { makeRunner, doctorOk, replyOne } from './lib/replier.mjs';
import { parseEmojiSegments } from './lib/emoji.mjs';
import { buildQaEntry, appendQaEntry } from './lib/summarize.mjs';
import { pickPraiseTarget, composePraise } from './lib/praise.mjs';
import { replyToComment } from './lib/reply-nested.mjs';
import { sendPraise } from './lib/praise-send.mjs';
import { assertNoLeak, buildRefusalText, buildShareText } from './lib/variants.mjs';
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
 * 从摊平的评论里挑出「玩家在喊我们」的几条（已回过的不算）
 *
 * 优先序：① 明确点了签名 ② 只是喊「版主」 ③ 时间新的优先
 * 单帖上限 config.summon.maxPerPost（默认 1）—— 一帖里被喊好几次只回一次，别刷屏。
 */
function pickSummons(flat, { config, teamIds, prev }) {
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
    });
  }

  out.sort((a, b) => b.prio - a.prio || b.time - a.time);
  return out.slice(0, perPost);
}

export async function runOnce({ doReply = false, dryRun = true, top = null, quiet = false } = {}) {
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

  // ---------- 0y. 帖子记录库：老记录搬进 SQLite，state.json 只留热数据 ----------
  //   解决「记录太多」：state.json 每次都要整份重写，几百条就几百 KB。
  //   搬走的是「已判定完、不再参与判定」的老记录；待回复/需人工的留在 state.json（判重要用）。
  let postDb = null;
  try {
    postDb = openPostDb(config);
    const arch = archiveOldPosts(state, postDb, { olderThanDays: Number(config.archive?.olderThanDays ?? 45) });
    if (arch.moved) {
      log(`  [记录] 老记录搬进 SQLite：${arch.moved} 条（state.json 保留 ${arch.kept} 条）`);
      await saveState(config.paths.stateFile, state);
    }
  } catch (e) {
    postDb = null;
    log(`  [记录] SQLite 不可用（${e.message}）→ 只用 state.json 记账`);
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

  // ---------- 0. 每月 1~5 号整理答疑库（归档 30 天未引用） ----------
  if (config.archive?.enabled !== false && shouldArchive(usage)) {
    log('\n  [整理] 本月首次运行，执行答疑库归档…');
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
      log(`    归档 ${res.archived.length} 条 → ${res.coldFile || '(无)'}`);
      log(`    保留 ${res.kept.length} 条`);
      qa.length = 0;
      qa.push(...(await loadQaLibrary(config.paths.qaFile)));
    } catch (e) {
      log(`    [警告] 归档失败：${e.message}`);
    }
  }

  // ---------- 1. 一次请求：按发布时间降序 ----------
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
    const needComments =
      commentCount > 0 &&
      (looksQ
        ? isNew || !(prev?.replied && prev.reason === REASON.ALREADY_REPLIED) || commentsChanged
        : summonOn && (commentsChanged || prev?.summonPending === true));
    let comments = null;

    if (needComments) {
      try {
        const c = await listComments({ momentId: id, from: 0, limit: 30 });
        comments = c.list || [];
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
        post.summonCandidates = summonOn
          ? pickSummons(flat, { config, teamIds: TEAM_IDS, prev })
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
      !prev?.praised
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
          const { text: praiseText, emoji } = composePraise({
            author: target.author,
            replyText: target.text,
            signature: config.praise?.signature === false ? '' : config.reply?.signature || '',
            // 已经发过的话不重复用（含前面的答疑回复/夸奖/分享互动）
            usedTexts: Object.values(state.recentReplies || {})
              .filter((x) => x && x.text)
              .map((x) => x.text),
          });
          praisePlan = {
            commentId: target.targetCommentId,
            author: target.author,
            authorId: target.authorId,
            answerExcerpt: target.text.slice(0, 40),
            emoji,
            text: praiseText,
          };
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

    // 组装回复：同一份答案不原样重复发（变体 + 避开已发文本）
    const usedTexts = Object.values(state.recentReplies || {})
      .filter((r) => r && r.text)
      .map((r) => r.text);
    const composed = verdict.matchedEntry
      ? composeReply(verdict.matchedEntry, config, { postId: id, usedTexts })
      : null;
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

    // 2f. 玩家喊我们 → 按语义准备一句互动（真正发送在 3e）
    //
    // 规则（用户 2026-10-29）：
    //   敏感（退款/客服/封号/充值/外挂/账号交易…）→ 礼貌拒绝
    //   问了具体问题 → 先用答疑库答；答不上来 → 安慰 + 鼓励
    //   其余 → 按语气鼓励 / 赞扬 / 欣赏 / 同情
    // 护栏：不贬低、不辱骂、不替官方承诺（assertKind）+ 泄露自检 + 文案必须单行（楼中楼限制）
    let summonPlans = [];
    if (summonOn && post.summonCandidates?.length) {
      const usedForSummon = Object.values(state.recentReplies || {})
        .filter((r) => r && r.text)
        .map((r) => r.text);
      for (const s of post.summonCandidates) {
        try {
          const r = buildSummonReply({
            text: s.text,
            author: s.author,
            // 散列带上评论 ID：同一帖里对不同人说的话也不会撞成同一句
            postId: `${id}:${s.commentId}`,
            config,
            qa,
            usedTexts: usedForSummon,
          });
          const kind = assertKind(r.text);
          const safe = assertNoLeak(r.text);
          const blocked = !kind.ok ? kind.hit : !safe.ok ? `泄露自检命中「${safe.hit}」` : null;
          if (blocked) log(`  [拦截] 《${post.title}》的喊话回复被护栏拦下（${blocked}）→ 转人工`);
          // r.text 是**我们的回复**，会覆盖 s.text（玩家原话）→ 另存 origin
          summonPlans.push({ ...s, ...r, origin: s.text, blocked });
          if (!blocked) usedForSummon.push(r.text);
        } catch (e) {
          summonPlans.push({ ...s, origin: s.text, text: null, mood: 'other', blocked: `生成失败: ${e.message}` });
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
    };
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
            runner: prunner,
            log,
          });
          if (r.ok) {
            sent++;
            p.praised = true;
          } else {
            p.note = `夸奖失败@${r.stage}`;
            log(
              `    [FAIL] 失败（${r.stage}）` +
                (r.detail ? '：' + JSON.stringify(r.detail).slice(0, 140) : '')
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
          const text = buildRefusalText(u.id, config.reply.emoji?.enabled !== false);
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
    const shares = results.filter(
      (r) =>
        r.status === STATUS.NO_NEED &&
        r.reason === REASON.NOT_QUESTION &&
        looksLikeShare(r.title) &&
        !state.posts[r.id]?.shareCommented
    );
    if (shares.length) {
      const cap = config.share?.maxPerRun ?? 2;
      log(`\n  -> 分享帖可互动 ${shares.length} 条（上限 ${cap}）${dryRun ? '（dry-run，不发送）' : ''}`);
      const usedTexts = Object.values(state.recentReplies || {}).map((x) => x.text);
      if (dryRun) {
        for (const s of shares.slice(0, cap)) {
          const { text, mood } = buildShareText({
            postId: s.id,
            title: s.title,
            text: s.text,
            usedTexts,
            signature: config.share?.signature ? config.reply?.signature || '' : '',
          });
          log(`\n  -- [dry-run] 分享互动（${mood}）：${s.title}`);
          log(`      | ${text}`);
        }
      } else {
        const srunner = makeRunner({
          opencliMain: config.reply.opencliMain,
          session: config.reply.session,
        });
        if (doctorOk(srunner).ok) {
          let n = 0;
          for (const s of shares) {
            if (n >= cap) {
              log('    [跳过] 超出本轮分享互动上限');
              break;
            }
            const { text, emoji, mood } = buildShareText({
              postId: s.id,
              title: s.title,
              text: s.text,
              usedTexts,
              signature: config.share?.signature ? config.reply?.signature || '' : '',
            });
            log(`\n  -- 分享互动（${mood}）：${s.title}`);
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

  // ---------- 4. 落盘 + 报表 ----------
  const summoned = results.reduce((n, r) => n + (r.summons || []).filter((s) => s.sent).length, 0);
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
