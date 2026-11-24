// 评论（游戏评价 review）· 「账号丢失 / 存档丢失」专项回复
//
// 大哥 2026-11-23 要求：
//   「当发现评论"账号丢失/存档丢失"语义时，回复下列内容」
//   语义范围：**宽口径**（含等价说法）—— 见 looksLikeAccountLost
//   节奏：每轮只回一条、从新到旧、不设时间窗口、按队列持续消化、不设总量上限
//   签名：带（由 reviewReply 的 clampReply 统一追加）
//
// ⚠️ 这是**评价**通道，跟论坛帖子完全不是一条链路：
//   · 论坛：富文本节点数组（[{type:'paragraph'}]），可带 tap_emoji，有楼中楼
//   · 评价：contents **纯文本**，无表情节点，只有一层回复（实测 by-review 无 child_posts）
//
// 文案来源：官方客服口径，大哥 2026-11-23 提供。客服 QQ 是公开号码，无需脱敏。

/**
 * 「账号 / 存档丢失」标准回复（**官方客服口径，原样使用**）
 *
 * ⚠️ 改文案前先想清楚：这段话是要让玩家**照着一步步自查**的，
 *    1/2/3 三条的顺序有讲究（先排安装包拦截 → 再排渠道不互通 → 最后解释重装清存档是正常的）。
 *    压缩成一行会完全没法读，所以发送时**必须保留换行**（见 buildReviewContents 的 keepNewlines）。
 */
export const ACCOUNT_LOST_TEXT = [
  '亲爱的小僵僵，植物大战僵尸2官方不会删除玩家数据哦，我非常理解你，请按照我提出的可能性一步一步自查，来协助您找回账号',
  '',
  '1、自查是否被安装包拦截',
  '启动游戏后，登陆方式有TapTap登陆/手机号登陆，可以尝试点注册账号看一看，如果有例如小米账号登陆/华为账号登陆，说明您的安装包被拦截了',
  '',
  '2、自查是否是同一渠道下载',
  '请注意，TapTap与官网都可以使用手机账号登陆，但是数据不互通，如果您是官网下载游玩，通过TapTap更新并且覆盖安装，看起来就会像是"数据消失一样"，您需要卸载包体，从原渠道重新下载',
  '',
  '3、在您卸载重装后，登陆会提示您，需要清空您的本地帐号存档以完成登录，这一步骤是正常的且不会影响到您的账号，请不要担心点击确认。',
  '',
  '如还是没能找回您的帐号，可以添加客服QQ：4008932088尝试解决',
].join('\n');

// ─────────────────────────────────────────────────────────────
// 语义识别（宽口径）
// ─────────────────────────────────────────────────────────────
//
// 设计原则：评价是「打分 + 短文本」，大量是**陈述句**，不能用疑问词判断。
//   所以按「丢的是什么」×「怎么丢的」两维组合判定，而不是关键词单点命中。

/**
 * 被丢失的对象：账号 / 存档 / 数据 / 进度
 *
 * ⚠️ 中文里不能用 `号\b` 做边界 —— JS 的 `\b` 只认 `\w`（ASCII 字母数字下划线），
 *    汉字属于 `\W`，「号」后面紧跟汉字时**没有边界**，于是「我的号没了」会被漏判（实测踩到）。
 *    所以「号」这类口语说法单独用一组特征词收，不依赖边界。
 */
const OBJECT_WORD_RE = /(账号|帐号|账户|帐户|存档|档案|游戏数据|本地数据|云存档|进度)/;

/** 口语里的「号」（没写「账号」两个字，但就是指账号） */
const OBJECT_SLANG_RE =
  /(小号|大号|老号|回归号|我的号|我号|原来的号|旧号|这个号|那个号|号没|号丢|号不见|号被清|号被删|号归零|进不去号|上不去号|变成新号|是个新号|新建账号|重新注册|注册新号|重新开始玩)/;

/** 「丢了」的动词 / 状态 */
const LOST_RE =
  /(丢失|丢了|没了|都不见了|不见了|消失|清空|清零|被删|被清|清除|找回|找不回|恢复不了|全没|丢号|号没|没了啊|不翼而飞|归零|白玩|白肝)/;

/** 登录不上（等价说法：号还在但进不去） */
const LOGIN_FAIL_RE =
  /(登不上|登不进|登录不上|登录不了|登陆不上|登陆不了|无法登录|无法登陆|登不上去|进不去号|上不去号|登录失败|登陆失败|一直提示登录)/;

/** 换机 / 重装 / 更新 场景（数据「看起来消失」的高发场景） */
const SCENE_RE = /(换手机|换机|换设备|新手机|重装|卸载|覆盖安装|更新后|更新完|重新下载|回到旧包体|换渠道|渠道服)/;

/** 明确不是「账号丢失」的对象（防止「好友没了」这类误报） */
const NOT_ACCOUNT_RE = /(好友|码|礼包|活动|关卡|植物|钻石|金币|卡池|抽卡|掉线|闪退|卡顿|延迟)/;

