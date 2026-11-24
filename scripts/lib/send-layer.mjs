// 统一发送层（B4-0，2026-11-19）：把 collect 里 8 处「发送 + 成功记账」收口到一处。
//
// 为什么：8 处各自调 replyOne / sendPraise / sendSummonReply / sendInteractReply，
//   成功后各自写 markDoneEvent / state 标记 / recentReplies / trace / recordCitation ——
//   重复且容易漏（历史上漏过幂等门，导致一帖被回 29 次）。
//
// 设计：**只收口「发送 + 标准记账」，不接管业务特有的计数/决策**（失败计数等仍留调用方），
//   因此行为与改造前逐项等价；底层函数可注入（测试用 stub）。
//
// 处理顺序（与原来一致）：
//   ① 空正文拦截（不发只有签名的空回复，2026-11-10 事故）
//   ② 幂等预检（plan.done 已存在 → 跳过，不重复发）
//   ③ 发送（按 kind 选底层函数）
//   ④ 成功 → stateFlags + markDoneEvent + recentReplies + trace(sent) + recordCitation
//   ⑤ 失败 → trace(sent{failed})，返回 {ok:false, stage, detail} 由调用方记账

import * as replierMod from './replier.mjs';
import * as praiseSendMod from './praise-send.mjs';
import * as summonSendMod from './summon-send.mjs';
import * as interactSendMod from './interact-send.mjs';
import { hasDoneEvent, markDoneEvent } from './post-records.mjs';
import { recordCitation } from './usage.mjs';
import { trace } from './trace.mjs';
import { begin, since, phaseTrace } from './perf.mjs';
import { liteHash } from './util.mjs';

/**
 * 发送成功后的标准记账（B4-9d 抽出为可复用）。
 * 两个调用方：
 *   · send() 内部（persist:true，单进程模式）
 *   · plugin-runner（线程池模式）：worker 只发送，父进程在这里统一记账 → 避免多线程并发写库
 * @returns {{ok:boolean}}
 */
export function bookkeep(plan, result, { config = {}, state = {}, db = null, usage = null, log = () => {} } = {}) {
  const ok = Boolean(result?.ok);
  const postId = String(plan?.postId || '');
  const text = String(plan?.text || '').trim();
  if (ok) {
    if (plan?.stateFlags && state?.posts) {
      state.posts[postId] = { ...(state.posts[postId] || {}), ...plan.stateFlags };
    }
    if (plan?.done && db) {
      try {
        // T15：把**我们自己发的那条评论的 id** 一起落库。
        //   有了它才能按 id 确认「这条确实发出去了」（不再靠模糊搜文本），
        //   也才能在跨轮次时知道「玩家的这条回复是在回我们哪一条」（T30 回访的基础）。
        const sentCommentId = String(result?.detail?.commentId || result?.commentId || '');
        markDoneEvent(db, postId, plan.done.kind, {
          ...(plan.done.key ? { [plan.done.key]: plan.done.value } : {}),
          ...(plan.done.extra || {}),
          ...(sentCommentId ? { sentCommentId } : {}),
          text: text.slice(0, 80),
          at: new Date().toISOString(),
        });
      } catch (e) {
        log(`    [记账] markDoneEvent 失败：${e.message}`);
      }
    }
    if (state?.recentReplies && text) {
      state.recentReplies[liteHash(text)] = { text, at: new Date().toISOString(), count: 1, postId };
    }
    if (usage && plan?.meta?.qaId) {
      try { recordCitation(usage, plan.meta.qaId); } catch {}
    }
  }
  trace({
    config,
    event: 'sent',
    postId,
    sent: ok,
    kind: plan?.kind || 'answer',
    // title / entryId 一起带上（T32：core 的答疑路径改走这里后，trace 信息不能变少）
    ...(plan?.title ? { title: plan.title } : {}),
    ...(plan?.meta?.qaId ? { entryId: plan.meta.qaId } : {}),
    reason: ok ? undefined : (result?.stage || result?.reason || 'send_failed'),
    note: plan?.meta?.scene ? `scene=${plan.meta.scene}` : undefined,
  });
  return { ok };
}

/**
 * @param {object} [impl] 注入底层发送函数（测试）
 * @returns {{send: Function}}
 */
