// 平台长度上限（用户 2026-11-02 提供，硬约束）
//
//   TapTap 帖子标题：≤ 30 个字符（汉字 / 字母 / 数字都算 1 个）
//   TapTap 帖子内容：≤ 50000
//   TapTap 回复（含楼中楼）：≤ 1000
//
// 我们的回复平时只有几十字，但有两处会变长，必须兜住：
//   ① 答疑库答案本身很长（社区沉淀的长回答）
//   ② 玩家喊话时要带上下文开场白 + 答案
// 超长直接发会**被平台拒绝**（或者截断成半句话），所以发送前统一裁一次。

export const LIMITS = {
  title: 30,
  moment: 50000,
  reply: 1000, // 楼中楼与一级回复同限
};

/** 按「字符」数长度（汉字/字母/数字各算 1，代理对算 1） */
export function charLen(s) {
  return [...String(s ?? '')].length;
}

/**
 * 把回复裁到平台上限内
 *
 * 策略：
 *   · 没超 → 原样返回
 *   · 超了 → 保留结尾的**签名与表情**（那是身份标识，不能丢），
 *            正文从尾部裁到刚好塞得下
 *   · 裁完如果正文尾巴断在半个词上，去掉最后一个不完整短语（换行/标点处）
 *
 * @param {string} text
 * @param {object} [o]
 * @param {number} [o.max]        上限（默认 LIMITS.reply）
 * @param {string} [o.signature]  签名（要保留在结尾）
 */
export function clampReply(text, { max = LIMITS.reply, signature = '' } = {}) {
  const s = String(text ?? '');
  if (charLen(s) <= max) return s;

  const chars = [...s];
  const sig = String(signature || '').trim();
  // 结尾的表情标记（如果有）一起保住
  const tailMatch = s.match(/(?:\s*\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\])*\s*$/);
  const emojiTail = tailMatch ? tailMatch[0] : '';
  // 签名：原文有就留在结尾；原文没有就**补上**（保证每条回复都带身份标识）
  const keepSig = sig && s.includes(sig) ? sig : sig ? '' : '';
  const tail = `${keepSig}${emojiTail}`;
  const appendedSig = sig && !s.includes(sig) ? sig : '';

  // 预算：正文 + 签名 + 表情 + 签名前的空格，都要算进上限
  const budget = Math.max(1, max - charLen(tail) - charLen(appendedSig) - (appendedSig ? 1 : 0));
  let body = chars.slice(0, budget).join('');
  // 断在半个短语上不好看 → 尽量退到最后一个标点或换行
  if (charLen(s) > budget + charLen(tail)) {
    const cut = Math.max(
      body.lastIndexOf('。'),
      body.lastIndexOf('！'),
      body.lastIndexOf('？'),
      body.lastIndexOf('\n'),
      body.lastIndexOf('，')
    );
    if (cut > budget * 0.6) body = body.slice(0, cut + 1);
  }
  const out = `${body.trim()}${appendedSig ? ` ${appendedSig}` : ''}${tail}`;
  return out.length > max * 2 ? out.slice(0, max * 2) : out;
}

/** 校验（体检/测试用）：返回超限的字段 */
export function checkLimits({ title = '', body = '', reply = '' } = {}) {
  const bad = [];
  if (charLen(title) > LIMITS.title) bad.push({ field: 'title', len: charLen(title), max: LIMITS.title });
  if (charLen(body) > LIMITS.moment) bad.push({ field: 'body', len: charLen(body), max: LIMITS.moment });
  if (charLen(reply) > LIMITS.reply) bad.push({ field: 'reply', len: charLen(reply), max: LIMITS.reply });
  return bad;
}
