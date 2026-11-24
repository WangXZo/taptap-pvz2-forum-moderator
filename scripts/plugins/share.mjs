// 插件：share（分享帖轻互动 + 天宫码无私分享夸奖）—— B4-3，2026-11-19
//
// 从 collect 的 3d 块整块迁出，行为与旧块等价：
//   · 发码帖（JFA… 且不是在求码）→ 夸「无私分享」行为；场景 praise_code；事件 code_praise
//   · 其它分享/进度/庆祝帖 → 凑一句热闹；场景 share_reply；事件 share_reply
//   · 幂等双查（state 热 + post_event 持久）—— 只看 state 会重复回（2026-11-10 一帖被回 29 次）
//   · 刹车闸 canChatter + 场景闸（冷却/降权）
//   · 上限：分享 share.maxPerRun、发码 share.maxCodePraisePerRun
//
// 硬约束（与旧块一致）：只说话不输出信息、不评价具体数值、不引答疑库内容。

import { looksLikeShare } from '../lib/qa.mjs';
import { looksLikeCodeShare, looksLikeCodeAsk } from '../lib/code-guard.mjs';
import { canChatter } from '../lib/complaint.mjs';
import { sceneGate, resolveBands, rollDowngraded } from '../lib/scene-feedback.mjs';
import { buildThreadTree } from '../lib/thread-context.mjs';
import { STATUS, REASON } from '../lib/state.mjs';

const HINT_CODE = '他把天宫码直接贴出来给大家用。这是无私分享的行为，夸这个行为本身；不要评价码还有没有效、不要索要、不要说自己也想要。';
const HINT_CELEBRATE =
  '他抽到了稀有植物（看图/文字，如瓷砖萝卜）。替他高兴、夸他欧、接住兴奋。若提到688/2888钻，那是稀有/传奇宝箱十连（已知），别问单抽还是十连；留个别的话头（攒了多久钻/下一个想抽啥）。别讲攻略别扫兴别酸。';
const HINT_SHARE = '他在分享进度或攻略。你去凑一句热闹。别评价具体数值对不对，别提任何攻略库内容，别说教。';

