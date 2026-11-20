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

import { decideInteraction, replyTargetFor, playerKey } from '../lib/interact.mjs';
import { detectCallOut, auditBrief } from '../lib/complaint.mjs';
import { assertKind } from '../lib/summon.mjs';
import { assertNoLeak } from '../lib/variants.mjs';
import { stripLeadingMention, assertSingleMention } from '../lib/compose-reply.mjs';

/** 同一玩家在候选里出现几次 = 连续追问次数（与 collect 内同名函数同实现） */
function countFollowUps(candidates, cand) {
  const key = String(cand?.authorId || cand?.author || '');
  return (candidates || []).filter((c) => String(c?.authorId || c?.author || '') === key).length;
}

export default {
  id: 'interact',
  name: '互动续聊',

  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, compose = null, hasDoneEvent = () => false } = ctx;
    if (config.interact?.enabled === false || !compose) return null;

    const perPost = Number(config.interact?.maxPerPost ?? 1);
    const plans = [];

    for (const r of results || []) {
      if (r._codeAsking) continue;
      const cands = r.interactCandidates;
      if (!Array.isArray(cands) || !cands.length) continue;
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
        // @ 只拼一次（2026-11-20 修「同一回复重复 @」）：提示词已禁止模型写 @，
        // 这里再加一道断言，万一模型仍写了就剥掉重拼，保证同名字只出现一次。
        let text = target.mention ? `@${target.mention} ${gen.text}` : gen.text;
        const atChk = assertSingleMention(text, target.mention);
        if (!atChk.ok) {
          text = `@${target.mention} ${stripLeadingMention(gen.text)}`;
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