// 场景级负反馈学习（用户 2026-11-12）
//
// 要解决的问题：
//   玩家反感某类行为时，我们得**少做**那一类，而不是只在那一帖里收敛。
//   典型：大家集中发「天宫码」，玩家反感 → 我们就别再逐个捧场了。
//
// ⚠️ **跨帖**（用户 2026-11-12 强调）：
//   分数、冷却都是**场景级**的 —— 帖 A 引起的反感，扣的是「捧场类」这个场景的分，
//   帖 B / 帖 C 的捧场行为一起受影响。per-post 只记「哪些帖被跳过了」（审计用），不记分。
//
// 场景（只管捧场类三个，用户定的范围）：
//   praise_code  贴码分享（天宫码）→ 夸无私分享
//   share_reply  进度/攻略分享     → 凑热闹
//   comfort      纯情绪帖          → 陪一句共情
//
// 三档动作（用户定的强度：保守）：
//   score ≥ 1  观察   只记账
//   score ≥ 2  降权   每轮该场景只回 1 条 + 回复概率 25%
//   score ≥ 3  冷却   该场景 N 分钟不参与；队列里该场景的帖子踢出 + 不再入队
//
// 两路负反馈信号：
//   A 玩家明说反感（「又来了」「魔了」「别贴了」…）—— 注意游戏语境防误判
//   B 同质化密度（30 分钟内同类帖 ≥3 条）——「大家集中发多个天宫码」

import { looksLikeShare, looksLikeEmotion } from './qa.mjs';
import { looksLikeCodeShare, looksLikeCodeAsk } from './code-guard.mjs';
import { tagsFromConfig } from './signature.mjs';

/** 捧场类场景（用户 2026-11-12 定的范围：只管这三个） */
export const CHATTER_SCENES = ['praise_code', 'share_reply', 'comfort'];

/** 场景中文名（日志/报表用） */
export const SCENE_LABEL = {
  praise_code: '贴码捧场',
  share_reply: '分享凑热闹',
  comfort: '情绪陪聊',
};

/**
 * 这个帖属于哪个场景（只认捧场类；其它返回 null）
 * @param {string} title
 * @param {string} text
 * @returns {string|null}
 */
export function sceneOfPost(title, text) {
  const s = `${title || ''}\n${text || ''}`;
  if (looksLikeCodeShare(s) && !looksLikeCodeAsk(s)) return 'praise_code';
  if (looksLikeShare(title || '')) return 'share_reply';
  if (looksLikeEmotion(s)) return 'comfort';
  return null;
}

/** 玩家明说反感的强信号（注意「别再贴」「别老是发」这类中间加字也要认） */
const DISLIKE_STRONG =
  /(刷屏|别(?:再|老|总|又)?贴|别(?:再|老|总|又)?发|又来了|天天发|天天贴|求求了|受不了|烦死|烦人|恶心|谁要|又是这个|又贴|重复了|看腻|看烦|凑什么|有必要吗|水一贴|灌水|别灌水|硬夸|别(?:再|老|总|又)?捧|捧场了|别凑|跟风|别跟风|别插话)/;
/** 中等信号（单独出现也算，但权重低） */
const DISLIKE_MID =
  /(魔了|绝了|这啥|啥玩意|没用|一样的|又是一样的|又是这句|重复|捧场|硬夸|别(?:再|老|总|又)?夸|夸了|回那么多|回了好?多|别(?:再|老|总|又)?回了)/;
/** 弱信号：单独出现不触发，只作佐证 */
const DISLIKE_WEAK = /(呵呵|呵|无语|笑死|离谱|就这|就这就这|？|\?)/;

/**
 * 赞叹语境 —— 出现这些词时，同一句话不算反感
 * （「这操作魔了」是夸，「别刷了魔了」是骂；游戏区这两种都常见）
 */
