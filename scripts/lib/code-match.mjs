// 天宫码撮合（2026-11-10 用户要求）
//
// 用户原话：「如果有5分钟内新的发天宫码，把帖子链接发给30分钟内且求天宫码的帖子。
//            并说明，保持签名。」
//
// 边界（很重要，别越界）：
//   · **只转达帖子链接**，不替人担保码能不能用、不承诺「一定有」
//   · **不撮合私下交易**、不索要、不代替任何人允诺互换（`answerPromisesCode` 那套口径不变）
//   · 码是别人发的 → 文案里必须说清楚，让人自己判断
//   · 同一对（求码帖 × 发码帖）只撮合**一次**；每条求码帖对同一个发码帖不重复提醒
//
// 纯函数（不联网、不读写文件），方便回归测试。

import { looksLikeCodeAsk, looksLikeCodeShare } from './code-guard.mjs';

/**
 * 从一批帖子里挑出「该撮合的对」
 *
 * @param {object} o
 * @param {Array} o.items  feed 条目（每条至少 { id, title, text, publishTime }，单位 ms）
 * @param {number} [o.nowMs]
 * @param {number} [o.shareWindowMs] 发码帖的「新鲜度」窗口（默认 5 分钟）
 * @param {number} [o.askWindowMs]   求码帖的「有效期」窗口（默认 30 分钟）
 * @param {Function} [o.isDone] `(askerId, shareId) => boolean` 已经撮合过的对
 * @param {number} [o.maxAskersPerShare] 每条发码帖最多通知几个求码的人（用户 2026-11-10：最多 3 个）
 * @param {number} [o.maxPairs]      单轮最多撮合几对（整体安全阀）
 * @returns {Array<{asker:object, share:object}>}
 */
export function pickCodeMatches({
  items = [],
  nowMs = Date.now(),
  shareWindowMs = 5 * 60 * 1000,
  askWindowMs = 30 * 60 * 1000,
  isDone = () => false,
  maxAskersPerShare = 3,
  maxPairs = 12,
} = {}) {
  const norm = (x) => ({
    id: String(x.id || x.momentId || ''),
    title: String(x.title || ''),
    text: String(x.text || ''),
    publishTime: Number(x.publishTime || 0),
  });

  const all = items.map(norm).filter((x) => x.id && x.publishTime);

  // 发码帖：贴了真码（JFA+7）且**不是在求码**；**新的优先**（用户 2026-11-10：「优先新贴」）
  const shares = all
    .filter((x) => {
      const blob = `${x.title}\n${x.text}`;
      return (
        looksLikeCodeShare(blob) &&
        !looksLikeCodeAsk(blob) &&
        nowMs - x.publishTime <= shareWindowMs
      );
    })
    .sort((a, b) => b.publishTime - a.publishTime);

  // 求码帖：在求码，且还在有效期窗口内
  const asks = all
    .filter((x) => {
      const blob = `${x.title}\n${x.text}`;
      return looksLikeCodeAsk(blob) && nowMs - x.publishTime <= askWindowMs;
    })
    .sort((a, b) => b.publishTime - a.publishTime); // 新贴优先

  const out = [];
  for (const share of shares) {
    // 求码的人按「越新越优先」排序 —— 刚发的求码帖更可能还在等
    const targets = asks.slice().sort((a, b) => b.publishTime - a.publishTime);
    let perShare = 0;
    for (const asker of targets) {
      if (perShare >= maxAskersPerShare) break; // 一条发码帖最多通知 3 个
      if (out.length >= maxPairs) return out;
      if (asker.id === share.id) continue; // 别自己撮合自己
      if (isDone(asker.id, share.id)) continue;
      out.push({ asker, share });
      perShare++;
    }
  }
  return out;
}

/**
 * 撮合文案（**通知性质**，但要有「会话感」——用户 2026-11-10 要求）
 *
 * 用户给的样子：「大肥鱼我，给端来了大佬最新的天宫码：[链接]。领到了去谢谢大佬。」
 *
 * 结构固定为三段（内容不写死，按帖子 id 散列轮换，避免每次一模一样）：
 *   ① 一句会话式开场（带人格：大肥鱼 / 我）
 *   ② 链接
 *   ③ 让他去谢谢发码的大佬（+ 一句自己确认能不能用）
 *
 * 口径不变：**只转达链接**，不担保码有效、不代替任何人交换、不索要。
 * 签名不在这里写 —— 由发送层 `clampReply` 统一追加。
 */
export function buildCodeMatchText({ share, authorName = '' } = {}) {
  const link = `https://www.taptap.cn/moment/${share?.id || ''}`;
  // 用户给的样式（2026-11-10）：
  //   「小鲸鱼趁热赶紧把大佬最新的天宫码给你拿过来了，快去领，记得去谢谢大佬。[链接]。」
  //   要点：人格自称「小鲸鱼」+ 趁热 + 快去领 + 记得谢谢大佬 + **链接放最后**
  const V = [
    `小鲸鱼趁热赶紧把大佬最新的天宫码给你拿过来了，快去领，记得去谢谢大佬。${link}`,
    `趁热！大佬刚发了新的天宫码，小鲸鱼给你端过来了，快去领，领完记得谢谢大佬。${link}`,
    `有佬刚撒了个天宫码，小鲸鱼趁热给你拿来了，手快有手慢无，领到了记得去谢谢大佬。${link}`,
    `大佬最新的天宫码，小鲸鱼趁热给你端来了，快去领，用完回帖谢谢人家一声。${link}`,
  ];
  // 用帖子 id 做散列：同一条发码帖每次说同一句（可复现），不同帖之间换着说。
  // ⚠️ 别用简单的 `h*31+code` 直接取模 —— 帖 id 前缀几乎相同（都是 8693…），
  //    低位区分不开，四个不同 id 会落到同一句（2026-11-10 实测踩到）。
  //    这里把整个 id 摊平后取中位字节，再拌一下低位。
  const sid = String(share?.id || 'x');
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < sid.length; i++) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const pick = ((h >>> 13) ^ (h & 0xff)) % V.length;
  return V[pick];
}