#!/usr/bin/env node
// 回复文案变体 + 泄露自检 回归测试
//
// 改 scripts/lib/variants.mjs 前后各跑一次：
//   node scripts/test-variants.mjs

import {
  buildReplyText,
  assertNoLeak,
    buildRefusalText,
  buildShareText,
  shareMood,
  POOL_SIZES,
} from './lib/variants.mjs';
import { liteHash } from './lib/util.mjs';
import { looksLikeShare } from './lib/qa.mjs';

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

const ANSWER = '钻石主要靠每天签到、植物探险、碎片挑战这些稳定来源，先把免费资源领满。';
const SIG = '「版主助手-小鲸鱼」';

console.log('== 事实来源不被改写 ==');
const v = buildReplyText({ answer: ANSWER, postId: '123', usedTexts: [], signature: SIG });
check('答案原文完整保留', v.text.includes(ANSWER), v.text);
check('带签名', v.text.includes(SIG));
check('签名在最后', v.text.trim().endsWith(SIG));
check('正文只有一份答案', v.text.split(ANSWER).length === 2);

console.log('\n== 同一答案多次回复不重样 ==');
const used = [];
const texts = [];
for (let i = 0; i < 6; i++) {
  const r = buildReplyText({ answer: ANSWER, postId: 'post' + i, usedTexts: used, signature: SIG });
  texts.push(r.text);
  used.push(r.text);
}
check('6 次各不相同', new Set(texts).size === 6, `${new Set(texts).size}/6`);
check('6 次都保留同一份答案', texts.every((t) => t.includes(ANSWER)));

const same = buildReplyText({ answer: ANSWER, postId: 'x', usedTexts: [ANSWER], signature: SIG });
check('命中已用文本 → 换一种说法', same.text !== ANSWER && same.text.includes(ANSWER), same.text);

// 把所有变体都消耗掉（不加分隔符），再用满 → 应标记 duplicated
const exhaust = [];
for (let i = 0; i < 20; i++) {
  const r = buildReplyText({ answer: ANSWER, postId: 'x', usedTexts: exhaust, signature: SIG, allowCloser: false });
  if (exhaust.includes(r.text)) break;
  exhaust.push(r.text);
}
const dup = buildReplyText({ answer: ANSWER, postId: 'x', usedTexts: exhaust, signature: SIG, allowCloser: false });
check('所有变体都用过 → 标记 duplicated', dup.duplicated === true, `${exhaust.length} 个变体, duplicated=${dup.duplicated}`);

console.log('\n== 泄露自检 ==');
const leaks = [
  '这个答案在答疑库里有记录',
  '你可以看看 state.json 里的配置',
  '路径是 scripts/collect.mjs',
  '这是 AI 机器人自动回复的',
  '接口被 WAF 限流了先等等',
  '你的 api key 记得保管好',
];
for (const t of leaks) {
  check(`拦下：${t}`, assertNoLeak(t).ok === false, JSON.stringify(assertNoLeak(t)));
}
const okTexts = [
  ANSWER,
  '无尽模式建议用机枪加南瓜头，血量扛得住就行',
  '这个月活动送的东西比上个多，值得换',
  '楼中楼回复会带一个表情，编辑器不认纯文字标识',
];
for (const t of okTexts) {
  check(`放行：${t.slice(0, 12)}…`, assertNoLeak(t).ok === true, JSON.stringify(assertNoLeak(t)));
}

console.log('\n== hash 与婉拒 ==');
check('hash 稳定', liteHash('abc') === liteHash('abc'));
check('hash 区分不同文本', liteHash('abc') !== liteHash('abd'));
const r1 = buildRefusalText('p1');
const r2 = buildRefusalText('p2');
check('婉拒文案不空', r1.length > 5 && r2.length > 5);
check('婉拒带表情', /\[\表情_.+\]/.test(r1), r1);
check('婉拒不含内部信息', assertNoLeak(r1).ok);

console.log('\n== 分享帖识别 ==');
const shares = ['只剩9没过了。', '终于打过了这个秘境', '记录一下今天的进度', '分享我的阵容', '我毕业了！'];
for (const t of shares) check(`识别为分享：${t}`, looksLikeShare(t) === true);
const notShares = ['天宫码 JFA6Ds3Jcl', '组队码，高活跃', '满勤，速来', '这个关卡怎么过', '【官方攻略】困难6攻略', '出售账号加V'];
for (const t of notShares) check(`不插话：${t}`, looksLikeShare(t) === false);

