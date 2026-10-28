// 夸奖「已经回答了别人提问」的玩家
//
// 触发条件（由 collect.mjs 决定）：某个提问帖里已有其他玩家给出有效回答
//   → 答案沉淀进答疑库（summarize.mjs）
//   → 同时在**那条评论下面**（楼中楼）夸一句 + 1 个 TapTap 表情
//
// 设计约束：
//  1) 只夸「有效回答」—— 复用 summarize 的噪音过滤与打分，避免夸到「顶/同问/哈哈哈」
//  2) 不夸版主/自己 —— 夸同行没意义，夸自己更奇怪
//  3) 文案短（≤ 20 字）、**口语化**、像玩家自己说话，不要客服腔
//  4) 每条模板都必须带昵称 —— 楼中楼里不点名就不知道在夸谁
//  5) 表情按语境自动挑 1 个，只用标准表情组（跨组点选会插错，见 SKILL 硬约束 7）
//
// 【口吻】**这是给玩家看的，不是给领导看的。**
//   反面例子（第一版，被用户打回）：『感谢 老玩家A 的热心解答，讲得很清楚，帮到不少人』
//   —— 像客服回访，一眼机器人。
//   正面例子（用户给的标杆）：
//     ·「哇~XX大佬，牛逼[表情]」
//     ·「大佬，好肝啊！[表情]」「大佬，肝肝还好吗？」
//     ·「正常，玩到正版了，拓维正常操作。」
//   共同点：短、口语、有语气词（哇~ / 啊 / 了 / 服了）、拿「大佬」称呼对方、允许一点点调侃。
//
// 【不要模板化】**玩家是会把版主所有回复翻一遍的。**
//   4 套模板时，历史上「说得又准又细」被用了 4 次、「感谢…热心解答」被用了 3 次，
//   一翻主页就是规律 → 一眼机器人。
//   所以：① 模板池 ≥ 15 套（现在是 18）；② 最近说过的模板**主动避开**（见 usedTexts）。
//   以后加模板，数量只能往上，别往下。

import { flattenReplies, isNoise, isUsefulAnswer, scoreReply, tidy } from './summarize.mjs';
import { stableHash, liteHash } from './util.mjs';

/**
 * 夸奖文案模板（18 套，全部口语化，全部带 {name}）
 *   {name} → 玩家昵称；{emoji} → [表情_xxx] 标记（发送时点选，不是纯文本）
 *
 * 分四类口味混在一个池子里随机，避免连着几条都是同一种口气：
 *   惊叹型 / 亲切感谢型 / 服气点赞型 / 轻调侃型
 */
export const PRAISE_TEMPLATES = [
  // —— 惊叹型：看到好答案的第一反应 ——
  '哇~{name}大佬，牛逼{emoji}',
  '好家伙，{name}大佬这也懂{emoji}',
  '{name}大佬太顶了{emoji}',
  '牛，{name}大佬一眼就看明白{emoji}',
  '这下{name}大佬把话说透了{emoji}',

  // —— 亲切感谢型：像熟人说话 ——
  '懂了懂了，谢谢{name}大佬{emoji}',
  '有{name}大佬在，新手有救了{emoji}',
  '学到了学到了，{name}大佬靠谱{emoji}',
  '谢谢{name}大佬，讲得真细{emoji}',
  '{name}大佬这两句顶我自己摸索半天{emoji}',
  '还好看{name}大佬的，谢啦{emoji}',

  // —— 服气点赞型：简短有力 ——
  '{name}大佬，稳{emoji}',
  '服了服了，{name}大佬{emoji}',
  '这回答给满分，{name}大佬{emoji}',
  '{name}大佬一句话说清了{emoji}',
  '就冲{name}大佬这句，我先试为敬{emoji}',

  // —— 轻调侃型：熟人之间的那种 ——
  '{name}大佬，肝度有点猛啊{emoji}',
  '这才是老玩家，{name}大佬{emoji}',
];

/**
 * 按语境挑 1 个表情（只用标准组里确定存在的名字，见 references/emojis.md）
 *   长且有具体数字（版本/关卡/血量…）→ 点赞（最贴「夸奖」）
 *   教学/建议口吻                     → 比心
 *   中等长度的说明                     → 星星眼
 *   简短一句                           → 开心
 */
export function pickEmoji(replyText) {
  const t = String(replyText || '');
  if (t.length >= 15 && /\d/.test(t)) return '点赞';
  if (t.length >= 8 && /(先|然后|建议|注意|推荐|不要|别急|优先|最好|可以)/.test(t)) return '比心';
  if (t.length >= 15) return '星星眼';
  return '开心';
}

