// 「无意义刷屏」审查 + 刹车 —— 玩家发现我们刷屏之后的自我纠错闭环
//
// 背景（2026-11-12 真实事故）：
//   两个帖子里我们连发了 13 条几乎一样的「恭喜恭喜」式凑热闹回复，玩家直接开骂
//   ——「我的天啊，这大肥鱼疯了！」「肥鱼队员，你在干什么吗？！」
//   版主只能手动回「抱歉，大肥鱼抽风了」救场。
//
// 之前已有「认错」的一半（collect.mjs 的 calledOut 分支：先数自己回了几条再认），
// 但**缺了后半截**：认完错并没有刹车，下一轮照旧凑热闹、照旧接话 → 继续刷。
//
// ⚠️ 刹车范围（用户 2026-11-12 明确）：**只停「无意义刷屏」，不是不回复**
//   停：夸无私分享 / 分享互动 / 纯情绪陪聊 —— 这三类是「凑热闹」，最容易变刷屏
//   不停：答疑回复、认错致歉、针对具体内容的互动续聊 —— 这些是有意义的回复
//
// 判定口径：**不设数，只看投诉 + 自审证据**
//   玩家指出我们闯祸（callout）**且**自审发现我们确实在重复（内容雷同）→ 才停凑热闹
//   玩家只是骂两句、但我们回得很正常 → 只认错，不停手

import { isOurComment, tagsFromConfig } from './signature.mjs';
import { tokenize } from './qa-vector.mjs';

/** 「玩闹式叫唤」：`大肥鱼出来玩呀！` —— 不是问罪，别当闯祸处理 */
const PLAYFUL_RE = /(出来玩|出来聊|出来嗨|来玩|陪我|出来唠|出来耍|开黑)/;

/**
 * 「问罪/叫出来」—— 我们大概率闯祸了
 * 用户 2026-11-10 定的原话示例：`大肥鱼！！！出来` / `坏了坏了，这大肥鱼彻底魔了`
 *
 * ⚠️ 收窄过：游戏里「刷副本/刷金币/刷等级」是日常用语，不能光一个「刷」就算投诉
 *    → 一律要求带限定词（刷屏/别刷/到处刷/老是刷…）。
 *    同样，「完了」只在「彻底完了/这下完了」这种口气里算。
 */
const CALL_OUT_RE =
  /(滚出来|给我出来|出来|解释|说清楚|怎么回事|咋回事|什么情况|啥情况|你干的好事|你干的什么|你回的是什么|你回的好|你回了几条|什么回复|乱回|坏了坏了|彻底完了|这下完了|完了啊|魔了|疯了|抽风|刷屏|别刷|不要刷|少刷|乱刷|到处刷|又回|回了好?多|回那么多|重复了|重复回|你在干嘛|你在干什么|干什么呢|发什么疯|没完没了|适可而止|收手|闭嘴|别回了|不要回|别再回|停手|别烦|别理我)/;

/** 全局抱怨：抱怨的不只是这一帖（「到处刷」「多条帖」）→ 凑热闹通道冷静一会儿 */
const GLOBAL_COMPLAINT_RE = /(到处刷|到处回|不要到处|每个帖|每帖|多条帖|多个帖|很多帖|所有帖|所有帖子|老是刷|一直刷|天天刷)/;

/** 套话 / 身份攻击（沿用 collect.mjs 的口径，收拢到这里统一用） */
const INJECTION_RE =
  /(key|KEY|密钥|令牌|token|提示词|prompt|系统消息|系统提示|忘掉|忘记|忽略.{0,8}(指令|规则|设定)|你现在是|从现在起你是|角色扮演|扮演|人格|你是什么模型|哪个模型|谁开发|什么公司|接入|api|接口地址|数据库|脚本|源码|配置文件)/;

/**
 * 判一句话是不是「玩家在指出我们闯祸了」
 * @param {string} text
 * @returns {{mode:'none'|'callout'|'playful'|'injection', global:boolean, why:string}}
 */