console.log('\n== 分享互动文案 ==');
const s1 = buildShareText({ postId: 'a1', title: '只剩9没过了。' });
const s2 = buildShareText({ postId: 'a2', title: '终于打过了这个秘境' });
check('是单行', !s1.text.includes('\n'), JSON.stringify(s1.text));
check('带 1 个表情', (s1.text.match(/\[表情_.+\]/g) || []).length === 1, s1.text);
check('表情在结尾', /\[\表情_.+\]\s*$/.test(s1.text), s1.text);
check('不含内部信息', assertNoLeak(s1).ok);
check('不同帖子说法不同', s1.text !== s2.text, `${s1.text} vs ${s2.text}`);
const usedList = [s1.text, s2.text];
const s3 = buildShareText({ postId: 'a3', title: 'x', usedTexts: usedList });
check('避开已用文案', !usedList.includes(s3.text), s3.text);

// ============================================================
// 口吻回归：口语化 / 亲切 / 多样
//
// 标杆（用户给的）：「大佬，好肝啊！」「大佬，肝肝还好吗？」
//                 「正常，玩到正版了，拓维正常操作。」
// 反面（第一版）：「关于这个问题：…」「一句话概括：…」—— 工作汇报腔
// ============================================================
console.log('\n== 口吻：外壳不能是公文腔 ==');
const officeWords = ['关于这个问题', '一句话概括', '在此说明', '综上所述', '请您', '敬请', '感谢您的咨询'];
const allTexts = [];
for (let i = 0; i < 24; i++) {
  allTexts.push(buildReplyText({ answer: ANSWER, postId: 'tone' + i, usedTexts: [], signature: SIG, allowCloser: true }).text);
}
const officeHit = allTexts.filter((t) => officeWords.some((w) => t.includes(w)));
check('24 种说法里没有公文腔', officeHit.length === 0, officeHit[0] || '');

// ============================================================
// 不要模板化：玩家会把版主所有回复翻一遍
//   · 每类池子 ≥ 15 套
//   · 连着回 10 条，开头 / 收尾不能重样
// ============================================================
console.log('\n== 不要模板化：池子够大 + 近期不重样 ==');
for (const [k, min] of [
  ['openers', 15],
  ['closers', 15],
  ['shareProgress', 15],
  ['shareTease', 15],
  ['refusals', 8],
]) {
  check(`${k} 池 ≥${min}（实际 ${POOL_SIZES[k]}）`, POOL_SIZES[k] >= min, String(POOL_SIZES[k]));
}

const streakOpeners = [];
const streakClosers = [];
const sentTexts = [];
for (let i = 0; i < 10; i++) {
  const r = buildReplyText({ answer: ANSWER, postId: 'rest' + i, usedTexts: sentTexts, signature: SIG });
  streakOpeners.push(r.opener);
  if (r.closer) streakClosers.push(r.closer);
  sentTexts.push(r.text);
}
check('连回 10 条 → 10 种不同开头', new Set(streakOpeners).size === 10, streakOpeners.join(','));
check('连回 10 条 → 收尾也不重样', new Set(streakClosers).size === streakClosers.length, streakClosers.join(','));
check('10 条全文互不相同', new Set(sentTexts).size === 10);

const shareStreak = [];
const shareSent = [];
for (let i = 0; i < 10; i++) {
  const r = buildShareText({ postId: 'ss' + i, title: '记录一下进度' + i, usedTexts: shareSent });
  shareStreak.push(r.text.replace(/\[表情_[^\]]+\]$/, ''));
  shareSent.push(r.text);
}
check('连发 10 条分享互动 → 10 种不同说法', new Set(shareStreak).size === 10, `${new Set(shareStreak).size} 种`);

console.log('\n== 分享帖情绪分桶 ==');
check('晒进度 → progress', shareMood('只剩9没过了。') === 'progress');
check('吐槽翻车 → tease', shareMood('又崩了，这波真离谱') === 'tease');
check('官方整活 → tease', shareMood('这活动正常操作，见怪不怪') === 'tease');

const prog = buildShareText({ postId: 'm1', title: '终于打过了这个秘境' });
const tease = buildShareText({ postId: 'm2', title: '又闪退了，真的服' });
check('进度桶走夸的口气', prog.mood === 'progress', prog.text);
check('吐槽桶走共鸣的口气', tease.mood === 'tease', tease.text);
check('两桶文案不串', prog.text !== tease.text);
check('吐槽桶不带事实判断（不出现具体数值/官方说法）', !/\d|补偿|退款|客服/.test(tease.text), tease.text);

const shareTexts = [];
for (let i = 0; i < 20; i++) shareTexts.push(buildShareText({ postId: 's' + i, title: '记录一下进度' + i }).text);
check('20 条分享互动至少 5 种说法', new Set(shareTexts).size >= 5, `${new Set(shareTexts).size} 种`);
check('分享互动全部单行', shareTexts.every((t) => !t.includes('\n')));
check('分享互动表情都在结尾', shareTexts.every((t) => /\[表情_[^\]]+\]$/.test(t)), shareTexts[0]);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
