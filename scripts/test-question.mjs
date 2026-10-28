#!/usr/bin/env node
// 提问判定回归测试（31 条用例）
//
// 改 scripts/lib/qa.mjs 的 looksLikeQuestion 之前先跑这个，改完再跑一次：
//   node scripts/test-question.mjs
//
// 规则说明见 references/question-detect.md
//
// 退出码：0 = 全过，1 = 有用例失败（可用于 CI / 提交前自检）

import { looksLikeQuestion } from './lib/qa.mjs';

// [标题, 期望是否提问, 说明]
const CASES = [
  // ========== A. 应判「提问」（需要回）==========
  ['买了塔黄无尽用什么不较好', true, '★用户指出：实为"用什么比较好"，早期词表缺"什么"漏判'],
  ['1234567890有人帮一下吗[表情_泪目]', true, '★纯数字前缀 + 求助，曾被 [A-Z0-9]{8,} 当兑换码误伤'],
  ['这关咋过啊', true, '★口语"咋"，早期词表漏收'],
  ['剩下的换什么？🤔', true, '换什么'],
  ['4回合说唱金卡值不值得氪金', true, '值得吗'],
  ['为什么火龙果无尽会清场', true, '为什么'],
  ['有没有活跃度高一起的', true, '有没有'],
  ['未来礼盒什么时候返场', true, '什么时候'],
  ['月球基地打完只给12个粗制抑能吗', true, '吗'],
  ['求微氪植物推荐', true, '求推荐'],
  ['这个游戏还能玩吗？', true, '问号'],
  ['无尽模式怎么配植物', true, '怎么'],
  ['塔黄值得买吗', true, '值得吗'],
  ['新手先养哪个植物', true, '哪个'],
  ['求助 这关怎么打', true, '求助'],
  ['天宫什么时候开', true, '什么时候'],
  ['只剩9没过了。', false, '★进度分享（用户判定），曾被默认兜底误判成提问并入库'],
  ['只剩9没过，这关怎么打', true, '★同上但含疑问词 → 仍是提问'],
  ['未来礼盒什么时候返场', true, '★提问；旧词表缺「什么/返场」曾被判成非提问帖'],
  ['这个活动什么时候结束', true, '同类的「什么时候」'],
  ['挑战一天不骂 tw', true, '模糊吐槽 —— 默认判提问，进人工扫一眼'],

  // ========== B. 应判「非提问」（不用回）==========
  ['【官方攻略】主线 未来世界篇-困难6攻略\n这关怎么打，先放向日葵再放豌豆', false, '★攻略帖正文含"怎么"，顺序反了会误判'],
  ['【官方攻略】主线 未来世界篇-普通12攻略', false, '官方攻略'],
  ['【前瞻】全新装扮登场！黏弹糯米装扮免费领！', false, '前瞻'],
  ['天宫码 JFA6Ds3Jcl', false, '兑换码'],
  ['天宫码', false, '太短'],
  ['码', false, '单字'],
  ['组队码，高活跃', false, '组队'],
  ['满勤，速来', false, '组队'],
  ['1234567890', false, '纯数字 ID'],
  ['12345', false, '短纯数字'],
  ['abc123456', false, '纯字母数字'],
  ['三个星期兑换了5阶阳光菇，现在准备雏菊了', false, '完成态分享'],
  ['终于打过了这个秘境', false, '完成态'],

  // ========== B2. 兑换码帖（多行 / 含字母长串）不是提问 ==========
  ['iOS\nJFI2xx0eV9', false, '★多行兑换码帖 —— 换行曾让纯 ID 检测失效'],
  ['JFAMZsJuD5\n天宫', false, '★含字母的兑换码串'],
  ['ABCD123456', false, '含字母的长码串'],
  ['1234567890有人帮一下吗', true, '★纯数字长串 + 求助，不是兑换码'],
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let pass = 0;
const fails = [];

for (const [title, expect, note] of CASES) {
  const got = looksLikeQuestion(title);
  if (got === expect) pass++;
  else fails.push({ title, expect, got, note });
}

const total = CASES.length;
const label = (b) => (b ? '提问' : '非问');

if (fails.length) {
  console.log(`${RED}✗ ${pass}/${total} 通过，${fails.length} 条失败${OFF}\n`);
  for (const f of fails) {
    const oneLine = f.title.split('\n')[0];
    console.log(`  ${RED}✗${OFF} 《${oneLine}》  期望=${label(f.expect)} 实际=${label(f.got)}`);
    console.log(`     ${DIM}${f.note}${OFF}`);
  }
  console.log(`\n${DIM}规则说明见 references/question-detect.md${OFF}`);
  process.exit(1);
} else {
  console.log(`${GREEN}✓ ${pass}/${total} 全部通过${OFF}`);
  process.exit(0);
}
