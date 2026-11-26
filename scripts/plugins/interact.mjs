// 插件：interact（互动续聊）—— B4-5，2026-11-19
//
// 从 collect 的 2g（候选+生成）+ 3f（发送）迁出。行为等价：
//   · 玩家回应了我们（@你/回复你/喊你）→ 接一句；纯客套已在 pickInteractions 排除
//   · 同帖×同玩家回过 N 次后降概率（decideInteraction 管）
//   · 玩家在回我们时骂刷屏 → 走**认错口径**（kind=summon 文案），但发送仍走互动通道
//   · 同一条评论若同时是喊话候选 → 归内核认错通道，这里不重复回
//   · 上限：interact.maxPerPost / maxPerRun
//   · 护栏：assertKind + assertNoLeak（与旧块一致）
//   · 事件：interact_reply（按 commentId 去重）

import { decideInteraction, replyTargetFor, playerKey, pickInteractions, latestReplyState } from '../lib/interact.mjs';
import { detectCallOut, auditBrief } from '../lib/complaint.mjs';
import { assertKind } from '../lib/summon.mjs';
import { assertNoLeak } from '../lib/variants.mjs';
import { stripLeadingMention, assertSingleMention } from '../lib/compose-reply.mjs';
import { ourSentCommentIds } from '../lib/post-records.mjs';
import { isOurComment, commentText } from '../lib/signature.mjs';

/**
 * 自己算互动候选（T33，2026-11-20）
 *
 * 为什么插件要自己算：
 *   原来候选由 core 算好放在 `r.interactCandidates` 里 → core 与插件耦合。
 *   T33 删掉 core 的旧块时那段计算一起没了 → 插件拿不到候选 → 通道静默失效。
 *   自算才是真正的解耦（也符合 B4「插件自治」的设计）。
 *
 * 关键改进（T15）：
 *   「我们发过的评论 id」**从数据库拿**（发送时已把 sentCommentId 落库），
 *   列表反查只作兜底 —— 我们的子回复常常不在当轮列表里（旧接口只返前 2 条），
 *   靠列表会漏判「玩家这条是在回我们」→ 玩家回了我们却没人接（帖 872166231715613408 实例）。
 */
function pickCandidates(r, { config = {}, db = null, hasDoneEvent = () => false, log = () => {} } = {}) {
  // ① 调用方直接给了候选（老调用方 / 单测）→ 直接用
  if (Array.isArray(r?.interactCandidates) && r.interactCandidates.length) {
    return r.interactCandidates;
  }

  // ② 自己算（T33 之后的正常路径）
  const comments = Array.isArray(r?._comments) ? r._comments : [];
  if (!comments.length) return [];

  // 把一级 + 子回复摊平（与 collect 的 flattenAll 同语义）
  const flat = [];
  for (const c of comments) {
    flat.push({ c, parentId: null });
    for (const k of c.child_posts || []) flat.push({ c: k, parentId: String(c.id_str || '') });
  }

  // ②-0 帖级门控（2026-11-26 大哥规则）：最新回复是我们/队友 → 整帖不续聊
  //
  //   为什么要有这层：逐条判定只能看到「这条是不是在回我们」，
  //   看不到「最后说话的是谁」。我们回完 A 之后，最新回复就是我们了，
  //   这时再去接更早那条 A 的话，就是自说自话。
  //   只有等别人接上（最新回复变成别人的）才该继续。
  const latest = latestReplyState(flat, { config, teamIds: teamIdsOf(config) });
  if (latest.ours) {
    log(`  [互动] 跳过：${latest.why}（${latest.author || '未知'}：${String(latest.text || '').slice(0, 24)}）→ 等人接话`);
    return [];
  }
  if (latest.why === 'no-comments') return [];

  // 我们发过的评论 id：数据库优先（跨轮次也在），列表反查兜底
  const ourIds = new Set([
    ...ourSentCommentIds(db, r.id),
    ...flat.filter((x) => isOurComment(x.c, { config, teamIds: teamIdsOf(config) })).map((x) => String(x.c?.id_str || '')),
  ].filter(Boolean));

  let cands = pickInteractions(flat, { config, ourCommentIds: ourIds, prev: r._prev || {} });
  // 幂等：已经接过话的不再接
  cands = cands.filter((x) => !hasDoneEvent(r.id, 'interact_reply', { key: 'commentId', value: String(x.commentId) }));
  return cands;
}

/** 团队成员 id（我们 + 队友） */
function teamIdsOf(config) {
  return [config?.myUserId, ...(config?.teamUserIds || [])]
    .map((x) => String(x || '').trim())
    .filter((x) => x && !x.includes('*'));
}

/** 同一玩家在候选里出现几次 = 连续追问次数（与 collect 内同名函数同实现） */
function countFollowUps(candidates, cand) {
  const key = String(cand?.authorId || cand?.author || '');
  return (candidates || []).filter((c) => String(c?.authorId || c?.author || '') === key).length;
}

