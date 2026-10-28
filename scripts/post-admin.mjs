#!/usr/bin/env node
// 帖子诊断与状态管理工具
//
// 用法：node scripts/post-admin.mjs <子命令> [参数]
//   fetch <momentId...>            打印这些帖子的问答（含「我」标记）
//   mark-replied <momentId...>     标记为「我已回复」（版主亲手答过的帖子）
//   reset-praised <momentId...>    重置「已夸奖」标记（发失败/误发时重试用）
//   reset-share <momentId...>      重置「已分享互动」标记
//   cleanup <来源链接...>          按来源链接清理：答疑库条目 + 使用统计 + 状态记录
//   diag [条数]                    命中率诊断：每个帖子的最高匹配分 + 各阈值命中数
//
// 说明：所有路径来自 scripts/config.json，跟着 skill 目录走。
//
// 例子：
//   node scripts/post-admin.mjs fetch 863832282933232344
//   node scripts/post-admin.mjs mark-replied 863832282933232344
//   node scripts/post-admin.mjs diag 10

import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from './lib/paths.mjs';
import { listFeed, listComments, extractText, flattenContents } from './lib/http.mjs';
import { loadQaLibrary, matchPost, looksLikeQuestion } from './lib/qa.mjs';
import { loadUsage, entryKeyOf } from './lib/usage.mjs';
import { loadState, STATUS, REASON } from './lib/state.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1).filter((a) => !a.startsWith('--'));

