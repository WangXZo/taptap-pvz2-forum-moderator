// 插件：comfort（纯情绪帖陪一句）—— B4-2，2026-11-19
//
// 从 collect 的 3d-2 块整块迁出。行为与旧块**逐项等价**：
//   · 筛选：NO_NEED/MANUAL + 本轮没开口过 + 未安慰过 + looksLikeEmotion + 刹车闸
//   · 场景闸：comfort 场景（冷却 → 全不回；降权 → 只 1 条 + 概率）
//   · 上限：config.comfort.maxPerRun（默认 2）
//   · 生成：kind=comfort，纯共情（不给资料、不给 hint 里禁止编数据）
//   · 发送：一级回复；成功后 comforted/comfortAt + comfort_reply 幂等事件 + recentReplies
//
// 一帖一次、楼主再回复走正常互动续聊 —— 与旧行为一致。

import { looksLikeEmotion } from '../lib/qa.mjs';
import { sceneGate, resolveBands, rollDowngraded } from '../lib/scene-feedback.mjs';
import { canChatter } from '../lib/complaint.mjs';
import { buildThreadTree } from '../lib/thread-context.mjs';
import { STATUS, REASON } from '../lib/state.mjs';

export const COMFORT_HINT =
  '他只是在发泄情绪，没有具体问题。陪着难受一下就好：认同情绪、别讲道理、别劝、别问细节、别评价数值、别说补偿或处理结果。';

export default {
  id: 'comfort',
  name: '情绪陪聊',

  /**
   * @param {Array} results 本轮逐帖判定结果
   * @param {object} ctx {config, log, state, db, dryRun, hasDoneEvent, compose, seenThisRun}
   * @returns {Array|null} plans（null/[] = 本轮不归我）
   */
  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, state = {}, hasDoneEvent = () => false } = ctx;
    if (config.comfort?.enabled === false) return null;

    // 分享互动 / 夸发码这一轮已经开口过的帖子不再安慰（与旧块同口径）
    const spoke = new Set(
      (results || [])
        .filter(
          (r) =>
            Boolean(state.posts?.[r.id]?.shareCommented) ||
            hasDoneEvent(r.id, 'share_reply') ||
            hasDoneEvent(r.id, 'code_praise')
        )
        .map((r) => String(r.id))
    );
    const comfortDone = (id) => Boolean(state.posts?.[id]?.comforted) || hasDoneEvent(id, 'comfort_reply');

    const candidates = (results || []).filter(
      (r) =>
        (r.status === STATUS.NO_NEED || r.status === STATUS.MANUAL) &&
        !spoke.has(String(r.id)) &&
        !comfortDone(r.id) &&
        // 🆕 2026-11-23（F2）：我们/队友已经在这帖开过口 → 不重复去陪
        //   （以前只查自己的事件，队友回过看不见 → 队友陪完 bot 又陪一遍）
        !r._teamSpoke &&
        looksLikeEmotion(`${r.title || ''}\n${r.text || ''}`) &&
        canChatter(state, r.id).ok
    );
    if (!candidates.length) return null;

    // 场景闸（跨帖）。ctx.gate 可注入（测试/内核复用），默认按 state 现算
    const sf = config.sceneFeedback || {};
    const gate = ctx.gate || sceneGate(state, 'comfort', {
      bands: resolveBands(sf),
      halfLifeMs: Number(sf.halfLifeHours ?? 24) * 3600 * 1000,
    });
    let list = candidates;
    if (!gate.ok) {
      log(`  [场景] ${gate.reason} → 本轮不陪聊这一类（跨帖生效）`);
      return null;
    }
    if (gate.level === 'downgraded') {
      const one = candidates.slice(0, 1);
      const keep = rollDowngraded({ prob: Number(sf.downgradedProb ?? 0.25) }) ? one : [];
      log(`  [场景] ${gate.reason} → 本轮${keep.length ? '只陪 1 条' : '也不陪'}（跨帖生效）`);
      list = keep;
    }
    if (!list.length) return null;

    const cap = Number(config.comfort?.maxPerRun ?? 2);
    const picked = list.slice(0, cap);
    log(`\n  -> 情绪帖可安慰 ${picked.length} 条（上限 ${cap}，一帖一次）`);

    const plans = [];
    for (const s of picked) {
      const gen = await ctx.compose({
        config,
        kind: 'comfort',
        tree: buildThreadTree({ id: s.id, title: s.title, text: s.text, author: s.author, authorId: s.authorId }, []),
        targetId: `post:${s.id}`,
        hint: COMFORT_HINT,
        log,
      });
      if (!gen.ok) {
        log(`    [跳过] 安慰生成失败（${gen.reason}）→ 转人工，不退回模板`);
        continue;
      }
      plans.push({
        plugin: 'comfort',
        kind: 'answer',
        level: 0,
        postId: String(s.id),
        url: s.url,
        title: s.title,
        text: gen.text,
        priority: 50,
        mutexKey: `post:${s.id}`,
        stateFlags: { comforted: true, comfortAt: new Date().toISOString() },
        done: { kind: 'comfort_reply' },
        meta: { scene: 'comfort' },
      });
    }
    return plans.length ? plans : null;
  },
};