export function detectCallOut(text) {
  const t = String(text || '');
  if (!t.trim()) return { mode: 'none', global: false, why: '' };
  if (PLAYFUL_RE.test(t)) return { mode: 'playful', global: false, why: '玩闹式叫唤' };
  if (INJECTION_RE.test(t)) return { mode: 'injection', global: false, why: '套话/身份攻击' };
  if (CALL_OUT_RE.test(t)) {
    const global = GLOBAL_COMPLAINT_RE.test(t);
    return {
      mode: 'callout',
      global,
      why: global ? '全局抱怨（到处刷/多条帖）' : '指出我们闯祸了',
    };
  }
  return { mode: 'none', global: false, why: '' };
}

/** 去掉表情与标点，取「这句话的核心」用于雷同比对 */
function coreOf(s) {
  return String(s || '')
    .replace(/\[表情_[^\]]*\]/g, '')
    .replace(/[「」『』“”"'’‘。，！？!?,、\s]/g, '')
    .slice(0, 12);
}

/** 词集合（中文 2/3-gram + ASCII 词） */
function tokenSet(text) {
  return new Set(tokenize(String(text || '')));
}

/**
 * 包含度（交集 / 较短那句的词数）
 *
 * 为什么用包含度不用余弦：一句长一句短时，余弦被长句的分母拖低，
 * 而「同一含义」在短句上更容易命中（实测同一帖的同义凑热闹回复包含度 0.15~0.65，
 * 不同含义的回复是 0.000 —— 分离度很干净）。
 */
export function containment(a, b) {
  const A = a instanceof Set ? a : tokenSet(a);
  const B = b instanceof Set ? b : tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * 剥掉我们自己的签名/别名和表情标记
 *
 * ⚠️ 必须剥：每条评论末尾都带「版主助手-小鲸鱼」，不剥的话每两条都共享签名词，
 * 相似度虚高 → 正常的两条回复也会被误判成「同样含义」。
 */
export function stripOurMark(text, config) {
  let s = String(text || '');
  for (const tag of tagsFromConfig(config)) {
    if (!tag) continue;
    s = s.split(tag).join(' ');
    const inner = tag.replace(/[「」『』【】\[\]()（）\s-]/g, '');
    if (inner && inner !== tag) s = s.split(inner).join(' ');
  }
  return s.replace(/\[表情_[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 自我审查：数我们在这一帖回了几条、哪些内容是**同样含义**（不同语句也算）
 *
 * 这是「认错」和「刹车」的**证据来源** —— 不能让 LLM 自己数（它数不准），
 * 由代码数清楚再喂给它。
 *
 * @param {Array<{c:object}>} flat  flattenAll 出来的扁平评论
 * @param {object} o
 * @param {object} o.config
 * @param {string[]} o.teamIds
 * @param {number} [o.dupSim=0.3] 包含度阈值：与前面某条的相似度 ≥ 它 → 算「同样含义」
 * @returns {{count:number, texts:string[], dupCount:number, repeated:boolean, sample:string, dupSamples:string[]}}
 */
export function auditOurReplies(flat, { config, teamIds = [], dupSim = 0.3 } = {}) {
  const ours = (flat || []).filter((x) => isOurComment(x.c, { config, teamIds }));
  const texts = ours
    .map((x) => stripOurMark(x.c?.__text || x.c?.text || '', config))
    .filter(Boolean);
  const sets = texts.map((t) => tokenSet(t));
  const dupSamples = [];
  let dupCount = 0;
  for (let i = 1; i < texts.length; i++) {
    let best = 0;
    for (let j = 0; j < i; j++) best = Math.max(best, containment(sets[i], sets[j]));
    if (best >= Number(dupSim || 0.3)) {
      dupCount++;
      dupSamples.push(texts[i].slice(0, 40));
    }
  }
  return {
    count: texts.length,
    texts,
    dupCount,
    repeated: dupCount >= 1,
    sample: texts.slice(0, 3).map((t) => t.slice(0, 40)).join(' / '),
    dupSamples: dupSamples.slice(0, 3),
  };
}

/**
 * 该不该给「凑热闹类发言」刹车
 *
 * @param {object} o
 * @param {object} o.callOut detectCallOut 的结果
 * @param {object} o.audit auditOurReplies 的结果
 * @param {number} [o.minDup=2] 自审至少要看到几条雷同才算「无意义刷屏」
 * @returns {{stop:boolean, why:string}}
 */
export function shouldStopChatter({ callOut, audit, minDup = 2 } = {}) {
  if (!callOut || callOut.mode !== 'callout') return { stop: false, why: '' };
  const dup = Number(audit?.dupCount || 0);
  if (callOut.global) {
    return { stop: true, why: `玩家抱怨「到处刷」${dup ? `（自审：本帖已有 ${dup} 条雷同回复）` : ''}` };
  }
  if (dup >= Number(minDup || 2)) {
    return { stop: true, why: `玩家指出我们刷屏 + 自审发现本帖已有 ${dup} 条雷同回复` };
  }
  return {
    stop: false,
    why: `玩家在抱怨，但自审没发现雷同刷屏（本帖我们回了 ${audit?.count || 0} 条，重复 ${dup} 条）→ 只认错，不停手`,
  };
}

/** 从 state 读「这一帖的凑热闹通道是否已停」 */
export function isChatterStopped(state, postId) {
  return Boolean(state?.posts?.[String(postId)]?.chatterStop);
}

/** 从 state 读「全局冷静期到什么时候（ms）；0 = 没在冷静期」 */
export function globalQuietUntil(state) {
  const g = state?.spamStopGlobal;
  if (!g?.until) return 0;
  return Number(g.until) || 0;
}

/**
 * 给这一帖打上「凑热闹通道已停」
 * @returns {{stopped:boolean, why:string}} stopped=false 表示本来就已经停了
 */
export function markChatterStopped(state, postId, info = {}) {
  const id = String(postId);
  state.posts = state.posts || {};
  state.posts[id] = state.posts[id] || {};
  if (state.posts[id].chatterStop) return { stopped: false, why: '已经停过了' };
  state.posts[id].chatterStop = {
    at: new Date().toISOString(),
    scope: info.scope || 'post',
    why: info.why || '玩家指出我们刷屏',
    ourCount: Number(info.ourCount || 0),
    dupCount: Number(info.dupCount || 0),
    by: info.by || '',
    text: String(info.text || '').slice(0, 80),
  };
  return { stopped: true, why: state.posts[id].chatterStop.why };
}

/** 进入全局冷静期（玩家抱怨「到处刷」时用）—— 只停凑热闹，不停答疑/致歉 */
export function markGlobalQuiet(state, minutes = 30, why = '') {
  const until = Date.now() + Number(minutes || 30) * 60 * 1000;
  state.spamStopGlobal = { at: new Date().toISOString(), until, why };
  return until;
}

/**
 * 凑热闹类发言现在能不能发
 *   · 全局冷静期内 → 不能
 *   · 该帖被投诉且自审确认刷屏 → 不能
 *   · 其它 → 能
 * @returns {{ok:boolean, reason:string}}
 */
export function canChatter(state, postId, { nowMs = Date.now() } = {}) {
  const until = globalQuietUntil(state);
  if (until && nowMs < until) {
    return { ok: false, reason: `全局冷静期（到 ${new Date(until).toLocaleString('zh-CN')}）` };
  }
  const stop = state?.posts?.[String(postId)]?.chatterStop;
  if (stop) {
    return { ok: false, reason: `该帖凑热闹已停（${stop.why}）` };
  }
  return { ok: true, reason: '' };
}

/**
 * 自我审查结论 —— 认错时喂给 LLM 的「证据」
 * 让模型知道自己在这帖回了几条、哪几条几乎一样，而不是让它自己数（它数不准）。
 */
export function auditBrief(audit) {
  if (!audit || !audit.count) return '';
  const parts = [`你在《这一帖》已经回过 ${audit.count} 条`];
  if (audit.dupCount) parts.push(`其中 ${audit.dupCount} 条内容几乎重复（例：${audit.dupSamples.join(' / ')}）`);
  return `【自我审查】${parts.join('，')}。`;
}
