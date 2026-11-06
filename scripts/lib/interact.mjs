// 互动续聊：玩家回应了我们 → 继续互动（用户 2026-11-05）
//
// 原话：
//   「当你夸了玩家，玩家回复你、要求互动，可进行回复」
//   「『玩家回信要求互动』怎么判定？@你、回复你、喊你（大肥鱼等包括别名）」
//   「但只是『哈哈谢谢』，不用回」
//   「超过 3 次降概率：同一帖累计回复数；3 次后 50%；分同一帖内分别累积同一玩家」
//   「情绪强烈必回」：长文本 / 直接 @ / 连续追问 / 情绪激动
//   「继续回复发在哪」：主贴→直接回复；贴内回复→该回复的楼中楼；本身是楼中楼→同层楼中楼并 @对方
//
// 模块边界（低耦合，别混）：
//   · 本模块只做**判定**：谁该回、概率多大、回在哪一层
//   · 文案 → lib/compose-reply.mjs（LLM，kind='interact'）
//   · 发送 → lib/interact-send.mjs（楼中楼执行器 + 记账）
// 三个模块各管一段，谁都不掺和别人的活。

import { commentText, isSummonText } from './signature.mjs';

// ---------- 1. 纯客套（「哈哈谢谢」这种不用回） ----------

/** 客套词表：这些词拼起来仍然是客套 */
const THANKS_WORDS = [
  '哈哈', '哈哈哈哈哈', '嘿嘿', '呵呵', '嘻', '嘿',
  '谢谢', '多谢', '感谢', '谢了', '谢', '辛苦', '辛苦啦',
  '牛', '牛逼', '牛批', '牛啊', '厉害', '棒', '强', '强啊', '666', '6',
  '顶', '赞', '支持', '爱了', '学到了', '受教了', '懂了', '明白', '收到',
  '大佬', '兄弟', '老哥', '朋友', '可以', '好的', '好', '嗯', '嗯嗯', '哦', '噢', '嗷',
];

/**
 * 这段话是不是**纯客套**（只是「哈哈谢谢」，不值得回）
 *
 * 规则：剥掉开头的笑声前缀后，剩下的字必须**全部**由客套词拼成。
 * 「谢谢大佬」「哈哈谢谢」「牛」→ 纯客套（不回）
 * 「谢谢大佬，顺便问个 XX 怎么过」→ 不是纯客套（要回）
 */
export function isPureThanks(text) {
  let t = String(text || '').replace(/\s+/g, '').trim();
  // 去掉纯表情标记
  t = t.replace(/\[(?:表情_[^\]]+|TapTap×[^\]]+)\]/g, '');
  if (!t) return true;
  // 剥掉结尾标点
  t = t.replace(/[!！。~～…,.，。、?？]+$/g, '');
  if (!t) return true;
  if (t.length > 16) return false; // 长句不是纯客套
  let rest = t;
  let guard = 0;
  while (rest && guard++ < 24) {
    const w = THANKS_WORDS.find((x) => rest.startsWith(x));
    if (!w) return false;
    rest = rest.slice(w.length);
  }
  return rest === '';
}

// ---------- 2. 情绪强烈 → 必回（不受概率限制） ----------

/** 情绪/紧急信号 */
const STRONG_EMOTION_RE =
  /(急死|着急|在线等|崩溃|难受|气死|疯了|救命|救救|求助|求求|求大神|怎么办|卡死|闪退|报错|错误|失败|投诉|差评|退款|丢号|被封|盗号|没人回|不理我|不理人|急|等不及|好急|怎么办啊|求回复|在线吗)/;

/**
 * 这条要不要**必回**（即使概率判定说不回）
 *
 * 四种例外（用户列的）：
 *   ① 直接 @我们
 *   ② 长文本（说得多 = 有事要说）
 *   ③ 连续追问（同一个人连着问 ≥2 次）
 *   ④ 情绪激动
 */
export function isStrongSignal(text, { atUs = false, followUps = 0, longThreshold = 40 } = {}) {
  const t = String(text || '');
  if (atUs) return true;
  if (t.replace(/\s+/g, '').length >= longThreshold) return true;
  if (Number(followUps || 0) >= 2) return true;
  if (STRONG_EMOTION_RE.test(t)) return true;
  return false;
}

// ---------- 3. 挑候选：谁在跟我们互动 ----------

/**
 * 挑出「该跟进的互动」候选
 *
 * 命中条件（用户口径：**@你、回复你、喊你**）：
 *   ① 回复了你 —— 这条楼中楼的父评论是我们发的
 *   ② @你 / 喊你 —— isSummonText 命中（签名、别名「大肥鱼/吃白米饭的」、泛称+呼叫语气）
 *
 * 排除：
 *   · 我们自己发的
 *   · 已经回过的那条评论
 *   · 已经走「喊话」通道回过的那条（不重复处理）
 *   · **纯客套**（「哈哈谢谢」这种不用回）
 *
 * @param {Array}  flat          [{ c, parentId }]（collect.mjs 的 flattenAll）
 * @param {object} o
 * @param {Set}    o.ourCommentIds 我们发过的评论 id 集合
 * @param {object} o.prev         state.posts[id]（已回过的评论、计数）
 */