const config = await loadConfig();
const MY_ID = String(config.myUserId || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdFetch() {
  if (!rest.length) {
    console.error('用法：post-admin.mjs fetch <momentId...>');
    process.exit(1);
  }
  for (const id of rest) {
    const c = await listComments({ momentId: id, from: 0, limit: 30 });
    console.log(`\n================ 帖子 ${id} ================`);
    console.log(`链接：https://www.taptap.cn/moment/${id}`);
    for (const x of c.list || []) {
      const mine = String(x.author?.id) === MY_ID;
      console.log(`[${x.id_str}] ${x.author?.name}(${x.author?.id})${mine ? ' ★我' : ''}: ${flattenContents(x.contents)}`);
      for (const ch of x.child_posts || []) {
        const m2 = String(ch.author?.id) === MY_ID;
        console.log(`    └ [${ch.id_str}] ${ch.author?.name}(${ch.author?.id})${m2 ? ' ★我' : ''}: ${flattenContents(ch.contents)}`);
      }
    }
    await sleep(1800);
  }
}

async function patchState(ids, fn, label) {
  const state = await loadState(config.paths.stateFile);
  let n = 0;
  for (const id of ids) {
    if (!state.posts[id]) {
      console.log(`跳过 ${id}（状态库里没有）`);
      continue;
    }
    fn(state.posts[id]);
    n++;
    console.log(`已处理 ${id}（${state.posts[id].title || ''}）`);
  }
  await writeFile(config.paths.stateFile, JSON.stringify(state, null, 2), 'utf8');
  console.log(`${label}：共 ${n} 条`);
}

async function cmdMarkReplied() {
  await patchState(
    rest,
    (p) => {
      p.status = STATUS.REPLIED;
      p.reason = REASON.ALREADY_REPLIED;
      p.replied = true;
      p.repliedAt = p.repliedAt || new Date().toISOString();
    },
    '标记已回复'
  );
}

async function cmdResetPraised() {
  await patchState(
    rest,
    (p) => {
      p.praised = false;
      p.praisedAt = null;
    },
    '重置夸奖标记'
  );
}

async function cmdResetShare() {
  await patchState(
    rest,
    (p) => {
      p.shareCommented = false;
      p.shareAt = null;
    },
    '重置分享互动标记'
  );
}

/** 按来源链接清理：答疑库条目 + 使用统计 + 状态记录 */
async function cmdCleanup() {
  if (!rest.length) {
    console.error('用法：post-admin.mjs cleanup <来源链接...>');
    process.exit(1);
  }
  const sources = new Set(rest);
  const ids = new Set([...sources].map((u) => u.split('/').pop()));

  // 1) 答疑库
  const qaRaw = await readFile(config.paths.qaFile, 'utf8').catch(() => '');
  const kept = qaRaw
    .split(/\n(?=##\s)/g)
    .filter((b) => !/^##\s/m.test(b) || ![...sources].some((s) => b.includes(s)));
  const removedQa = qaRaw.split(/\n(?=##\s)/g).filter((b) => /^##\s/m.test(b) && [...sources].some((s) => b.includes(s))).length;
  await writeFile(config.paths.qaFile, kept.join('\n'), 'utf8');
  console.log(`答疑库：删除 ${removedQa} 条`);

  // 2) 使用统计
  const usage = JSON.parse(await readFile(config.paths.usageFile, 'utf8').catch(() => '{"items":{}}'));
  let removedUsage = 0;
  for (const k of Object.keys(usage.items || {})) {
    if ([...sources].includes(usage.items[k].source)) {
      delete usage.items[k];
      removedUsage++;
    }
  }
  await writeFile(config.paths.usageFile, JSON.stringify(usage, null, 2), 'utf8');
  console.log(`使用统计：删除 ${removedUsage} 条`);

  // 3) 状态库
  const state = await loadState(config.paths.stateFile);
  let removedPosts = 0;
  for (const id of ids) {
    if (state.posts[id]) {
      delete state.posts[id];
      removedPosts++;
    }
  }
  await writeFile(config.paths.stateFile, JSON.stringify(state, null, 2), 'utf8');
  console.log(`状态库：删除 ${removedPosts} 条`);
}

/** 命中率诊断：为什么「待回复」是 0 */
async function cmdDiag() {
  const top = Number(rest[0] || 10);
  const qa = await loadQaLibrary(config.paths.qaFile);
  const usage = await loadUsage(config.paths.usageFile);
  console.log(`答疑库 ${qa.length} 条\n`);

  const feed = await listFeed({ groupId: config.groupId, from: 0, limit: top, sort: 'created' });
  const rows = [];
  for (const item of feed.list) {
    const { title, text } = extractText(item);
    const t = title || text;
    if (!t) continue;
    const cands = matchPost(text, qa, 3, { usage });
    rows.push({
      title: t.replace(/\n/g, ' / ').slice(0, 42),
      isQ: looksLikeQuestion(text),
      top: cands[0] ? Number(cands[0].score.toFixed(3)) : 0,
      entry: cands[0]?.entry.question?.slice(0, 22) || '-',
      kw: cands[0] ? `${cands[0].hits}/${cands[0].keywordsTotal}` : '-',
      auto: !!cands[0]?.entry?.auto,
    });
    await sleep(1500);
  }

  console.log('标题'.padEnd(44) + '提问  最高分  命中词  最接近的条目');
  console.log('-'.repeat(110));
  for (const r of rows.sort((a, b) => b.top - a.top)) {
    console.log(
      r.title.padEnd(44) +
        (r.isQ ? ' 是  ' : ' 否  ') +
        String(r.top).padEnd(8) +
        String(r.kw).padEnd(8) +
        (r.auto ? '[沉淀] ' : '') +
        r.entry
    );
  }
  const qs = rows.filter((r) => r.isQ).map((r) => r.top).sort((a, b) => b - a);
  console.log(`\n提问帖 ${qs.length} 条，最高 ${qs[0] ?? 0}，中位 ${qs[Math.floor(qs.length / 2)] ?? 0}`);
  for (const th of [0.75, 0.65, 0.55, 0.45]) {
    console.log(`  阈值 ${th} → 命中 ${qs.filter((s) => s >= th).length} 条`);
  }
  console.log(`\n提示：命中的是「自己的沉淀条目」不算真命中（那条帖已被他人回答）；`);
  console.log('     真正的缺口看 scripts/report-gaps.mjs 生成的 reports/gaps.md');
}

/**
 * recheck：用**当前规则**重新判定指定的帖子，并补做沉淀与夸奖
 *
 * 为什么需要：
 *   规则改过之后，早先判错的帖子**不会自己翻案** —— 翻案只在扫描窗口内生效，
 *   而老帖子早已滑出窗口，状态里的错判会永远留在报表里。
 *   （实例：「未来礼盒什么时候返场」在旧规则下缺「什么/返场」被判成非提问帖，
 *     其实是提问帖，且已有玩家回答。）
 *
 * 用法：node scripts/post-admin.mjs recheck <momentId...> [--praise]
 *   不带 --praise：只重新判定 + 沉淀答案，不发任何评论
 *   带  --praise：额外把楼中楼夸奖发出去
 */
async function cmdRecheck() {
  if (!rest.length && !argv.includes('--all')) {
    console.error('用法：post-admin.mjs recheck <momentId...> [--praise] | recheck --all [--limit N]');
    process.exit(1);
  }
  const doPraise = argv.includes('--praise');
  const { classify } = await import('./lib/classify.mjs');
  const { buildQaEntry, appendQaEntry } = await import('./lib/summarize.mjs');
  const { pickPraiseTarget, composePraise } = await import('./lib/praise.mjs');
  const { sendPraise } = await import('./lib/praise-send.mjs');
  const { makeRunner, doctorOk } = await import('./lib/replier.mjs');
  const { statOf, recordCitation } = await import('./lib/usage.mjs');

  const state = await loadState(config.paths.stateFile);
  const qa = await loadQaLibrary(config.paths.qaFile);
  const usage = await loadUsage(config.paths.usageFile);
  let runner = null;

  // --all：批量**预演**（只看标题，不抓评论、不改状态、不发送）
  // ⚠️ 只看标题是近似的：正文里可能还有「有没有人互换」这类疑问词，
  //    守护进程用「标题+正文」判定，所以批量结果仅供参考 ——
  //    要真正改状态必须加 --apply，且最好逐条用 recheck <id> 核实。
  if (argv.includes('--all')) {
    const apply = argv.includes('--apply');
    const limit = Number(rest[0] || 50);
    const ids = Object.keys(state.posts || {}).slice(0, limit);
    console.log(`批量重判 ${ids.length} 个历史帖（只看标题）${apply ? '  —— 将写入状态' : '  —— 仅预演，不改状态'}\n`);
    const flipped = [];
    for (const id of ids) {
      const prev = state.posts[id];
      const post = {
        id,
        url: prev.url,
        title: prev.title || '',
        text: prev.title || '',
        publishTime: prev.publishTime || 0,
        commentCount: prev.commentCount || 0,
        iReplied: prev.replied && prev.reason !== REASON.OTHERS_REPLIED,
        othersReplied: prev.reason === REASON.OTHERS_REPLIED,
        replyCount: prev.replyCount || 0,
      };
      const verdict = classify(post, { qa, config, state });
      if (verdict.status !== prev.status || verdict.reason !== prev.reason) {
        flipped.push({ id, title: post.title, from: `${prev.status}/${prev.reason}`, to: `${verdict.status}/${verdict.reason}` });
        if (apply) {
          prev.status = verdict.status;
          prev.reason = verdict.reason;
          prev.replied = verdict.status === STATUS.REPLIED;
        }
      }
    }
    if (apply) await writeFile(config.paths.stateFile, JSON.stringify(state, null, 2), 'utf8');
    console.log(`发现 ${flipped.length} 条判定可能不同：`);
    for (const f of flipped) console.log(`  ${f.id}  《${f.title}》\n      ${f.from} → ${f.to}`);
    if (!apply) {
      console.log('\n（预演模式，未改动状态）');
      console.log('  加 --apply 才写入；但批量只看标题，**准确做法是逐条**：');
      console.log('  node scripts/post-admin.mjs recheck <id> [--praise]   ← 会抓评论、按标题+正文判定');
    }
    return;
  }

  for (const id of rest) {
    const prev = state.posts[id];
    if (!prev) {
      console.log(`跳过 ${id}（状态库里没有，先让它进一次扫描窗口）`);
      continue;
    }
    const title = prev.title || '';

    // 1) 读评论，重建 post
    let comments = [];
    try {
      const c = await listComments({ momentId: id, from: 0, limit: 30 });
      comments = c.list || [];
    } catch (e) {
      console.log(`  [跳过] ${id}：读评论失败 ${e.message}`);
      continue;
    }
    const uid = String(config.myUserId || '__none__');
    const mine =
      comments.some((x) => String(x.author?.id || '') === uid) ||
      comments.some((x) => (x.child_posts || []).some((ch) => String(ch.author?.id || '') === uid));
    const others = comments.some((x) => String(x.author?.id || '') !== uid);

    const post = {
      id,
      url: prev.url || `https://www.taptap.cn/moment/${id}`,
      title,
      text: title,
      author: prev.author || '',
      publishTime: prev.publishTime || 0,
      commentCount: comments.length,
      iReplied: mine,
      othersReplied: others && !mine,
      replyCount: comments.length,
    };

    // 2) 用当前规则重新判定
    const verdict = classify(post, { qa, config, state });
    const oldStatus = prev.status;
    const oldReason = prev.reason;
    const changed = oldStatus !== verdict.status || oldReason !== verdict.reason;

    console.log(`\n《${title}》`);
    console.log(`  原判定：${oldStatus}/${oldReason}`);
    console.log(`  新判定：${verdict.status}/${verdict.reason}${changed ? '   ← 有变化' : ''}`);

    prev.status = verdict.status;
    prev.reason = verdict.reason;
    prev.replied = verdict.status === STATUS.REPLIED;
    prev.lastSeen = new Date().toISOString();

    // 3) 他人已答 → 沉淀答案（每帖只做一次）
    if (verdict.reason === REASON.OTHERS_REPLIED && comments.length && !prev.learnedQa) {
      const entry = buildQaEntry({
        post,
        comments,
        myUserId: config.myUserId,
        signature: config.reply?.signature || '',
      });
      if (entry) {
        const res = await appendQaEntry(config.paths.qaFile, entry);
        if (res.added) {
          const st = statOf(usage, entryKeyOf(entry.question), { source: entry.source });
          st.createdAt = new Date().toISOString();
          prev.learnedQa = true;
          console.log(`  [沉淀] 《${entry.question}》 ← 摘自 ${entry.fromAuthor}`);
        }
      }
    }

    // 4) 夸奖（可选）
    if (doPraise && verdict.reason === REASON.OTHERS_REPLIED && !prev.praised) {
      const target = pickPraiseTarget(comments, {
        myUserId: config.myUserId,
        minScore: config.praise?.minScore ?? 1,
      });
      if (target) {
        const { text: praiseText, emoji } = composePraise({
          author: target.author,
          replyText: target.text,
          signature: config.praise?.signature === false ? '' : config.reply?.signature || '',
          usedTexts: Object.values(state.recentReplies || {})
            .filter((x) => x && x.text)
            .map((x) => x.text),
        });
        if (!runner) {
          runner = makeRunner({ opencliMain: config.reply.opencliMain, session: config.reply.session });
          if (!doctorOk(runner).ok) {
            console.log('  [FAIL] opencli 不可用，跳过夸奖');
            runner = null;
          }
        }
        if (runner) {
          console.log(`  [夸奖] ${target.author}（评论 ${target.targetCommentId}，表情 ${emoji}）`);
          const r = await sendPraise({
            config,
            state,
            postId: id,
            commentId: target.targetCommentId,
            url: post.url,
            text: praiseText,
            runner,
            log: (m) => console.log('  ' + m),
          });
          if (!r.ok) console.log(`  [FAIL] 夸奖失败（${r.stage}）`);
        }
      }
    }

    await sleep(1800);
  }

  await writeFile(config.paths.stateFile, JSON.stringify(state, null, 2), 'utf8');
  await writeFile(config.paths.usageFile, JSON.stringify(usage, null, 2), 'utf8');
  console.log('\n状态库与使用统计已更新');
}

const CMDS = {
  fetch: cmdFetch,
  'mark-replied': cmdMarkReplied,
  'reset-praised': cmdResetPraised,
  'reset-share': cmdResetShare,
  cleanup: cmdCleanup,
  diag: cmdDiag,
  recheck: cmdRecheck,
};

if (!cmd || !CMDS[cmd]) {
  console.log('帖子工具：node scripts/post-admin.mjs <子命令>');
  console.log('  fetch / mark-replied / reset-praised / reset-share / cleanup / diag / recheck');
  console.log('  详细说明见 references/admin.md');
  process.exit(cmd ? 1 : 0);
}

await CMDS[cmd]();