/** 把模板拆成固定片段：'哇~{name}大佬，牛逼{emoji}' → ['哇~','大佬，牛逼'] */
function templateFragments(tpl) {
  return String(tpl)
    .replace('{name}', '\u0000')
    .replace('{emoji}', '\u0000')
    .split('\u0000')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 这条模板是不是「最近刚说过」—— 用固定片段去比对已发文本
 * （已发文本里必带昵称，而片段里不含昵称，所以能匹配上）
 */
function recentlyUsed(tpl, recentTexts) {
  const frags = templateFragments(tpl);
  if (!frags.length) return false;
  // 只用长度 ≥2 的片段做判据，避免「，」这种过短的误匹配
  const solid = frags.filter((f) => f.length >= 2);
  if (!solid.length) return false;
  return recentTexts.some((t) => {
    const s = String(t);
    return solid.some((f) => s.includes(f));
  });
}

/**
 * 组一条夸奖文案
 *
 * 选模板的优先级：
 *   1. 散列起点 = 昵称 + 答案开头（同一条回答永远从同一处起算，重试不会跳）
 *   2. 从起点往回扫，**跳过最近说过的那几种口气**
 *   3. 再跳过已经一字不差发过的
 *   4. 实在都撞上了才复用（并标记 duplicated —— 重复一次远比不说话好）
 *
 * @param {object} o
 * @param {string} o.author       被夸玩家昵称
 * @param {string} o.replyText    被夸的那条回答（用于挑表情 + 散列）
 * @param {string} [o.signature]  签名（同一行，排在表情前）
 * @param {string[]} [o.usedTexts] 已发过的文本，用来避开重复口气
 * @returns {{text:string, emoji:string, template:string, duplicated:boolean}}
 */
export function composePraise({ author, replyText, signature = '', usedTexts = [] }) {
  const name = String(author || '').trim() || '这位朋友';
  const emojiName = pickEmoji(replyText);
  const emoji = `[表情_${emojiName}]`;
  const seed = stableHash(`${name}|${String(replyText || '').slice(0, 24)}`);
  const recent = (usedTexts || []).filter(Boolean).map(String);
  const used = new Set(recent.map((t) => liteHash(t)));

  const render = (tpl) =>
    `${tpl.replace('{name}', name).replace('{emoji}', '')}${signature ? ` ${signature}` : ''}${emoji}`;

  const order = [];
  for (let i = 0; i < PRAISE_TEMPLATES.length; i++) {
    order.push(PRAISE_TEMPLATES[(seed + i) % PRAISE_TEMPLATES.length]);
  }
  // 最近说过口气的排到最后
  const fresh = order.filter((tpl) => !recentlyUsed(tpl, recent));
  const stale = order.filter((tpl) => recentlyUsed(tpl, recent));
  const ordered = [...fresh, ...stale];

  for (const tpl of ordered) {
    const text = render(tpl);
    if (!used.has(liteHash(text))) {
      return { text, emoji: emojiName, template: tpl, duplicated: false };
    }
  }
  const tpl = ordered[0] || PRAISE_TEMPLATES[0];
  return { text: render(tpl), emoji: emojiName, template: tpl, duplicated: true };
}

/**
 * 从评论树里挑出「最值得夸的那条回答」
 * @param {Array} comments 接口返回的一级评论列表（含 child_posts）
 * @param {{myUserId?:string, minScore?:number}} opts
 * @returns {null | {targetCommentId:string, author:string, authorId:string, text:string, score:number, isNested:boolean}}
 */
export function pickPraiseTarget(comments, { myUserId = '', minScore = 1 } = {}) {
  const uid = String(myUserId || '__none__');
  const list = flattenReplies(comments).filter((r) => r.authorId && r.authorId !== uid);
  if (!list.length) return null;

  const candidates = list
    .filter((r) => !isNoise(r))
    .filter((r) => isUsefulAnswer(r)) // 客服引导/私下交换/纯反问/碎片一律不夸
    .filter((r) => !r.isModerator) // 不夸版主（含自己所在答疑组）
    .map((r) => ({ ...r, score: scoreReply(r), clean: tidy(r.text) }))
    .filter((r) => r.clean.length >= 6)
    .sort((a, b) => b.score - a.score || b.time - a.time);

  const best = candidates[0];
  if (!best || best.score < minScore) return null;

  return {
    // 楼中楼要挂在它所属的一级评论下（浏览器里可点的回复框只在一级评论上）
    targetCommentId: String(best.parentId || best.id),
    author: best.author,
    authorId: best.authorId,
    text: best.clean,
    score: best.score,
    isNested: !!best.parentId,
    isRootAnswer: String(best.parentId || best.id) === String(best.id),
  };
}