export function pickInteractions(flat, { config = {}, ourCommentIds = new Set(), prev = {} } = {}) {
  const done = new Set((prev?.interactReplied || []).map(String));
  const summoned = new Set((prev?.summonReplied || []).map(String));
  const out = [];

  for (const { c, parentId } of flat || []) {
    const cid = String(c?.id_str || '');
    if (!cid) continue;
    if (done.has(cid)) continue; // 这条已经回过
    if (summoned.has(cid)) continue; // 喊话那条走喊话通道
    const text = commentText(c);
    if (!text) continue;

    const isNested = Boolean(parentId);
    // ① 回复了你：楼中楼的父评论是我们发的
    const repliesUs = isNested && ourCommentIds.has(String(parentId));
    // ② @你 / 喊你
    const hit = isSummonText(text, config);
    if (!repliesUs && !hit.summon) continue;
    // ③ 纯客套不用回
    if (isPureThanks(text)) continue;

    out.push({
      commentId: cid,
      parentId: isNested ? String(parentId) : null,
      level: isNested ? 2 : 1,
      author: c.author?.name || '',
      authorId: String(c.author?.id || ''),
      text,
      // 为什么不回（写进日志，排查用）
      why: repliesUs ? '回复了你' : hit.why === 'role' ? '喊了你' : '点名喊你',
      atUs: hit.summon && hit.why === 'signature',
      time: Number(c.created_time || 0),
    });
  }

  out.sort((a, b) => b.time - a.time);
  return out;
}

// ---------- 4. 降概率（同帖 × 同玩家分别累计） ----------

/** 计数键：优先 user id，没有就用昵称 */
export function playerKey(cand) {
  return String(cand?.authorId || cand?.author || 'unknown');
}

/**
 * 决定这一条要不要回
 *
 * 计数单元 = **同一帖 × 同一玩家**（用户口径「分同一帖内分别累积同一玩家」）：
 *   · 该玩家在这帖被回过 < 3 次 → 直接回
 *   · ≥ 3 次 → 只有 **50%** 概率回（避免跟同一个人无限聊下去）
 *   · 但「情绪强烈」→ 必回（例外优先于概率）
 *
 * @param {object} cand      候选
 * @param {object} o
 * @param {object} o.counts  state.posts[id].interactCounts
 * @param {object} o.config
 * @param {Function} [o.rng]  随机源（测试可注入）
 */
export function decideInteraction(cand, { counts = {}, config = {}, rng = Math.random, followUps = 0 } = {}) {
  const ic = config?.interact || {};
  const limit = Number(ic.samePlayerLimit ?? 3);
  const prob = Number(ic.probabilityAfterLimit ?? 0.5);
  const key = playerKey(cand);
  const n = Number(counts?.[key]?.n || 0);
  const strong = isStrongSignal(cand?.text || '', {
    atUs: Boolean(cand?.atUs),
    followUps,
    longThreshold: Number(ic.strongTextLen ?? 40),
  });

  if (n < limit) {
    return { reply: true, reason: `该玩家在这帖才回过 ${n} 次（< ${limit}）→ 直接回`, probability: 1, strong, key, n };
  }
  if (strong) {
    return {
      reply: true,
      reason: `该玩家在这帖已回 ${n} 次，但情绪强烈/明确点名 → 例外必回`,
      probability: 1,
      strong,
      key,
      n,
    };
  }
  const roll = rng();
  return {
    reply: roll < prob,
    reason: `该玩家在这帖已回 ${n} 次 → 概率 ${Math.round(prob * 100)}%（掷出 ${roll.toFixed(2)}）`,
    probability: prob,
    strong,
    key,
    n,
  };
}

// ---------- 5. 回在哪一层 ----------

/**
 * 回复位置（用户 2026-11-05 原话）：
 *   「如果在主贴上问，直接回复。
 *     如果贴内回复，在此回复的楼中楼下面（同一棵子树）；
 *     如果本身就是楼中楼，同层楼中楼，@目标玩家回复内容。」
 *
 * @returns {{mode:'post'|'nested', parentId:string, mention:string, label:string}}
 */
export function replyTargetFor(cand) {
  const level = Number(cand?.level || 1);
  if (level <= 1) {
    // 贴内回复 → 在**这条回复**下面发楼中楼（同一棵子树）
    return {
      mode: 'nested',
      parentId: String(cand.commentId || ''),
      mention: '',
      label: '该回复的楼中楼',
    };
  }
  // 本身就是楼中楼 → 在**同层**发楼中楼（父级那条一级回复下），并 @ 对方
  return {
    mode: 'nested',
    parentId: String(cand.parentId || ''),
    mention: String(cand.author || ''),
    label: '同层楼中楼（@对方）',
  };
}

/** 计数累加（发送成功后调用） */
export function bumpCount(counts, key, at = new Date().toISOString()) {
  const c = counts && typeof counts === 'object' ? counts : {};
  c[key] = { n: Number(c[key]?.n || 0) + 1, lastAt: at };
  return c;
}