const PRAISE_CONTEXT = /(厉害|牛逼|牛批|太强|强|羡慕|眼馋|不错|稳|漂亮|帅|膜拜|大佬|高手|服了|可以啊|真棒|厉害啊|太强了)/;

/**
 * 判一句玩家评论是不是「对这类行为反感」
 * @param {string} text
 * @returns {{hit:boolean, weight:number, why:string}}
 */
export function detectDislike(text) {
  const t = String(text || '').trim();
  if (!t) return { hit: false, weight: 0, why: '' };
  // 赞叹语境优先（避免「这操作魔了」被当成反感）
  if (PRAISE_CONTEXT.test(t) && !DISLIKE_STRONG.test(t)) {
    return { hit: false, weight: 0, why: '' };
  }
  if (DISLIKE_STRONG.test(t)) return { hit: true, weight: 1, why: '明确反感' };
  if (DISLIKE_MID.test(t)) return { hit: true, weight: 1, why: '负面评价' };
  if (DISLIKE_WEAK.test(t)) return { hit: false, weight: 0, why: '弱信号（不单独触发）' };
  return { hit: false, weight: 0, why: '' };
}

/**
 * 「涉及整个类别」的词 —— 玩家抱怨的不是这一帖，而是**这一类行为**
 *
 * 用户 2026-11-12 的例子：「小鲸鱼你别硬夸了，**捧场**了」
 *   → 主场景（贴码捧场）满权重；同大类的另外两个场景**减半**跟着降权。
 *   玩家只喷某一种（只提「天宫码」）→ 不传染，只罚那一类。
 */
const CATEGORY_WIDE_RE = /(捧场|都别|一直|天天|到处|每个|全体|通通|一堆|接二连三|老是|净是|各个|一类|这种)/;

/**
 * 信号是不是「涉及整个类别」（→ 同大类其它场景减半跟着降权）
 * @param {string} text
 */
export function isCategoryWide(text) {
  return CATEGORY_WIDE_RE.test(String(text || ''));
}

/**
 * 信号是不是「在对我们说」
 *
 * 用户 2026-11-12 定的规则（2026-11-12 晚修正）：
 *   ① 提到我们（**签名 / 别名**）→ 满权重
 *      ⚠️ **不含**第二人称「你/你们」—— 那多半是在跟楼主/别的玩家说话，
 *         按「其它」处理（半权重）
 *   ② 通过**回复我们 / @我们**得到的信号 —— 一定是回复我们的（调用方判定后传 toUs=true）
 * 不对我们说的（只是嫌这类帖多）→ 权重减半，罚得轻些
 * @param {string} text
 * @param {object} config
 */
export function mentionsUs(text, config) {
  const t = String(text || '');
  for (const tag of tagsFromConfig(config)) {
    if (!tag) continue;
    if (t.includes(tag)) return true;
    const inner = tag.replace(/[「」『』【】\[\]()（）\s-]/g, '');
    if (inner && inner !== tag && t.includes(inner)) return true;
  }
  return false;
}

/**
 * 记一条玩家反感 → **主场景 + 同大类传染（减半）**
 *
 * 用户 2026-11-12 定的传播规则：
 *   · 三个捧场场景（praise_code / share_reply / comfort）**各自独立计分**
 *   · 反馈「涉及整个类别」时 → 同大类的其它场景**减半**跟着降权
 *     例：「小鲸鱼你别硬夸了，捧场了」→ 贴码捧场满权重（最后完全停），
 *         分享凑热闹 / 情绪陪聊 各得一半（降权，偶尔还回一下）
 *   · 反馈只针对某一种时 → 不传染，只罚那一类
 *   · 信号「不是对我们说的」（只是嫌这类帖多）→ 权重减半，罚得轻
 *
 * @returns {{hit:boolean, scene:string, weight:number, spread:Array<{scene:string,weight:number}>, why:string}}
 */
