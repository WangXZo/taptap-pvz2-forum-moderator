// 签名识别：**谁回过这帖** / **谁在喊我们**
//
// 为什么需要单独一个模块（用户 2026-10-29 明确要求）：
//   答疑组是多人协作，同一个签名「版主助手-小鲸鱼」会出现在好几个账号的回复里。
//   → 「这帖回过没有」不能只靠 myUserId 判断，要**按签名识别**，
//     否则两个人各回一遍同一个问题（以前的 `othersReplied` 只看 author.id，识别不出队友）。
//
//   反过来，玩家也会拿签名来喊我们（「小鲸鱼在吗」「@版主助手-小鲸鱼 求助」）——
//   那**不是**我们回过帖。若按「正文含签名 = 已回复」粗判，就会把真求助跳过。
//   用户原话：「注意匹配括号，防止玩家喊你也被忽略」。
//
// 所以判定必须分成互斥的两类：
//   1. isOurReplyText  → 签名在**结尾**，且前面还有实质内容   = 我们自己/队友发的回复
//   2. isSummonText    → 签名在句中/句首，或就是光秃秃一个称呼 = 玩家在喊我们
//
// 归一化（用户要求「带不带「」都能认、带不带 @ 都能认」）：
//   「版主助手-小鲸鱼」 == 版主助手-小鲸鱼 == 【版主助手 小鲸鱼】 == @版主助手-小鲸鱼
//   做法：去掉括号 / @ / 空白 / 各种连字符，只留实字符再比。

import { flattenContents } from './http.mjs';

/** 兜底关键词：签名将来改了，也还能认出自己的东西（这两个词已经在公开仓库里，不涉密） */
export const FALLBACK_TAGS = ['版主助手', '小鲸鱼'];

/** 各种括号 / 引号：一律当作装饰去掉 */
const BRACKET_RE = /[「」『』【】〔〕\[\]<>《》〈〉()（）"'“”‘’]/g;

/** 空白与连字符：一律当作分隔去掉（版主助手-小鲸鱼 == 版主助手 小鲸鱼） */
const SEP_RE = /[\s\-–—_·•~～|/\\]/g;

/** 结尾的表情标记（`[表情_点赞]` / `[TapTap×xxx_yyy]`） */
const TAIL_EMOJI_RE = /(?:\s*\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\])+\s*$/;

/** 结尾标点 */
const TAIL_PUNCT_RE = /[。，、！？!?,.;；:：~～…]+$/;

/** 去掉括号/空白/连字符，用于宽松比对 */
export function squash(s) {
  return String(s || '')
    .replace(BRACKET_RE, '')
    .replace(SEP_RE, '')
    .toLowerCase();
}

/**
 * 从 config 推出「所有可能代表我们」的原始标签（**不做归一化**，供展示/答疑库体检用）
 *
 * 顺序：完整签名 → 去括号内文 → 兜底关键词 → config.summon.aliases（自己的其它马甲）
 * 例：['「版主助手-小鲸鱼」','版主助手-小鲸鱼','版主助手','小鲸鱼','大*鱼']
 */
export function tagsFromConfig(config) {
  const sig = String(config?.reply?.signature || '').trim();
  const inner = sig.replace(BRACKET_RE, '').replace(/\s+/g, ' ').trim();
  const aliases = (config?.summon?.aliases || []).map((x) => String(x || '').trim());
  return [...new Set([sig, inner, ...FALLBACK_TAGS, ...aliases].filter((x) => x && String(x).trim()))];
}

/** 归一化后的标签集合（去重、去空、按长度降序 —— 长标签优先匹配，避免「版主助手」抢了「版主助手-小鲸鱼」） */
export function squashedTags(config) {
  const out = [...new Set(tagsFromConfig(config).map(squash).filter((x) => x.length >= 2))];
  return out.sort((a, b) => b.length - a.length);
}

/**
 * 在文本里找我们自己的标签
 * @returns {{tag:string, index:number}|null}
 */
export function findTag(text, config) {
  const s = squash(text);
  if (!s) return null;
  for (const tag of squashedTags(config)) {
    const i = s.indexOf(tag);
    if (i >= 0) return { tag, index: i };
  }
  return null;
}

/** 「谢谢小鲸鱼」这种：前面只有客套词，说明是玩家在喊，不是我们发的签名 */
const PURE_THANKS_RE =
  /^(谢谢|感谢|多谢|谢了|谢|辛苦了|辛苦|支持|爱了|牛逼|牛|棒|顶|赞|靠|找|问|等|求|拜托|麻烦|呼叫|艾特|at|嘿|喂|哈|在吗|在不在|来了|好的|好)$/;

