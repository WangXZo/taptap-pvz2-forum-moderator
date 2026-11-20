// 插件：praise（夸答题玩家，楼中楼）—— B4-4，2026-11-19
//
// 从 collect 的 2d（挑目标+生成）+ 3b（发送）块迁出。行为等价：
//   · 条件：他人已答（OTHERS_REPLIED）+ 非求码帖 + 有评论 + 未夸过 + 失败次数未超限
//   · 目标：pickPraiseTarget（排除自己/版主/客服引导/私下交换/贴码/纯反问）
//   · 幂等：state.praisedComments + post_event(praise_reply, commentId)
//   · 生成：kind=praise，按三层上下文夸到点上，avoidTexts 避开最近说过的
//   · 发送：楼中楼（level 1/2），事件 praise_reply
//   · 上限：praise.maxPerRun（默认 3）

import { pickPraiseTarget } from '../lib/praise.mjs';
import { REASON } from '../lib/state.mjs';

export default {
  id: 'praise',
  name: '夸答题玩家',

  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, state = {}, hasDoneEvent = () => false, compose = null, praiseHistoryTexts = [] } = ctx;
    if (config.praise?.enabled === false || !compose) return null;

    const cap = Number(config.praise?.maxPerRun ?? 3);
    const plans = [];

    for (const r of results || []) {
      if (plans.length >= cap) break;
      if (r.reason !== REASON.OTHERS_REPLIED) continue;
      if (r._codeAsking) continue;
      const comments = r._comments;
      if (!Array.isArray(comments) || !comments.length) continue;
      const prev = r._prev || {};
      if (prev.praised) continue;
      // 幂等门（持久）：这条帖已经夸过谁了
      if (hasDoneEvent(r.id, 'praise_reply')) continue;
      // 失败次数上限：楼中楼 UI 偶尔找不到目标，不无限重试
      if (Number(prev.praiseFailCount || 0) >= Number(config.praise?.maxFailRetries ?? 3)) continue;

      let target = null;
      try {
        target = pickPraiseTarget(comments, {
          myUserId: config.myUserId,
          minScore: config.praise?.minScore ?? 1,
        });
      } catch (e) {
        log(`  [夸奖] 挑目标失败（${e.message}）`);
        continue;
      }
      if (!target) continue;
      // 同一条回答只夸一次
      const doneIds = prev.praisedComments || [];
      if (doneIds.includes(String(target.targetCommentId))) {
        log(`  [跳过] 《${r.title}》的这条回答 ${target.targetCommentId} 之前已夸过`);
        continue;
      }
      if (hasDoneEvent(r.id, 'praise_reply', { key: 'commentId', value: target.targetCommentId })) continue;

      const gen = await compose({
        config,
        kind: 'praise',
        tree: r._threadTree || null,
        targetId: String(target.targetCommentId),
        avoidTexts: praiseHistoryTexts,
        log,
      });
      if (!gen?.ok) {
        log(`  [跳过] 夸奖生成失败（${gen?.reason}）→ 不夸，不退回模板`);
        continue;
      }
      log(`\n  -> 可夸奖：${String(r.title || '').slice(0, 20)}（上限 ${cap}）`);
      plans.push({
        plugin: 'praise',
        kind: 'praise',
        level: 1,
        postId: String(r.id),
        url: r.url,
        title: r.title,
        text: gen.text,
        commentId: String(target.targetCommentId),
        commentText: target.text || '',
        point: '',
        priority: 30,
        mutexKey: `post:${r.id}`,
        stateFlags: { praised: true, praisedAt: new Date().toISOString() },
        done: { kind: 'praise_reply', key: 'commentId', value: String(target.targetCommentId) },
        meta: { scene: 'praise' },
      });
    }

    return plans.length ? plans : null;
  },
};