export function recordSceneDislike(state, scene, text, { config = {}, cid = '', toUs = null, nowMs = Date.now() } = {}) {
  const dis = detectDislike(text);
  if (!dis.hit || !scene || !CHATTER_SCENES.includes(scene)) {
    return { hit: false, scene: scene || '', weight: 0, spread: [], why: dis.why || '' };
  }
  // 对我们说的 → 满权重；只是嫌这类帖多 → 半权重
  //   toUs 显式传入优先（回复我们/@我们的信号，调用方已经判定过）
  const aimedAtUs = toUs === null ? mentionsUs(text, config) : Boolean(toUs);
  const weight = aimedAtUs ? dis.weight : dis.weight * 0.5;
  const spread = [];
  bumpScene(state, scene, {
    weight,
    why: dis.why,
    sample: text,
    cid: cid ? `${cid}` : '',
    spread: false,
    nowMs,
  });
  // 涉及整个类别 → 同大类其它场景减半跟着降权
  if (isCategoryWide(text)) {
    for (const other of CHATTER_SCENES) {
      if (other === scene) continue;
      bumpScene(state, other, {
        weight: weight * 0.5,
        why: `同类传染（${dis.why}·涉及整个类别）`,
        sample: text,
        cid: cid ? `${cid}` : '',
        spread: true,
        nowMs,
      });
      spread.push({ scene: other, weight: weight * 0.5 });
    }
  }
  return { hit: true, scene, weight, spread, why: dis.why, toUs: aimedAtUs };
}

/** 玩家夸我们的词（正反馈） */
const PRAISE_US_RE =
  /(谢谢|多谢|感谢|辛苦|真棒|太棒|厉害|牛逼|牛批|太强|靠谱|贴心|暖|赞|好评|给力|用心|认真|负责|可爱|辛苦啦)/;

/**
 * 判一句是不是「夸」
 * @param {string} text
 * @returns {{hit:boolean, why:string}}
 */
export function detectPraise(text) {
  const t = String(text || '').trim();
  if (!t) return { hit: false, why: '' };
  if (PRAISE_US_RE.test(t)) return { hit: true, why: '玩家夸我们' };
  return { hit: false, why: '' };
}

/**
 * 记一条正反馈 → 该场景 **−1**（用户 2026-11-12）
 *
 * 例：玩家在贴码帖下说「谢谢小鲸鱼」→ praise_code.score −1，抵消之前的反感罚分。
 * ⚠️ 只认**夸我们**的（提到我们 / 回复我们）；「谢谢楼主」这种夸别人的不算。
 * ⚠️ 正反馈**不传染**到别的场景（只谢这一类），也不设下限 —— 分数可为负，落回 normal 档。
 *
 * @returns {{hit:boolean, scene:string, weight:number, why:string, toUs:boolean}}
 */
export function recordScenePraise(state, scene, text, { config = {}, cid = '', toUs = null, nowMs = Date.now() } = {}) {
  const pr = detectPraise(text);
  if (!pr.hit || !scene || !CHATTER_SCENES.includes(scene)) {
    return { hit: false, scene: scene || '', weight: 0, why: pr.why || '', toUs: false };
  }
  const aimedAtUs = toUs === null ? mentionsUs(text, config) : Boolean(toUs);
  if (!aimedAtUs) return { hit: false, scene, weight: 0, why: '不是夸我们', toUs: false };
  const weight = -1;
  bumpScene(state, scene, {
    weight,
    why: pr.why,
    sample: text,
    cid: cid ? `${cid}` : '',
    spread: false,
    nowMs,
  });
  return { hit: true, scene, weight, why: pr.why, toUs: true };
}

/**
 * 给场景记一笔负反馈（**跨帖**：记在场景上，不记在某帖）
 * @param {object} state
 * @param {string} scene
 * @param {object} o
 * @param {number} [o.weight=1]
 * @param {string} [o.why]
 * @param {string} [o.sample]
 * @param {boolean} [o.spread] 是否是同类传染来的
 * @param {number} [o.nowMs]
 */
