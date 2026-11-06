// 兑换码 / 天宫码 类「承诺互换」护栏
//
// 用户 2026-11-02 的 bug 报告：
//   「如果玩家求天宫码，不要过去自己承诺互换（不要承诺）你不能负责的。可以过去聊聊」
//
// 现场原因：答疑库里有一条社区沉淀的答案——
//   问：有没有大佬有安卓天宫码  答：「你是安卓的吗，我们俩可以换」
// 这条答案被自动匹配后原样发出去，等于**我们以版主身份承诺跟玩家换码**：
//   ① 版主手上通常没有多余的码，答应了兑现不了；
//   ② 「换码」本身是玩家之间的私下交易，我们不该背书；
//   ③ 一旦有人拿这句截图说「版主答应换」，就是纠纷。
//
// 所以：
//   · 答案里出现「互相换码 / 我给你我的码 / 我帮你找码」这类承诺 → **不许自动发**
//   · 但这类帖确实在求人，可以过去**陪聊一句**（不提承诺、不替官方表态）
//
// 判定分两个方向，别搞混：
//   looksLikeCodeAsk(text)   帖子/评论在**求码、换码**（玩家侧行为）
//   answerPromisesCode(text) 我们的**答案**在承诺换/给码（我们侧风险）

/** 玩家在求码 / 想换码 / 发码让人用 */
const CODE_ASK_RE = /(天宫码|兑换码|激活码|礼包码|福利码|互填码|邀请码|and[A-Za-z0-9]{6,12}|[A-Z]{3,6}[A-Za-z0-9]{4,12})/;

/** 明确在「求」：有没有/求/谁有/给我/求换/差一个 */
const ASK_VERB_RE = /(有没有|谁有|求|给个|给一个|借|差一个|缺一个|换一?个|互换|互换码|能换|可以换|换吗|多一个|蹲一个|求一个)/;

/** 我们的答案在**承诺换码/给码**（这是我们兑现不了的） */
const PROMISE_CODE_RE = new RegExp(
  [
    '(我们?俩|咱俩)[^。！？\\n]{0,6}换', // 我们俩可以换 / 咱俩换
    '我(这边|这)?(有|给你|发你|私你)', // 我这边有 / 我发你
    '你(的|把)?[^。！？\\n]{0,6}(发|给)我[^。！？\\n]{0,6}我[^。！？\\n]{0,6}(发|给)你', // 你发我我发你
    '帮你(换|找|要)', // 帮你换
    '(给|送)你(一个|个)?码', // 给你个码
    '我(可以)?(给|送)你', // 我可以给你
  ].join('|')
);

/**
 * 否定 / 免责的说法 —— 命中就不算「承诺」
 *
 * 踩过的坑：「天宫码是玩家之间**互换**的，我帮不上忙」里的「互换」是在**描述事实**，
 * 不是在承诺；单看词会把正经的拒绝话也拦掉（护栏误杀 = 该发的没发）。
 */
const NEGATED_RE = /(帮不上|帮不了|没法|没办法|不能|不方便|给不了|做不到|没有多|没有多余|抱歉|不提供|无法)/;

/** 帖子/评论是不是在求码（玩家侧） */
export function looksLikeCodeAsk(text) {
  const t = String(text || '');
  if (!CODE_ASK_RE.test(t)) return false;
  return ASK_VERB_RE.test(t);
}

/**
 * 我们的**答案**是不是在承诺换码/给码
 * @returns {{promise:boolean, hit?:string}}
 */
export function answerPromisesCode(text) {
  const t = String(text || '');
  const m = t.match(PROMISE_CODE_RE);
  if (!m) return { promise: false };
  // 整句里带了「帮不上/没法/给不了」这类免责说法 → 不是在承诺
  if (NEGATED_RE.test(t)) return { promise: false };
  return { promise: true, hit: m[0] };
}

// ------------------------------------------------------------
// 码的分类（用户 2026-11-02 明确，别弄混）
// ------------------------------------------------------------
//
//   好友码：and 或 ios + **8 位**大写字母或数字   例：andABCDEFGH / iosABCDEFGH
//   天宫码：JFA + **7 位**大写字母或数字          例：JFAABCDEFG
//
//   两者对版主的态度完全不同：
//     好友码 → 加好友语境里出现 = 广告帖（回复+移除）；只是码 = 不确定（只回复）
//     天宫码 → 有人**发**出来 = 无私分享（要去夸）；有人**求** = 不能承诺互换（只陪聊）
//
// ⚠️ 所以「天宫码」绝不能被当成好友码 —— 否则贴码求码的好帖会被当成广告移除。

/** 好友码：and/ios + 8 位（大小写都收，判等时归一化成大写） */
export const FRIEND_CODE_STRICT_RE = /^(?:and|ios)[A-Za-z0-9]{8}$/;
/** 天宫码：JFA + 7 位 */
export const TIAN_GONG_STRICT_RE = /^JFA[A-Za-z0-9]{7}$/;

/** 这串是不是好友码（严格形态） */
export function isFriendCode(token) {
  return FRIEND_CODE_STRICT_RE.test(String(token || '').trim());
}

/** 这串是不是天宫码（严格形态） */
export function isTianGongCode(token) {
  return TIAN_GONG_STRICT_RE.test(String(token || '').trim());
}

/** 归一化成大写（同一串码的大小写写法要能对上） */
export function normalizeCode(token) {
  return String(token || '').trim().toUpperCase();
}

// ------------------------------------------------------------
// 天宫码（JFA…）分享 → 该夸「无私分享」
// ------------------------------------------------------------

/**
 * 天宫码：JFA + 7 位（实测 JFAABCDEFG / JFAABCDEFG / JFAABCDEFG，长度都是 JFA+7）
 *
 * ⚠️ 这份是**带 g** 的（给 matchAll 用）。**不要**直接拿它 .test() ——
 *    带 g 的正则 test() 是有状态的（lastIndex 会残留），第二次调用就会漏判。
 *    要判断用没用，用下面那个不带 g 的。
 */
export const TIAN_GONG_CODE_RE = /\bJFA[A-Za-z0-9]{7}\b/g;
/** 同一套规则，但不带 g —— 供 test() 使用 */
const TIAN_GONG_TEST_RE = /\bJFA[A-Za-z0-9]{7}\b/;

/** 帖子里是不是**贴出了**天宫码（分享行为） */
export function looksLikeCodeShare(text) {
  return TIAN_GONG_TEST_RE.test(String(text || ''));
}

/** 从文本里取出天宫码（去重、大写归一） */
export function findTianGongCodes(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(TIAN_GONG_CODE_RE)) {
    const v = m[0].toUpperCase();
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------
// 有人**发**天宫码 → 夸「无私分享」
// ------------------------------------------------------------
