#!/usr/bin/env node
// 版主管理任务回归测试（判定规则）
//
// 改 scripts/lib/mod-task.mjs 的意图/排除规则前后各跑一次：
//   node scripts/test-mod-task.mjs
//
// ⚠️ 用例全部来自**现场真实标题**（2026-10-29 抓的两个子版块 60+ 条）。
//    误伤一张正常帖比放过几个广告严重得多 —— 所以负例比正例还多。

import {
  detectFriendRequest,
  checkAuthor,
  INTENT_PATTERNS,
  EXCLUDE_PATTERNS,
  FRIEND_ONLY_TITLE_RE,
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

console.log('\n[A] 命中：明确在加好友（现场真实标题）');
const REAL_HITS = [
  '亲，好友位等你哦and5ZM3TJ2K',
  '我的好友码andPBGWL4ND',
  '来加好友and6LCL3S6Q',
  '加好友啦',
  '加好友，送体力喔',
  '加好友兄弟们',
  '加好友的来',
  '扩列互赞 andX6SCFRV8',
  '好友，互加',
  '快来加好友 andFTDH7FYW[表情_大笑]',
  '有人加不，每日上线 and5NGRCHN4',
  '有没有好友互赞的呀',
  '好友码集中贴',
  '加个好友',
  '求好友',
  '互加好友',
];
for (const t of REAL_HITS) {
  const r = detectFriendRequest({ title: t, text: '' });
  check(`命中：${t}`, r.hit, r.reason);
}

console.log('\n[B] 放过：活动组队 / 活动邀请码 / 游戏功能（用户明确要求不算）');
const REAL_MISS = [
  // 活动组队（游戏内新增好友功能）
  '十月同游',
  '十月同游 组小队',
  '十月同游 好友码：8051671587',
  '组队 有人一起组队吗',
  '来进队吗 一起玩',
  '一起做任务 5165468967',
  '一起玩 一起玩',
  '做任务 有一起的吗',
  '好友邀请 大家一起玩！还没有满员！！',
  // 活动邀请码互填
  '跪求大佬们填一下邀请码 EDRYKGZEK 求求了',
  '新人邀请码。求互帮。 QXUBEYELD 这是我的邀请码。需要填邀请码的发我的评论区。',
  '7820781763 邀请码 要加入吗',
  '互帮 各位义父！帮帮我吧！',
  // 游戏功能里的「好友」
  '感觉好友宝箱的奖池缺少"大货"',
  '好友系统什么时候更新',
  // 正常提问
  '刚入坑',
  '困难6怎么过啊，机枪还是冰车',
  '模拟器里活动页面只有这一个活动这对吗？',
  '更新问题 TapTap怎么更新，华为渠道过来的',
  '？ 怎么解决啊',
  '。额啊无尽打的我头晕目眩救救我啊',
];
for (const t of REAL_MISS) {
  const r = detectFriendRequest({ title: t, text: '' });
  check(`放过：${t}`, !r.hit, r.reason);
}

console.log('\n[C] 边界');
check('标题只有「好友」→ 命中', detectFriendRequest({ title: '好友', text: '' }).hit);
check(
  '正文里的加好友也算',
  detectFriendRequest({ title: '随便写个标题', text: '有人加我好友吗 and5ZM3TJ2K' }).hit
);
check(
  '裸好友码帖 → 命中',
  detectFriendRequest({ title: '', text: 'and5JSA48WW' }).hit
);
check(
  '裸码帖可配置为不命中',
  !detectFriendRequest({ title: '', text: 'and5JSA48WW', bareCodeIsIntent: false }).hit
);
check(
  '带别字的裸码（只有活动码）→ 放过',
  !detectFriendRequest({ title: '', text: '十月同游1030184654 一起来玩呀！' }).hit
);
check(
  '排除优先于意图',
  !detectFriendRequest({ title: '加好友', text: '顺便求填一下活动邀请码' }).hit
);
check(
  '好友宝箱不算意图',
  !detectFriendRequest({ title: '好友宝箱好肝', text: '' }).hit
);

console.log('\n[D] 官方/版主的帖一律跳过（用户 2026-10-29 明确要求）');

const mkMoment = (o = {}) => ({ author: { user: { id: 1, name: '玩家', is_moderator: false, moderator_type: 0, ...o } } });

check(
  '官方版主（is_moderator）→ 跳过',
  checkAuthor(mkMoment({ name: '拓维游戏', is_moderator: true })).official
);
check(
  'moderator_type>0 → 跳过',
  checkAuthor(mkMoment({ name: '官方小助手', moderator_type: 2 })).official
);
check('自己发的帖 → 跳过', checkAuthor(mkMoment({ id: 999, name: '我自己' }), { myUserId: '999' }).official);
check('普通玩家 → 不跳过', !checkAuthor(mkMoment({ name: '路人甲' })).official);
check(
  '名字带官方字样 → 跳过（兜底）',
  checkAuthor(mkMoment({ name: '植物大战僵尸官方' })).official
);
// 现场真实数据：集中贴是官方发的，标题里就有「好友码」→ 必须挡住
check(
  '集中贴（官方发的、标题带好友码）→ 跳过',
  checkAuthor(mkMoment({ name: '拓维游戏', is_moderator: true })).official &&
    detectFriendRequest({ title: '【好友码集中楼】找邻居都来这栋楼！', text: '把你的好友码发在这里' }).hit
);

console.log('\n[E] 规则表与文案');
check('意图模式非空', INTENT_PATTERNS.length >= 10);
check('排除模式非空', EXCLUDE_PATTERNS.length >= 4);
check('意图模式不含裸「好友」', !INTENT_PATTERNS.some((re) => re.source === '好友'));
check('排除模式含活动组队', EXCLUDE_PATTERNS.some((re) => /组队/.test(re.source)));
check('排除模式含活动邀请码', EXCLUDE_PATTERNS.some((re) => /邀请码/.test(re.source)));
check('排除模式含好友功能词', EXCLUDE_PATTERNS.some((re) => /宝箱/.test(re.source)));
check('标题整体词表非空', FRIEND_ONLY_TITLE_RE.source.length > 0);
check('固定文案含集中贴链接', /https:\/\/www\.taptap\.cn\/moment\/864806259805654695/.test(DEFAULT_FIXED_REPLY));
check('固定文案提到集中贴', /集中贴/.test(DEFAULT_FIXED_REPLY));
check('固定文案单行', !DEFAULT_FIXED_REPLY.includes('\n'));
check('邀请码正则能取到码', 'and5ZM3TJ2K'.match(INVITE_CODE_RE)?.[0] === 'and5ZM3TJ2K');
check('邀请码正则不吃普通单词', !('android'.match(INVITE_CODE_RE) || []).length);
check('关键词全表非空', ALL_KEYWORDS.length > 0);

console.log(`\n${fail === 0 ? '✓' : '✗'} 测试结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