export function bumpScene(state, scene, { weight = 1, why = '', sample = '', cid = '', spread = false, nowMs = Date.now() } = {}) {
  if (!scene || !CHATTER_SCENES.includes(scene)) return 0;
  state.sceneFeedback = state.sceneFeedback || {};
  const rec = state.sceneFeedback[scene] || { hits: [], updatedAt: 0 };
  rec.hits = Array.isArray(rec.hits) ? rec.hits : [];
  // 同一条评论只算一次（每轮都会重读评论，不去重的话分数会一路虚涨）
  if (cid && rec.hits.some((h) => h.cid && h.cid === String(cid))) {
    return effectiveScore(state, scene, nowMs);
  }
  rec.hits.push({
    at: nowMs,
    w: Number(weight || 1),
    why: why || '',
    cid: cid ? String(cid) : '',
    spread: Boolean(spread),
    sample: String(sample || '').slice(0, 40),
  });
  // 只留最近 7 天，太多会撑爆 state
  const cut = nowMs - 7 * 24 * 3600 * 1000;
  rec.hits = rec.hits.filter((h) => Number(h.at || 0) >= cut);
  rec.updatedAt = nowMs;
  state.sceneFeedback[scene] = rec;
  return effectiveScore(state, scene, nowMs);
}

/**
 * 场景的有效分数 —— **24 小时半衰期**（用户 2026-11-12）
 *
 * 每条信号的权重按年龄衰减：age=0 → 原值；age=24h → 一半；age=48h → 四分之一。
 * 目的：**昨天的烂场子今天不该继续罚**（昨天的 4 分 → 今天 2 分 → 明天 1 分）。
 *
 * ⚠️ 之前实现的是「48 小时硬窗口」（到点清零），不是半衰期 —— 已改。
 *
 * @param {object} state
 * @param {string} scene
 * @param {number} [nowMs]
 * @param {number} [halfLifeMs] 半衰期（默认 24 小时）
 */
export function effectiveScore(state, scene, nowMs = Date.now(), halfLifeMs = 24 * 3600 * 1000) {
  const rec = state?.sceneFeedback?.[scene];
  if (!rec || !Array.isArray(rec.hits)) return 0;
  const hl = Number(halfLifeMs || 24 * 3600 * 1000);
  let s = 0;
  for (const h of rec.hits) {
    const age = nowMs - Number(h.at || 0);
    if (age < 0) continue; // 未来时间戳不算
    s += Number(h.w || 1) * Math.pow(0.5, age / hl);
  }
  return s;
}

/**
 * 三档区间（用户 2026-11-12 改成**范围判断**，不再是单点阈值）：
 *   normal     (−∞, 1.5)   观察
 *   downgraded [1.5, 2.5)  降权（每轮 1 条 + 25%）
 *   cooldown   [2.5, ∞)    冷却
 * min=null 表示 −∞，max=null 表示 ∞。正反馈会把分数拉低（可为负）→ 落回 normal。
 */
export const DEFAULT_BANDS = [
  { level: 'normal', min: null, max: 1.5 },
  { level: 'downgraded', min: 1.5, max: 2.5 },
  { level: 'cooldown', min: 2.5, max: null },
];

/** 从配置取区间（没配就用默认） */
export function resolveBands(cfg) {
  const b = cfg?.bands;
  if (Array.isArray(b) && b.length) return b;
  return DEFAULT_BANDS;
}

/** 分数落在哪个区间 → 档位 */
export function levelOfScore(score, bands = DEFAULT_BANDS) {
  for (const b of bands || []) {
    const lo = b.min == null ? -Infinity : Number(b.min);
    const hi = b.max == null ? Infinity : Number(b.max);
    if (score >= lo && score < hi) return b.level;
  }
  return 'normal';
}