export default {
  id: 'interact',
  name: '互动续聊',

  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, compose = null, hasDoneEvent = () => false, db = null } = ctx;
    if (config.interact?.enabled === false || !compose) return null;

    const perPost = Number(config.interact?.maxPerPost ?? 1);
    const plans = [];

    for (const r of results || []) {
      if (r._codeAsking) continue;
      // T33：候选**自己算**（原来由 core 算好塞在 r.interactCandidates 里）。
      //   core 那个计算已随旧块一起删除 → 插件自算才是真正的解耦。
      //   而且自算能用上 T15 的数据库查询：**我们发过的评论 id 从库里拿**，
      //   不再靠「当轮评论列表按作者 id 反查」（我们的子回复常不在列表里 → 漏判）。
      const cands = pickCandidates(r, { config, db, hasDoneEvent, log });
      if (!cands.length) continue;
      let made = 0;
      for (const cand of cands) {
        if (made >= perPost) {
          log(`  [互动] 《${String(r.title || '').slice(0, 18)}》本帖互动已达上限 ${perPost} → 其余留到下一轮`);
          break;
        }
        // 幂等：这条评论已接过话
        if (hasDoneEvent(r.id, 'interact_reply', { key: 'commentId', value: String(cand.commentId) })) continue;

        const counts = (r._prev || {}).interactCounts || {};
        const followUps = countFollowUps(cands, cand);
        const d = decideInteraction(cand, { counts, config, followUps });
        if (!d.reply) {
          log(`  [互动] ${cand.author || '玩家'}「${String(cand.text).slice(0, 18)}」→ 不回（${d.reason}）`);
          continue;
        }
        const target = replyTargetFor(cand);
        const callout = detectCallOut(String(cand.text || ''));
        const apologize = callout.mode === 'callout';
        // 同一评论同时是喊话候选 → 交内核认错通道，不重复回
        if (apologize && (r.summonCandidates || []).some((x) => String(x.commentId) === String(cand.commentId))) {
          log(`  [互动] ${cand.author || '玩家'}「${String(cand.text).slice(0, 18)}」→ 是投诉，交给认错通道，不重复回`);
          continue;
        }

        const hint = apologize
          ? '对方是在**指出我们刷屏/乱回**（他在回我们的话）。' +
            (auditBrief(r.ourAudit) ? `${auditBrief(r.ourAudit)}\n` : '') +
            '处理方式：① 认真看整栋楼上下文，数清我们在这个帖回了几条；' +
            '② 是我们的问题就直接认（重复回/回太多/答非所问都算），说清哪条不对，别狡辩、别甩锅；' +
            '③ 认完就收手 —— 不许再补第二条、不许再凑热闹；' +
            '④ 不许替官方表态、不许承诺处理结果。'
          : target.mention
            ? `对方是「${target.mention}」。你是在**同层楼中楼**里回他 —— **直接接话，正文里不要写 @ 和对方名字**（系统会自动带上一次），也别在开头重复称呼。`
            : `你是在「${target.label}」里回他，称呼用「${cand.author || '对方'}」。`;

        const gen = await compose({
          config,
          kind: apologize ? 'summon' : 'interact',
          tree: r._threadTree || null,
          targetId: String(cand.commentId),
          hint,
          log,
        });
        if (!gen?.ok) {
          log(`  [互动] 生成失败（${gen?.reason}）→ 跳过`);
          continue;
        }
        const kindChk = assertKind(gen.body || gen.text);
        const safe = assertNoLeak(gen.body || gen.text);
        const blocked = !kindChk.ok ? kindChk.hit : !safe.ok ? `泄露自检命中「${safe.hit}」` : null;
        if (blocked) {
          log(`  [拦截] 《${String(r.title || '').slice(0, 18)}》的互动回复被护栏拦下（${blocked}）→ 不发`);
          continue;
        }
        // T29（2026-11-20）：@ 改成**官方 mention 节点**（真 @，会触发对方通知）。
        //   正文不再拼纯文本 @名字；名字 + user_id 一起交给发送层生成 mention 节点。
        const mentions = [];
        if (target.mention) {
          const mid = String(target.mentionId || cand.authorId || '');
          mentions.push({ id: mid, name: target.mention });
          if (!mid) {
            log(`  [降级] 《${String(r.title || '').slice(0, 18)}》@${target.mention} 缺 user_id → 只能纯文本 @（不触发通知）`);
          }
        }
        let text = stripLeadingMention(gen.text);
        const atChk = assertSingleMention(text, target.mention);
        if (!atChk.ok) {
          text = stripLeadingMention(gen.text);
          log(`  [修正] 《${String(r.title || '').slice(0, 18)}》${atChk.hit} → 收敛为 1 个`);
        }
        log(`\n  -> 互动续聊：${String(r.title || '').slice(0, 20)}（@${cand.author || '玩家'}）`);
        plans.push({
          plugin: 'interact',
          kind: 'interact',
          level: target.level || 1,
          postId: String(r.id),
          url: r.url,
          title: r.title,
          text,
          commentId: String(cand.commentId),
          parentId: target.parentId || '',
          playerKey: playerKey(cand),
          mention: target.mention || '',
          mentions,
          priority: 60,
          mutexKey: `post:${r.id}`,
          done: { kind: 'interact_reply', key: 'commentId', value: String(cand.commentId) },
          meta: { scene: apologize ? 'interact_apologize' : 'interact' },
        });
        made++;
      }
    }
    return plans.length ? plans : null;
  },
};