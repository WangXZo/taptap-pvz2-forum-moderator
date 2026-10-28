#!/usr/bin/env node
// 自动总结（buildQaEntry）+ 有效回答门槛（isUsefulAnswer）回归测试
//
// 改 scripts/lib/summarize.mjs 前后各跑一次：
//   node scripts/test-summarize.mjs

import { buildQaEntry, isUsefulAnswer, isNoise, flattenReplies, extractKeywords } from './lib/summarize.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const mk = (id, author, authorId, text, extra = {}) => ({
  id_str: id,
  author: { name: author, id: authorId, is_moderator: false, badges: [] },
  contents: { json: [{ children: [{ text }] }] },
  created_time: 1700000000,
  ups: 0,
  child_posts: extra.child || [],
  ...extra,
});

console.log('== isUsefulAnswer：有效回答门槛 ==');
const cases = [
  ['打法是先放向日葵再放豌豆，困难6用机枪就能过', true, '完整答案'],
  ['如果不行就找客服', false, '客服引导'],
  ['谢了兄弟下个月找我', false, '私下交换'],
  ['你是不是没有更新？', false, '纯反问'],
  ['不是氪这么多', false, '太短'],
  ['天宫码 JFA6Ds3Jcl', false, '贴兑换码'],
  ['HI，方便关注我一下吗，我这边私信你~', false, '私信引流'],
  ['顶', false, '纯噪音'],
];
for (const [text, expect, why] of cases) {
  const got = isUsefulAnswer({ text });
  check(`${why}：${text.slice(0, 16)}`, got === expect, `期望 ${expect ? '有效' : '无效'}`);
}

console.log('\n== flattenReplies：楼中楼也要摊平 ==');
const flat = flattenReplies([
  mk('1', '楼主', '10', '求助：困难6怎么过', {
    child: [mk('2', '热心人', '20', '困难6用机枪加冰车就行，我40级通关了')],
  }),
]);
check('摊平出 2 条', flat.length === 2, `实际 ${flat.length}`);
check('楼中楼带 parentId', flat[1]?.parentId === '1', JSON.stringify(flat[1]?.parentId));

console.log('\n== buildQaEntry：只沉淀有效答案 ==');
const comments = [
  mk('1', '路人甲', '111', '顶'),
  mk('2', '老玩家A', '222', '打法是先放向日葵再放豌豆，困难6用机枪就能过，40级足够', { ups: 6 }),
  mk('3', '版主B', '333', '官方提示：注意活动结束时间', {
    author: { name: '版主B', id: '333', is_moderator: true, badges: ['答疑智多星'] },
  }),
];
const post = {
  title: '困难6怎么过',
  text: '困难6怎么过',
  url: 'https://www.taptap.cn/moment/123',
};
const entry = buildQaEntry({ post, comments });
check('生成了条目', !!entry, JSON.stringify(entry));
check('主答案是有效回答', entry && /机枪/.test(entry.answer), entry?.answer);
check('带来源链接', entry?.source === post.url);
check('带总结时间', !!entry?.summarivedAt || !!entry?.summarizedAt);
check('关键词不超过 12 个', (entry?.keywords || []).length <= 12, String(entry?.keywords?.length));

const onlyJunk = buildQaEntry({
  post,
  comments: [mk('9', '甲', '901', '如果不行就找客服'), mk('10', '乙', '902', '谢了兄弟下个月找我')],
});
check('全是无效回答 → 不沉淀', onlyJunk === null, JSON.stringify(onlyJunk));

// ============================================================
// 事故回归：我自己的夸奖被当成答案沉淀进库
//
// 真实事故（2026-10-28 排查）：scoreReply 给版主 +4、给答疑徽章 +4，
// 我自己就是版主 —— 我在别人答案下面盖的楼永远得分最高，
// 于是答疑库里出现了：
//   「回忆之旅乱码」→ 答案 = 「依******梦 说得又准又细，省了大家很多摸索 「版主助手-小鲸鱼」」
//   「这地形和这关卡名字」→ 答案 = 「g 说得又准又细，省了大家很多摸索」
//   「私人拖尾」→ 真实答案 + 「补充：谢谢 1******3 耐心解答，正是新手需要的那种答案…」
// ============================================================
console.log('\n== 不能把我自己的评论沉淀成答案 ==');
const SIG = '「版主助手-小鲸鱼」';
const ME = '99999'; // 假 ID：测试用，不指向真实账号
const withMine = [
  mk('1', '楼主', '111', '回忆之旅乱码怎么办'),
  mk('2', '依******梦', '222', '把语言切成英文再切回来，乱码就没了，我这边试过', { ups: 3 }),
  mk(
    '3',
    '枫之****Zo',
    ME,
    `${SIG} 依******梦 说得又准又细，省了大家很多摸索 ${SIG}`,
    { author: { name: '枫之****Zo', id: ME, is_moderator: true, badges: ['答疑智多星'] } }
  ),
];
const mineEntry = buildQaEntry({ post, comments: withMine, myUserId: ME, signature: SIG });
check('排掉我的评论后仍能沉淀', !!mineEntry, JSON.stringify(mineEntry?.answer));
check('答案取的是真玩家的回答', mineEntry && /语言|乱码/.test(mineEntry.answer), mineEntry?.answer);
check('答案里没有我自己的夸奖句', mineEntry && !/说得又准又细/.test(mineEntry.answer), mineEntry?.answer);
check('答案里没有签名', mineEntry && !mineEntry.answer.includes('小鲸鱼'), mineEntry?.answer);

const onlyMine = buildQaEntry({
  post,
  comments: [mk('3', '枫之****Zo', ME, `感谢 1******3 的热心解答，讲得很清楚，帮到不少人 ${SIG}`)],
  myUserId: ME,
  signature: SIG,
});
check('只有我的评论 → 不沉淀', onlyMine === null, JSON.stringify(onlyMine));

// 没传 myUserId 也要靠签名兜住（旧调用点忘了传的情况）
const noUid = buildQaEntry({
  post,
  comments: [
    mk('4', '依******梦', '222', '把语言切成英文再切回来就好了，我试过没问题'),
    mk('3', '路人', '999', `依******梦 说得又准又细，省了大家很多摸索 ${SIG}`),
  ],
  signature: SIG,
});
check('没传 myUserId 也能靠签名挡掉', noUid && !/说得又准又细/.test(noUid.answer), noUid?.answer);

console.log('\n== extractKeywords：滤掉活动编号与兑换码 ==');
const kws = extractKeywords('十月同游1234567890', '十月同游1234567890 JFA6Ds3Jcl');
check('不含纯数字长串', !kws.some((k) => /^\d{6,}$/.test(k)), JSON.stringify(kws));
check('不含字母开头长码', !kws.some((k) => /^[a-zA-Z][a-zA-Z0-9]{5,}$/.test(k)), JSON.stringify(kws));
check('仍保留中文词', kws.some((k) => /[一-龥]/.test(k)), JSON.stringify(kws));

console.log('\n== isNoise：基础噪音过滤 ==');
check('顶 是噪音', isNoise({ text: '顶' }) === true);
check('长答案不是噪音', isNoise({ text: '困难6用机枪加冰车就行，我40级通关了' }) === false);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