export function createSendLayer(impl = {}) {
  const replyOne = impl.replyOne || replierMod.replyOne;
  const sendPraise = impl.sendPraise || praiseSendMod.sendPraise;
  const sendSummonReply = impl.sendSummonReply || summonSendMod.sendSummonReply;
  const sendInteractReply = impl.sendInteractReply || interactSendMod.sendInteractReply;

  /**
   * @param {object} plan
   *   kind: 'answer'|'praise'|'summon'|'interact'
   *   level: 0(帖子一级回复)|1(回复)|2(楼中楼)
   *   postId, url, text
   *   commentId?, parentId?, playerKey?, mention?, commentText?, point?
   *   mentions?: [{id,name}]  T29：@ 目标（id 必填才有真 @ 效果）
   *   done?: {kind, key, value, extra}     成功后写幂等事件
   *   stateFlags?: object                   成功后合并进 state.posts[postId]
   *   meta?: {qaId, emojiKind, scene}
   * @param {object} ctx {config, state, db, runner, praiseDb, log, dryRun, usage}
   * @returns {Promise<{ok:boolean, stage?:string, detail?:object, reason?:string, skipped?:boolean}>}
   */
  async function send(plan, ctx = {}) {
    const {
      config = {}, db = null, runner = null, praiseDb = null, log = () => {},
      dryRun = false, usage = null,
      // 🆕 B4-9a（2026-11-19）：`persist:false` = **只发送不记账**。
      //   给 worker 线程用：多线程并发写 state.json/SQLite 会互相覆盖（历史丢过 172 条记录），
      //   所以线程只负责发送，记账统一由父进程做。
      persist = true,
    } = ctx;
    // 🆕 2026-11-23（F5）：**state 必须补齐成可写哑对象**。
    //   worker 线程只传「发送所需」（config/runner/log/persist），**不传 state**。
    //   而底层 sendPraise / sendSummonReply / sendInteractReply 在**发送成功之后**会写
    //   `state.posts[postId]` / `state.recentReplies` —— state 为 undefined 时直接 TypeError，
    //   被下面 catch 成 {ok:false, stage:'exception'} → **评论已经发出去了却记成失败**
    //   （实测 2026-11-23 15:22 那条 praise：trace 是 sent:false / reason:exception，
    //     但评论实际已发出，于是下一轮还会重发 = 又一种「重复处理」）。
    //   persist:false 时这个哑对象不落盘，没有任何副作用；persist:true 时就是真实 state。
    const state = (() => {
      const s = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
      if (!s.posts) s.posts = {};
      if (!s.recentReplies) s.recentReplies = {};
      return s;
    })();
    const text = String(plan?.text || '').trim();
    const postId = String(plan?.postId || '');

    // ① 空正文不发
    if (!text) {
      log('    [跳过] 草稿为空 → 不发送（不能发一条只有签名的空回复）');
      return { ok: false, reason: 'empty', skipped: true };
    }
    // ② 幂等预检（persist:false 时跳过：线程不读库，幂等由父进程在派发前做）
    if (persist && plan?.done && db && hasDoneEvent(db, postId, plan.done.kind, plan.done.key ? { key: plan.done.key, value: plan.done.value } : undefined)) {
      log(`    [跳过] 幂等门：${plan.done.kind} 已发送过`);
      return { ok: false, reason: 'duplicate', skipped: true };
    }

    // ③ 发送
    const __t0 = begin();
    let r;
    try {
      if (plan.kind === 'praise') {
        r = await sendPraise({
          config, state,
          postId,
          commentId: plan.commentId,
          url: plan.url,
          text,
          commentText: plan.commentText || '',
          point: plan.point || '',
          runner,
          praiseDb,
          log,
        });
      } else if (plan.kind === 'summon') {
        r = await sendSummonReply({
          state, postId,
          commentId: plan.commentId,
          url: plan.url,
          text,
          runner,
          via: config?.reply?.nestedVia || 'ui',
          log,
        });
      } else if (plan.kind === 'interact') {
        r = await sendInteractReply({
          state, postId,
          commentId: plan.commentId,
          parentId: plan.parentId || '',
          text,
          url: plan.url,
          playerKey: plan.playerKey || '',
          runner,
          via: config?.reply?.nestedVia || 'ui',
          log,
          /** T29：@ 目标（id + 名字）→ 官方 mention 节点 */
          mentions: plan.mentions || [],
        });
      } else {
        // answer（一级回复）/ 其它走 replyOne
        r = await replyOne({ runner, url: plan.url, text, config, dryRun, log });
      }
    } catch (e) {
      r = { ok: false, stage: 'exception', detail: { error: String(e?.message || e) } };
    }

    const ok = Boolean(r?.ok);
    // T20 打点：发送阶段独立记一条 phase（不改 sent 事件的业务语义）
    if (persist) phaseTrace(config, 'send', __t0, { postId, note: plan?.kind || 'answer' });
    // ④ 成功记账（persist:false → 全部跳过，由父进程 bookkeep 处理）
    if (ok && persist) {
      bookkeep(plan, r, { config, state, db, usage, log });
    }
    // ⑤ 失败也记 trace（persist 时）
    if (!ok && persist) {
      bookkeep(plan, r, { config, state, db, usage, log });
    }

    return { ok, stage: r?.stage, detail: r?.detail, reason: ok ? undefined : (r?.stage || 'send_failed') };
  }

  return { send };
}