/**
 * 场景当前处于哪一档（**区间判断**）
 * @returns {{level:'normal'|'downgraded'|'cooldown', score:number, until:number, why:string}}
 */
export function sceneStatus(state, scene, { nowMs = Date.now(), bands = DEFAULT_BANDS, halfLifeMs = 24 * 3600 * 1000 } = {}) {
  // ⚠️ **必须取整到 3 位再比区间**：
  //    半衰期衰减会让「刚好 1.5 分」变成 1.4999999，直接比会**差一点掉档**（实测踩到）。
  const score = Math.round(effectiveScore(state, scene, nowMs, halfLifeMs) * 1000) / 1000;
  const cd = state?.sceneCooldown?.[scene];
  const until = Number(cd?.until || 0);
  if (until && nowMs < until) {
    return { level: 'cooldown', score, until, why: cd?.why || '冷却中' };
  }
  const level = levelOfScore(score, bands);
  if (level === 'normal') return { level, score, until: 0, why: '' };
  const band = (bands || []).find((b) => b.level === level) || {};
  const lo = band.min == null ? '−∞' : band.min;
  const hi = band.max == null ? '∞' : band.max;
  return { level, score, until: 0, why: `分数 ${score} 落在 [${lo}, ${hi})` };
}

/**
 * 进入冷却（该场景 N 分钟内不参与）
 * @returns {number} 冷却截止时间
 */
export function coolScene(state, scene, minutes = 60, why = '', nowMs = Date.now()) {
  if (!scene) return 0;
  state.sceneCooldown = state.sceneCooldown || {};
  const until = nowMs + Number(minutes || 60) * 60 * 1000;
  state.sceneCooldown[scene] = { at: nowMs, until, why, minutes: Number(minutes || 60) };
  return until;
}

/**
 * 同质化密度检测（**跨帖**）：窗口内同类帖数量
 * @param {Array<{scene:string, publishTime:number}>} items
 * @param {string} scene
 * @param {object} o
 * @returns {{flood:boolean, count:number, windowMs:number}}
 */
export function isSceneFlood(items, scene, { nowMs = Date.now(), windowMs = 30 * 60 * 1000, maxCount = 3 } = {}) {
  const cut = nowMs - windowMs;
  const count = (items || []).filter(
    (it) => it && it.scene === scene && Number(it.publishTime || 0) >= cut && Number(it.publishTime || 0) <= nowMs
  ).length;
  return { flood: count >= Number(maxCount || 3), count, windowMs };
}

/**
 * 降权后的回复概率（默认 25%）
 * @param {object} o
 * @param {number} [o.rng] 随机源（测试可注入）
 * @param {number} [o.prob=0.25]
 */
export function rollDowngraded({ rng = Math.random, prob = 0.25 } = {}) {
  return rng() < Number(prob);
}

/**
 * 这一帖（按场景）现在能不能参与
 * @returns {{ok:boolean, level:string, reason:string, score:number, until:number}}
 */
export function sceneGate(state, scene, { nowMs = Date.now(), bands = DEFAULT_BANDS, halfLifeMs = 24 * 3600 * 1000 } = {}) {
  if (!scene) return { ok: true, level: 'normal', reason: '', score: 0, until: 0 };
  const st = sceneStatus(state, scene, { nowMs, bands, halfLifeMs });
  if (st.level === 'cooldown') {
    return {
      ok: false,
      level: st.level,
      reason: `场景「${SCENE_LABEL[scene] || scene}」冷却中（${st.why}）`,
      score: st.score,
      until: st.until,
    };
  }
  if (st.level === 'downgraded') {
    return {
      ok: true,
      level: st.level,
      reason: `场景「${SCENE_LABEL[scene] || scene}」已降权（${st.why}）`,
      score: st.score,
      until: 0,
    };
  }
  return { ok: true, level: 'normal', reason: '', score: st.score, until: 0 };
}