/**
 * 这段文字**是不是我们（或队友）发出的回复**
 *
 * 两种形态都算：
 *  ① 签名**独占一行**（我们的答疑回复：`答案正文\n\n「版主助手-小鲸鱼」`）
 *  ② 单行且**以签名结尾**，前面还有 ≥4 个实字符、且不是纯客套
 *     （我们的夸奖：`大佬牛逼 「版主助手-小鲸鱼」[表情_点赞]`）
 *
 * 反例（都算玩家在喊我们）：
 *  - `谢谢小鲸鱼` → 纯客套
 *  - `小鲸鱼`     → 光秃秃一个称呼
 *  - `小鲸鱼在吗` → 签名不在结尾
 */
export function isOurReplyText(text, config) {
  const raw = String(text || '');
  const noEmoji = raw.replace(TAIL_EMOJI_RE, '');
  const tags = squashedTags(config);
  if (!tags.length) return false;

  const lines = noEmoji
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // ① 签名**独占一行**（我们的答疑回复：正文\n\n「版主助手-小鲸鱼」）
  if (lines.length >= 2) {
    const last = squash(lines[lines.length - 1]);
    if (tags.includes(last)) {
      const rest = squash(lines.slice(0, -1).join(' '));
      if (rest && !PURE_THANKS_RE.test(rest)) return true;
    }
  }

  // ② 单行且以签名结尾（我们的夸奖：大佬牛逼 「版主助手-小鲸鱼」[表情_点赞]）
  const core = squash(noEmoji).replace(TAIL_PUNCT_RE, '');
  const tag = tags.find((t) => core.endsWith(t));
  if (!tag) return false;
  const rest = core.slice(0, core.length - tag.length);
  if (rest.length < 4) return false;
  if (PURE_THANKS_RE.test(rest)) return false;
  return true;
}

/** 泛称（玩家不一定记得签名，也会直接喊「版主」） */
const ROLE_RE = /(版主|吧主|管理员|管理组|答疑组|答疑员)/;

/** 呼叫语气（泛称必须配上这些才算喊我们，否则只是提到「版主」二字） */
const VOCATIVE_RE =
  /(在吗|在不在|你好|您好|麻烦|请问|问下|问一下|能不能|可以帮|帮忙|帮看|看一下|看下|反馈|呼叫|回复我|理我|留言|求个|求问|求助|大佬|有人吗)/;

/**
 * 这条评论**是不是玩家在喊我们**
 *
 * @param {string} text
 * @param {object} config
 * @param {{allowRoles?:boolean}} [opt] allowRoles=泛称+呼叫语气也算（默认看 config.summon.matchRoles）
 * @returns {{summon:boolean, why?:string, alias?:string}}
 */
export function isSummonText(text, config, opt = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { summon: false };

  const hit = findTag(raw, config);
  if (hit) {
    // 结尾带签名 = 我们自己发的，不是喊话
    if (isOurReplyText(raw, config)) return { summon: false };
    return { summon: true, why: 'signature', alias: hit.tag };
  }

  const allowRoles = opt.allowRoles ?? config?.summon?.matchRoles !== false;
  if (allowRoles) {
    const s = squash(raw);
    if (ROLE_RE.test(s) && (VOCATIVE_RE.test(s) || /[?？]/.test(raw))) {
      return { summon: true, why: 'role' };
    }
  }
  return { summon: false };
}

/** 评论正文（富文本摊平） */
export function commentText(comment) {
  return flattenContents(comment?.contents);
}

/** 团队成员 user_id 集合（我的 + config.teamUserIds 里列的其他成员） */
export function teamUserIdsOf(config) {
  const ids = [config?.myUserId, ...(config?.teamUserIds || [])]
    .map((x) => String(x || '').trim())
    .filter((x) => x && !x.includes('*')); // 脱敏占位不参与匹配
  return [...new Set(ids)];
}

/**
 * 这条评论是不是「我们这边」发的
 *
 * 两道判据（任一命中即算）：
 *   1. 作者在我们/队友的 user_id 名单里 —— 最可靠
 *   2. 正文以签名结尾（isOurReplyText）—— 多人协作时队友的 ID 我们不一定有
 */
export function isOurComment(comment, { config, teamIds = [] } = {}) {
  const uid = String(comment?.author?.id || '');
  if (uid && teamIds.includes(uid)) return true;
  return isOurReplyText(commentText(comment), config);
}
