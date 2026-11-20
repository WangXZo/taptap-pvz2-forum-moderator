// @ 去重测试（2026-11-20）：修「同一条回复重复 @ 同一人」
//
// 线上实证（post_event 4/4 条全是双 @）：
//   "@狐玖儿 @狐玖儿 图里10/10按理能解锁了啊…"
//   "@结风 @结风 点一下真能凑够30个？…"
//   "@User441460584 @User441460584 那老手机上当时绑号了吗？…"
//   根因：提示词要求模型写 @，发送层又拼一次。

import { stripLeadingMention, assertSingleMention } from './lib/compose-reply.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`);
  }
}
const eq = (a, b) => a === b;

console.log('\n== stripLeadingMention：线上 4 条历史样本 ==');
const samples = [
  ['@狐玖儿 @狐玖儿 图里10/10按理能解锁了啊，是得点碎片那格进去领？', '图里10/10按理能解锁了啊，是得点碎片那格进去领？'],
  ['@结风 @结风 点一下真能凑够30个？那我可得去戳戳看', '点一下真能凑够30个？那我可得去戳戳看'],
  ['@User441460584 @User441460584 那老手机上当时绑号了吗？', '那老手机上当时绑号了吗？'],
  ['@User441460584 @User441460584 账号一样也没用，云游戏那套跟桌面版存档不搭界的', '账号一样也没用，云游戏那套跟桌面版存档不搭界的'],
];
for (const [input, expect] of samples) {
  const got = stripLeadingMention(input);
  t(`剥干净：${input.slice(0, 18)}…`, eq(got, expect), `got=${got}`);
}

console.log('\n== stripLeadingMention：单 @ 与边界 ==');
t('单个 @ 也剥', eq(stripLeadingMention('@狐玖儿 你好'), '你好'));
t('三个重复全剥', eq(stripLeadingMention('@A @A @A 说点什么'), '说点什么'));
t('开头连续不同人一并剥', eq(stripLeadingMention('@A @B 都说这关能过'), '都说这关能过'));
t('前面的空格一并吃掉', eq(stripLeadingMention('   @A   你好'), '你好'));
t('全角空格', eq(stripLeadingMention('　@A　你好'), '你好'));
t('句中 @ 不动（引用别人的话）', eq(stripLeadingMention('图里10/10 @狐玖儿 说的对'), '图里10/10 @狐玖儿 说的对'));
t('纯文本不变', eq(stripLeadingMention('图里才10/10'), '图里才10/10'));
t('空串', eq(stripLeadingMention(''), ''));
t('null', eq(stripLeadingMention(null), ''));
t('只有 @名字 → 空', eq(stripLeadingMention('@狐玖儿'), ''));
t('只有重复 @名字 → 空', eq(stripLeadingMention('@狐玖儿 @狐玖儿'), ''));

console.log('\n== stripLeadingMention：特殊用户名 ==');
t('带括号的名字', eq(stripLeadingMention('@哲学家尼采（杯哲） 这帖有意思'), '这帖有意思'));
t('emoji 名字', eq(stripLeadingMention('@👿👿👿👿 闹麻了'), '闹麻了'));
t('带点号的名字', eq(stripLeadingMention('@文歌♫ 说得对'), '说得对'));
t('下划线数字名', eq(stripLeadingMention('@User441460584 你好'), '你好'));

console.log('\n== assertSingleMention ==');
const c1 = assertSingleMention('@狐玖儿 @狐玖儿 你好', '狐玖儿');
t('重复 → 拦下', c1.ok === false && c1.count === 2, JSON.stringify(c1));
const c2 = assertSingleMention('@狐玖儿 你好', '狐玖儿');
t('单个 → 放行', c2.ok === true && c2.count === 1, JSON.stringify(c2));
const c3 = assertSingleMention('@A @B 都说能过', 'A');
t('不同人各一次 → 放行（只查同名）', c3.ok === true && c3.count === 1, JSON.stringify(c3));
const c4 = assertSingleMention('没有提及', '狐玖儿');
t('零次 → 放行', c4.ok === true && c4.count === 0, JSON.stringify(c4));
const c5 = assertSingleMention('@狐玖儿 你好', '');
t('名字为空 → 放行', c5.ok === true);
const c6 = assertSingleMention('＠狐玖儿 ＠狐玖儿 你好', '狐玖儿');
t('全角 ＠ 也算', c6.ok === false && c6.count === 2, JSON.stringify(c6));
const c7 = assertSingleMention('@狐玖儿（杯哲） @狐玖儿（杯哲） hi', '狐玖儿（杯哲）');
t('名字含括号（正则转义）', c7.ok === false && c7.count === 2, JSON.stringify(c7));

console.log('\n== 端到端：修复后的发送文本形态 ==');
{
  // 模拟：模型输出带 @（老行为），发送层拼一次 → 修复后应只剩 1 个
  const modelOut = '@狐玖儿 图里10/10按理能解锁了啊';
  const mention = '狐玖儿';
  const naive = `@${mention} ${modelOut}`; // 老代码：双 @
  t('老代码确实会双 @', assertSingleMention(naive, mention).ok === false);
  // 新代码：先剥再拼
  const fixed = `@${mention} ${stripLeadingMention(modelOut)}`;
  t('新代码只剩 1 个', assertSingleMention(fixed, mention).ok === true);
  t('新代码文本正确', eq(fixed, '@狐玖儿 图里10/10按理能解锁了啊'), fixed);
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);