#!/usr/bin/env node
// 版主管理任务回归测试（判定规则）
//
// 改 scripts/lib/mod-task.mjs 的关键词/排除词前后各跑一次：
//   node scripts/test-mod-task.mjs
//
// 重点：**宁可漏、不可错** —— 误伤正常帖子比放过几个广告严重得多。

import {
  detectFriendRequest,
  FRIEND_KEYWORDS_STRONG,
  FRIEND_KEYWORDS_WEAK,
  EXCLUDE_KEYWORDS,
  INVITE_CODE_RE,
  DEFAULT_FIXED_REPLY,
  ALL_KEYWORDS,
} from './lib/mod-task.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
  }
};

console.log('\n[A] 命中：现场真实标题');

// 现场最新 10 条里真实存在的标题（2026-10-29 抓的）
const REAL_HITS = [
  '亲，好友位等你哦and5ZM3TJ2K',
  '我的好友码andPBGWL4ND',
  '来加好友and6LCL3S6Q',
  'andEAMVCZ49 9051824640 一起玩吧',
  '好友，互加',
  '好友',
  '加我秒回',
];
for (const t of REAL_HITS) {
  const r = detectFriendRequest({ title: t, text: '' });
  check(`命中：${t}`, r.hit, r.reason);
}

console.log('\n[B] 放过：正常帖子（误伤就是事故）');
const REAL_MISS = [
  '刚入坑',
  '模拟器里活动页面只有这一个活动这对吗？',
  '困难6怎么过啊，机枪还是冰车',
  '求个安卓天宫码',
  '组队缺人，一起玩困难9',
  '官方公告：本期活动奖励一览',
  '这个蓝色瓶子从哪里获得',
  '招募：有没有大佬一起玩（不拉好友）',
];
for (const t of REAL_MISS) {
  const r = detectFriendRequest({ title: t, text: '' });
  check(`放过：${t}`, !r.hit, r.reason);
}

console.log('\n[C] 边界');
check('「一起玩」没邀请码 → 放过', !detectFriendRequest({ title: '一起玩困难9', text: '缺个人' }).hit);
check(
  '「一起玩」+ 邀请码 → 命中',
  detectFriendRequest({ title: 'andEAMVCZ49 一起玩吧', text: '' }).hit
);
check(
  '裸邀请码帖 → 命中',
  detectFriendRequest({ title: '', text: 'and5JSA48WW' }).hit
);
check(
  '正文有正当词就放过',
  !detectFriendRequest({ title: '加好友', text: '官方活动送的，别在意' }).hit
);
check(
  '兑换码不算加好友',
  !detectFriendRequest({ title: '天宫码 JFA6Ds3Jcl', text: '' }).hit
);
check(
  '正文里的加好友也算',
  detectFriendRequest({ title: '随便写个标题', text: '有人一起加好友吗 and5ZM3TJ2K' }).hit
);
check(
  '只命中「好友」也判命中',
  detectFriendRequest({ title: '好友', text: '' }).hit
);
check(
  '标题为空正文也判（强特征）',
  detectFriendRequest({ title: '', text: '加我好友' }).hit
);

console.log('\n[D] 词表与文案');
check('强特征词表非空', FRIEND_KEYWORDS_STRONG.length >= 10);
check('弱特征词表非空', FRIEND_KEYWORDS_WEAK.length >= 3);
check('排除词表非空', EXCLUDE_KEYWORDS.length >= 8);
check('强/弱特征不重叠', !FRIEND_KEYWORDS_STRONG.some((w) => FRIEND_KEYWORDS_WEAK.includes(w)));
check('总词表无重复', new Set(ALL_KEYWORDS).size === ALL_KEYWORDS.length);
check('固定文案含集中贴链接', /https:\/\/www\.taptap\.cn\/moment\/864806259805654695/.test(DEFAULT_FIXED_REPLY));
check('固定文案提到集中贴', /集中贴/.test(DEFAULT_FIXED_REPLY));
check('固定文案单行', !DEFAULT_FIXED_REPLY.includes('\n'));
check('邀请码正则能取到码', 'and5ZM3TJ2K'.match(INVITE_CODE_RE)?.[0] === 'and5ZM3TJ2K');
check('邀请码正则不吃普通单词', !('android'.match(INVITE_CODE_RE) || []).length);

console.log(`\n${fail === 0 ? '✓' : '✗'} 测试结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