export default {
  id: 'share',
  name: '分享互动',

  async planBatch(results = [], ctx = {}) {
    const { config = {}, log = () => {}, state = {}, hasDoneEvent = () => false, compose = null } = ctx;
    if (config.share?.enabled === false || !compose) return null;

    const isCodeShare = (r) =>
      looksLikeCodeShare(`${r.title || ''}\n${r.text || ''}`) && !looksLikeCodeAsk(`${r.title || ''}\n${r.text || ''}`);
    const codeDone = (id) => Boolean(state.posts?.[id]?.shareCommented) || hasDoneEvent(id, 'code_praise');
    const shareDone = (id) => Boolean(state.posts?.[id]?.shareCommented) || hasDoneEvent(id, 'share_reply');
    // 🆕 2026-11-23（F2）：**我们或队友已经在这帖开过口** → 不再去说第二遍。
    //   以前只查「自己」发过的事件，队友（config.teamUserIds，如 622***）回过看不见 →
    //   队友夸完 bot 又夸一遍（大哥报的现场：《天宫码（安卓）》《天宫拿去》两帖都这样）。
    //   判定由 core 统一给出（isOurComment：队友 id + 签名结尾），插件不自己另立标准。
    const teamSpoke = (r) => Boolean(r?._teamSpoke);

    const chatterOk = (r) => {
      const c = canChatter(state, r.id);
      if (c.ok) return true;
      log(`  [刹车] 《${String(r.title || '').slice(0, 20)}》${c.reason} → 本轮不凑热闹（答疑/致歉照常）`);
      return false;
    };

    const sf = config.sceneFeedback || {};
    const gateOf = (scene) =>
      ctx.gateOf?.(scene) ||
      sceneGate(state, scene, { bands: resolveBands(sf), halfLifeMs: Number(sf.halfLifeHours ?? 24) * 3600 * 1000 });
    const applyGate = (list, scene) => {
      const g = gateOf(scene);
      if (!g.ok) {
        log(`  [场景] ${g.reason} → 本轮不回这一类（跨帖生效，答疑/致歉/有内容的互动照常）`);
        return [];
      }
      if (g.level === 'downgraded') {
        const one = list.slice(0, 1);
        const keep = rollDowngraded({ prob: Number(sf.downgradedProb ?? 0.25) }) ? one : [];
        log(`  [场景] ${g.reason} → 本轮${keep.length ? '只回 1 条' : '也不回'}（跨帖生效）`);
        return keep;
      }
      return list;
    };

    // 🆕 2026-11-23 大哥要求「天宫码，捧场，关闭」：
    //   **单独一条开关**，只停「夸无私分享」；分享帖轻互动、天宫码撮合都不动。
    //   config.share.codePraise=false → 这条通道整体让位（下面 codeShares 直接空）。
    const codePraiseOn = config.share?.codePraise !== false;
    const CODE_CAP = Number(config.share?.maxCodePraisePerRun ?? 2);
    const codeShares = !codePraiseOn
      ? []
      : applyGate(
          (results || [])
            .filter((r) => r.status === STATUS.NO_NEED && !codeDone(r.id) && !teamSpoke(r) && isCodeShare(r) && chatterOk(r))
            .slice(0, CODE_CAP),
          'praise_code'
        );
    const shares = applyGate(
      (results || []).filter(
        (r) =>
          r.status === STATUS.NO_NEED &&
          r.reason === REASON.NOT_QUESTION &&
          (looksLikeShare(r.title) || r.imageCelebrate) &&
          !shareDone(r.id) &&
          !teamSpoke(r) &&
          !isCodeShare(r) &&
          chatterOk(r)
      ),
      'share_reply'
    );

    const plans = [];

    for (const s of codeShares) {
      const gen = await compose({
        config,
        kind: 'praise',
        tree: buildThreadTree({ id: s.id, title: s.title, text: s.text, author: s.author, authorId: s.authorId }, []),
        targetId: `post:${s.id}`,
        hint: HINT_CODE,
        log,
      });
      if (!gen.ok) {
        log(`    [跳过] 生成失败（${gen.reason}）`);
        continue;
      }
      log(`\n  -> 天宫码分享可夸：${String(s.title || '').slice(0, 20)}（上限 ${CODE_CAP}）`);
      plans.push({
        plugin: 'share',
        kind: 'answer',
        level: 0,
        postId: String(s.id),
        url: s.url,
        title: s.title,
        text: gen.text,
        priority: 40,
        mutexKey: `post:${s.id}`,
        stateFlags: { shareCommented: true, codePraiseAt: new Date().toISOString() },
        done: { kind: 'code_praise' },
        meta: { scene: 'praise_code' },
      });
    }

    const cap = Number(config.share?.maxPerRun ?? 2);
    for (const s of shares.slice(0, cap)) {
      const gen = await compose({
        config,
        kind: s.imageCelebrate ? 'celebrate' : 'share',
        tree: buildThreadTree({ id: s.id, title: s.title, text: s.text, author: s.author, authorId: s.authorId }, []),
        targetId: `post:${s.id}`,
        hint: s.imageCelebrate ? HINT_CELEBRATE : HINT_SHARE,
        log,
      });
      if (!gen.ok) {
        log(`    [跳过] 分享互动生成失败（${gen.reason}）`);
        continue;
      }
      log(`\n  -> 分享帖可互动：${String(s.title || '').slice(0, 20)}（上限 ${cap}）`);
      plans.push({
        plugin: 'share',
        kind: 'answer',
        level: 0,
        postId: String(s.id),
        url: s.url,
        title: s.title,
        text: gen.text,
        priority: 40,
        mutexKey: `post:${s.id}`,
        stateFlags: { shareCommented: true, shareAt: new Date().toISOString() },
        done: { kind: 'share_reply' },
        meta: { scene: 'share_reply' },
      });
    }

    return plans.length ? plans : null;
  },
};