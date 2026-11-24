// 评论（review）账号丢失专项守护 · 离线测试（2026-11-23）
//
// 锁三件事：
//   1) 语义判定：「账号/存档丢失」宽口径要认得出，且**不能误伤**（好友没了、植物没了、掉线…）
//   2) 文案完整性：官方客服口径 1/2/3 三条 + 客服 QQ 必须在，且**保留换行**
//   3) 载荷形态：评价接口是纯文本；分步骤文案压成一行就没法读了
//
//   node scripts/test-review-watch.mjs
import { ACCOUNT_LOST_TEXT, looksLikeAccountLost, shouldReplyReview, isSensitiveReview } from './lib/review-guard.mjs';
import { buildReviewContents, cleanReviewText, normalizeListParams } from './lib/review.mjs';
import { charLen } from './lib/limits.mjs';

let pass = 0;
const fails = [];
const t = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name}${extra ? `  ${extra}` : ''}`));

// ---------- 1. 文案完整性 ----------
console.log('== 文案完整性 ==');
t('非空', ACCOUNT_LOST_TEXT.length > 100);
t('含官方口径开头', ACCOUNT_LOST_TEXT.includes('官方不会删除玩家数据'));
t('含 1、自查是否被安装包拦截', ACCOUNT_LOST_TEXT.includes('1、自查是否被安装包拦截'));
t('含 2、自查是否是同一渠道下载', ACCOUNT_LOST_TEXT.includes('2、自查是否是同一渠道下载'));
t('含 3、卸载重装提示清空存档', ACCOUNT_LOST_TEXT.includes('3、在您卸载重装后'));
t('第 3 条用「且」不是「切」（大哥 2026-11-23 修正笔误）', ACCOUNT_LOST_TEXT.includes('这一步骤是正常的且不会影响'));
t('不再含旧笔误「正常的切」', !ACCOUNT_LOST_TEXT.includes('正常的切'));
t('含客服 QQ 4008932088', ACCOUNT_LOST_TEXT.includes('4008932088'));
t('是多行（不是压成一行）', ACCOUNT_LOST_TEXT.split('\n').length >= 10, String(ACCOUNT_LOST_TEXT.split('\n').length));
t('长度未超平台上限 1000', charLen(ACCOUNT_LOST_TEXT) < 1000, String(charLen(ACCOUNT_LOST_TEXT)));

// ---------- 2. 语义判定：正例（宽口径，必须命中） ----------
console.log('\n== 正例（真实说法，必须命中）==');
const POSITIVE = [
  ['我的号没了，重装之后什么都没有了', '号没了+重装'],
  ['存档丢失了，进度全没了', '字面存档丢失'],
  ['账号丢失了怎么办', '字面账号丢失'],
  ['更新完游戏进去变成新号了，原来的号不见了', '更新后号不见'],
  ['换手机之后数据全没了', '换机+数据没'],
  ['登录不上，一直提示要重新注册', '登录不上+注册语境'],
  ['我的账号数据消失了', '数据消失'],
  ['回归号没了，白玩三年', '回归号'],
  ['重装游戏后本地存档清零了', '重装+存档清零'],
  ['号被清空了，什么存档都没了', '号被清空+存档'],
  ['我号登不进去，显示要新建账号', '登不进+新建账号'],
  ['这是一个换渠道服之后数据不互通的问题，我的进度全没了', '换渠道+进度没'],
];
for (const [text, why] of POSITIVE) {
  const r = looksLikeAccountLost(text);
  t(`命中：${why}`, r.hit === true, JSON.stringify(text));
}

// ---------- 3. 语义判定：反例（不能误伤） ----------
console.log('\n== 反例（不能误伤）==');
const NEGATIVE = [
  ['这游戏真好玩，画面不错', '纯好评'],
  ['好友都没了，怎么加回来', '好友≠账号'],
  ['植物碎片没了，活动送的忘记领', '植物碎片'],
  ['钻石全没了，抽卡太坑', '钻石'],
  ['礼包码没了，去哪里领', '礼包码'],
  ['老是闪退，掉线严重', '闪退掉线'],
  ['我的号被盗了，怎么报警', '盗号（走人工/客服，不是数据丢失）'],
  ['关卡打不过，卡在第三关', '卡关'],
  ['为什么我的好友列表空了', '好友列表'],
  ['新版本植物太强了，平衡性差', '平衡性吐槽'],
  // 🚨 真实误判（2026-11-23 上线首日抓到）：5 星攻略长文
  //    「基本一口就没了」指植物被打死；「按你的账号登录」讲的是怎么登号 —— 两句各自缺一半条件。
  //    改「同句共现」之前，这条被判成账号丢失，差点在好评攻略下回一段找回指引。
  [
    '我记得我很小的时候就玩过这款游戏，现在没想到还在，出了好多新世界和新植物～\n我还是建议大家先去玩难度较小的关卡，难度大的关卡的困难模式都是4阶，我基本都是用坚果和 岩浆番石榴 通关的，至于传送带的嘛…根本打不过…都是一阶，基本一口就没了:-O\n⚠️注意事项\n如果哪天你突然闪退进不去，说明你的游戏文件被删了（可能是你不小心删内存删了），要卸载重新下载，下载完之后要按你的账号登录，然后取的名字要和你之',
    '真实 5 星攻略长文（账号/没了 分属两句）',
  ],
];
for (const [text, why] of NEGATIVE) {
  const r = looksLikeAccountLost(text);
  t(`不命中：${why}`, r.hit === false, `${JSON.stringify(text).slice(0, 40)}… → ${JSON.stringify(r)}`);
}

// ---------- 4. shouldReplyReview（星级闸） ----------
console.log('\n== shouldReplyReview ==');
const mkReview = (o = {}) => ({ reviewId: 'r1', score: 1, text: '我的号没了', ...o });
t('命中且不在跳过名单 → 回', shouldReplyReview(mkReview()).reply === true);
t('缺 reviewId → 不回', shouldReplyReview({ score: 1, text: '我的号没了' }).reply === false);
t('语义不命中 → 不回', shouldReplyReview(mkReview({ text: '画面不错' })).reply === false);
t('星级在 skipScores → 不回', shouldReplyReview(mkReview(), { skipScores: [1] }).reply === false);
t('星级不在 skipScores → 回', shouldReplyReview(mkReview({ score: 2 }), { skipScores: [1] }).reply === true);
t('好评但账号丢失也照样回（账号问题不分星级）', shouldReplyReview(mkReview({ score: 5 })).reply === true);

// ---------- 4b. 敏感拦截（踩到就转人工，绝不自动表态） ----------
//   现场教训：首次 dry-run 就把「账号充值了1000余元…」判成了账号丢失，
//   差点自动回一段「官方不会删数据，请自查」—— 充值/退款纠纷自动回等于替官方表态。
console.log('\n== 敏感拦截 ==');
const SENSITIVE = [
  ['我的账号充值了1000余元，现在号没了', '充值'],
  ['号没了要求退款，不退就投诉', '退款+投诉'],
  ['账号被封号了，存档也没了', '封号'],
  ['我的号被盗了，能帮我找回吗', '盗号'],
  ['未成年充值能退吗，账号数据也丢了', '未成年+充值'],
  ['再不解决我就去12315举报', '12315'],
];
for (const [text, why] of SENSITIVE) {
  const r = shouldReplyReview(mkReview({ text }));
  t(`敏感不回：${why}`, r.reply === false && String(r.why).startsWith('sensitive'), JSON.stringify(r));
}
t('敏感判定可直接调用', isSensitiveReview('要求退款').sensitive === true);
t('普通账号丢失不算敏感', isSensitiveReview('我的号没了').sensitive === false);

// ---------- 4c. HTML 残留清洗 ----------
//   实测部分评价 raw_text 带 <br />，不清洗会污染判定与显示
console.log('\n== HTML 清洗 ==');
t('br 转成换行', cleanReviewText('第一行<br />第二行').includes('\n'));
t('br 变体都认', cleanReviewText('a<br>b<br/>c').split('\n').length === 3, JSON.stringify(cleanReviewText('a<br>b<br/>c')));
t('其它标签被剥掉', !cleanReviewText('<p>正文</p>').includes('<'));
t('实体被解码', cleanReviewText('a&nbsp;b&amp;c').includes('&c'));
t('纯文本不动', cleanReviewText('这游戏挺好玩的') === '这游戏挺好玩的');
// 含 br 的账号丢失句仍要判得出
t('含 br 的账号丢失仍命中', looksLikeAccountLost(cleanReviewText('我的号<br />没了')).hit === true);

// ---------- 5. 载荷形态：换行必须能保住 ----------
console.log('\n== buildReviewContents ==');
const kept = buildReviewContents(ACCOUNT_LOST_TEXT, { keepNewlines: true });
t('keepNewlines 保留换行', kept.split('\n').length >= 10, String(kept.split('\n').length));
t('keepNewlines 不出现三连空行', !/\n{3,}/.test(kept));
t('keepNewlines 内容不丢字', kept.includes('4008932088') && kept.includes('1、自查'));
const flat = buildReviewContents(ACCOUNT_LOST_TEXT);
t('默认仍压成单行（历史行为不变）', flat.split('\n').length === 1);
t('默认压行后内容仍在', flat.includes('4008932088'));

// 表情标记要剥掉（评价接口只吃纯文本）
const withEmoji = buildReviewContents('测试 [表情_点赞] 正文', { keepNewlines: true });
t('表情标记被剥掉', !withEmoji.includes('[表情_'));

// ---------- 6. 列表分页参数：`from` 才是对的 ----------
//   实测（2026-11-23）：from=0/10/20 各不同；page / offset / page_num 全无效（都返回第一页）。
//   守护靠它「从新到旧」扫历史，参数名写错就只会反复看最新 10 条。
console.log('\n== 列表分页参数 ==');
t('from 被保留', normalizeListParams({ appId: 54031, from: 20 }).from === 20);
t('from 默认 0', normalizeListParams({ appId: 54031 }).from === 0);
t('from 负数归零', normalizeListParams({ appId: 54031, from: -5 }).from === 0);
t('from 非数字归零', normalizeListParams({ appId: 54031, from: 'abc' }).from === 0);
t('limit 超上限被夹到 10', normalizeListParams({ appId: 54031, limit: 99 }).limit === 10);
t('sort 默认 new', normalizeListParams({ appId: 54031 }).sort === 'new');

console.log(fails.length ? `\n✗ ${fails.length} 项失败：\n  ${fails.join('\n  ')}` : `\n全部通过（${pass} 项）`);
process.exit(fails.length ? 1 : 0);