/**
 * 🚫 **敏感区：一律不自动回**（大哥长期约束 + 方案文档口径）
 *
 * 现场教训（2026-11-23 首次实测就撞上）：
 *   评价 51231162「我的账号充值了1000余元…当时我的taptap处于登出状态…」被判成了
 *   「账号丢失」→ 差点自动回一段「官方不会删除数据，请自查」。
 *   这类是**充值/退款纠纷**，自动回等于替官方表态，风险极高。
 *
 * 所以：涉及钱、封号、投诉、盗号、实名、未成年、法律途径的，**一律转人工**，不自动回复。
 */
const SENSITIVE_RE =
  /(充值|退款|退钱|退费|氪金|付费|付款|扣费|扣钱|订单|发票|消费|12315|消协|工商|起诉|律师|法律|投诉|举报|曝光|媒体|封号|封禁|冻结|实名|未成年|防沉迷|盗号|被盗|买号|卖号|代练|交易|私下换|纠纷|赔偿|补偿我)/;

/** 评价里是否踩到敏感区（踩到就不自动回，转人工） */
export function isSensitiveReview(text) {
  const t = String(text || '');
  const m = t.match(SENSITIVE_RE);
  return m ? { sensitive: true, hit: m[0] } : { sensitive: false };
}

/**
 * 这段评价是不是在说「账号 / 存档 / 数据丢了」
 *
 * 宽口径（大哥 2026-11-23 选定）：除字面「账号丢失/存档丢失」外，还认
 *   · 号没了 / 号不见了 / 数据没了 / 进度没了 / 存档清零
 *   · 登不上 / 登录不上（且上下文提到账号或换机/重装）
 *   · 换手机、重装、更新后 + 数据消失
 *
 * @param {string} text 评价正文
 * @returns {{hit:boolean, why?:string}}
 */
export function looksLikeAccountLost(text) {
  const t = String(text || '').trim();
  if (!t) return { hit: false };

  // ① 「好友/礼包/植物…」丢了的，不是账号丢失
  const hasAccountObject = OBJECT_WORD_RE.test(t) || OBJECT_SLANG_RE.test(t);
  const onlyOtherObject = NOT_ACCOUNT_RE.test(t) && !/(账号|帐号|存档|游戏数据|云存档|我的号|号没)/.test(t);

  // ② 对象 + 丢失动词 —— **必须同一句内共现**（2026-11-23 修）
  //   实测误判：《我记得我很小的时候就玩过…》（5 星攻略长文）
  //     「…都是一阶，基本一口就**没了**」（指植物被打死）
  //     「…下载完之后要按你的**账号**登录」（讲怎么登号）
  //   全文共现 → 判成账号丢失，差点在好评攻略下回一段找回指引。
  //   按句切开后两句各自缺一半条件 → 不再误命中；而「我的号没了」这类仍在同一句，照常命中。
  for (const sent of splitSentences(t)) {
    if (!sent) continue;
    const obj = OBJECT_WORD_RE.test(sent) || OBJECT_SLANG_RE.test(sent);
    if (obj && LOST_RE.test(sent)) {
      if (onlyOtherObject) return { hit: false };
      return { hit: true, why: '账号/存档 + 丢失动词（同句）' };
    }
  }

  // ③ 登录不上 + （账号语境 或 换机/重装场景）
  //   这一条保持**全文**判定：登录不上本身就是强信号，且文案第 2/3 条讲的正是登录/渠道问题。
  if (LOGIN_FAIL_RE.test(t) && (hasAccountObject || SCENE_RE.test(t))) {
    return { hit: true, why: '登录不上 + 账号/换机语境' };
  }

  // ④ 换机/重装/更新 + 丢失动词（同样要求同句共现）
  for (const sent of splitSentences(t)) {
    if (!sent) continue;
    if (SCENE_RE.test(sent) && LOST_RE.test(sent)) {
      if (onlyOtherObject) return { hit: false };
      return { hit: true, why: '换机/重装 + 丢失动词（同句）' };
    }
  }

  return { hit: false };
}

/**
 * 按句末/停顿标点切句
 *
 * ⚠️ **不按 `\n` 切**：评价里的换行多半是排版（`<br />` 清洗后也变成 `\n`），
 *    并不代表句子结束 —— 「我的号<br />没了」是一句话，按 `\n` 切会把条件拆散导致漏判。
 *    真正切句的是句末标点与逗号。
 */
function splitSentences(t) {
  return String(t || '')
    .split(/[。！？!?；;，,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判定是否该回这条评价
 *
 * @param {object} review normalizeReview 的产物
 * @param {object} [opt]
 * @param {number[]} [opt.skipScores] 这些星级的评价不回（默认空：账号问题不分星级）
 * @returns {{reply:boolean, why:string}}
 */
export function shouldReplyReview(review, { skipScores = [] } = {}) {
  if (!review || !review.reviewId) return { reply: false, why: 'incomplete' };
  const score = Number(review.score);
  if (skipScores.includes(score)) return { reply: false, why: `星级 ${score} 在跳过名单` };

  // 🚫 敏感区先行拦截：充值/退款/封号/投诉/盗号…一律转人工，不自动表态
  const sens = isSensitiveReview(review.text);
  if (sens.sensitive) return { reply: false, why: `sensitive:${sens.hit}` };

  const hit = looksLikeAccountLost(review.text);
  if (!hit.hit) return { reply: false, why: 'not_account_lost' };
  return { reply: true, why: hit.why };
}