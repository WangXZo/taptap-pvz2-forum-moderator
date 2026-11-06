#!/usr/bin/env node
// 平台长度上限 + 码分类 回归测试
//
// 盯两件事：
//   1) 长度上限（用户 2026-11-02 提供的硬约束）：
//      标题 ≤30、帖子内容 ≤50000、回复（含楼中楼）≤1000；裁剪时必须**保住签名和表情**
//   2) 好友码 vs 天宫码**不能混**：
//      好友码 = and/ios + 8 位；天宫码 = JFA + 7 位
//      天宫码被当成好友码 → 贴码分享的好帖会被当广告移除（误伤）

import { LIMITS, charLen, clampReply, checkLimits } from './lib/limits.mjs';
import {
  isFriendCode,
  isTianGongCode,
  looksLikeCodeShare,
  findTianGongCodes,
  answerPromisesCode,
  looksLikeCodeAsk,
} from './lib/code-guard.mjs';
import { findFriendCodes, detectFriendRequest } from './lib/mod-task.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${name}\n    期望 ${b}\n    实际 ${a}`);
};

// ---------- 1. 长度上限 ----------
ok('标题上限 30', LIMITS.title === 30);
ok('帖子内容上限 50000', LIMITS.moment === 50000);
ok('回复上限 1000', LIMITS.reply === 1000);
eq('charLen 按字符算（汉字算 1）', charLen('中文abc'), 5);

const short = '短回复';
ok('不超限 → 原样', clampReply(short) === short);

const sig = '「版主助手-小鲸鱼」';
const long = '啊'.repeat(1200);
const capped = clampReply(long, { signature: sig });
ok('超限 → 被裁到上限内', charLen(capped) <= LIMITS.reply, String(charLen(capped)));
ok('超限 → 签名保住了', capped.includes(sig));

const longWithEmoji = `${'啊'.repeat(1200)} [表情_点赞]`;
const capped2 = clampReply(longWithEmoji, { signature: sig });
ok('超限 → 表情保住了', capped2.includes('[表情_点赞]'), capped2.slice(-40));
ok('超限 → 仍在上限内', charLen(capped2) <= LIMITS.reply, String(charLen(capped2)));

ok('标题超限能查出来', checkLimits({ title: 'x'.repeat(31) }).some((x) => x.field === 'title'));
ok('回复超限能查出来', checkLimits({ reply: 'x'.repeat(1001) }).some((x) => x.field === 'reply'));
ok('正常长度不报', checkLimits({ title: '短标题', reply: '短回复' }).length === 0);

// ---------- 2. 码的分类 ----------
ok('好友码 and+8', isFriendCode('andABCDEFGH'));
ok('好友码 ios+8', isFriendCode('iosABCDEFGH'));
ok('好友码大小写都认', isFriendCode('andABCDEFGH'));
ok('好友码长度不对 → 不认', !isFriendCode('andULPT3CQ'));
ok('天宫码 JFA+7', isTianGongCode('JFAABCDEFG'));
ok('天宫码长度不对 → 不认', !isTianGongCode('JFAJ5NS5'));
ok('好友码不是天宫码', !isTianGongCode('andABCDEFGH'));
ok('天宫码不是好友码', !isFriendCode('JFAABCDEFG'));

ok('贴天宫码 → 算分享', looksLikeCodeShare('JFAABCDEFG'));
ok('贴好友码 → 不算天宫分享', !looksLikeCodeShare('andABCDEFGH'));
eq('取天宫码（大小写归一）', findTianGongCodes('jfaabcdefg 与 JFAABCDEFG'), ['JFAABCDEFG']);

// ---------- 3. 好友码识别里不能混进天宫码 ----------
const codes = findFriendCodes('好友码 andABCDEFGH，天宫码 JFAABCDEFG');
ok('好友码被认出', codes.some((c) => c.toUpperCase() === 'ANDABCDEFGH'));
ok('天宫码**没有**被当成好友码', !codes.some((c) => c.toUpperCase().startsWith('JFA')), JSON.stringify(codes));

// 天宫码单独一帖 → 不是加好友帖（不能回集中贴+移除）
const tg = detectFriendRequest({ title: '', text: 'JFAABCDEFG' });
ok('天宫码单独一帖 → 不算加好友意图', !tg.hit, JSON.stringify(tg));

// ---------- 4. 换码承诺护栏 ----------
ok('「我们俩可以换」= 承诺', answerPromisesCode('你是安卓的吗，我们俩可以换').promise);
ok('「我这边有，可以给你」= 承诺', answerPromisesCode('我这边有一个，可以给你').promise);
ok('「帮不上你换」= 不是承诺', !answerPromisesCode('天宫码我这边没有多的，帮不上你换').promise);
ok('「互相换的，我帮不上忙」= 不是承诺', !answerPromisesCode('天宫码是玩家之间互换的，我帮不上忙').promise);
ok('求码能认出', looksLikeCodeAsk('有没有大佬有安卓天宫码'));
ok('不是求码不乱认', !looksLikeCodeAsk('今天天气不错'));

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
