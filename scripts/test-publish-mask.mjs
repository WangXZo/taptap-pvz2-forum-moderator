#!/usr/bin/env node
// 发布脱敏回归测试（用户 2026-11-05：答疑库 + 事实核验记录都要能脱敏进仓库）
//
// 锁三件事：
//   ① maskValue     —— 遮罩规则「保留首尾 1~3 位，中间 * 补足到 8 位，保留 ≤50%」
//   ② maskQa        —— 答疑库只遮「摘自昵称 / 好友码 / 天宫码」，正文和来源链接一个字不动
//   ③ maskEvidence  —— 核验记录只遮「本机用户名 / 码 / @昵称 / 指定敏感串」，帖子 id 不遮
//
// ⚠️ 本文件里的样例**必须用合成值**（假 uid、假昵称、假码）——
//    用真实值会被发布扫描当场抓出来（2026-11-05 真踩到过）。
//
// 纯离线：不读运行目录、不写仓库。

import { maskValue, maskQa, maskEvidence } from './publish-repo.mjs';

let ok = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

// ---------- 1. maskValue ----------
t('7 位字母数字 → 首尾各 2 位 + 4 个 *', maskValue('abcdefg') === 'ab****fg', maskValue('abcdefg'));
t('10 位好友码同规则', maskValue('andABCDEFGH') === 'an****GH', maskValue('andABCDEFGH'));
t('1 个字 → 8 个 *', maskValue('鱼') === '********', maskValue('鱼'));
t('空值 → 空串', maskValue('') === '');
t('遮罩后不含原文', !maskValue('andABCDEFGH').includes('andABCDEFGH'));

// ---------- 2. maskQa：摘自昵称 ----------
const QA1 = [
  '# 答疑库',
  '',
  '## 问：某个问题',
  '- 关键词：a, b',
  '- 来源：https://www.taptap.cn/moment/123456789',
  '- 总结时间：2026-11-01 15:05:58',
  '- 摘自：测试昵称甲（轻赏美食季）',
  '---',
  '答案正文一个字都不该动。',
  '',
].join('\n');
const r1 = maskQa(QA1);
t('摘自昵称被遮罩', !r1.text.includes('测试昵称甲'), r1.text);
t('徽章保留', r1.text.includes('（轻赏美食季）'));
t('抽出真实昵称', r1.names.includes('测试昵称甲'), JSON.stringify(r1.names));
t('来源链接不动', r1.text.includes('https://www.taptap.cn/moment/123456789'));
t('答案正文不动', r1.text.includes('答案正文一个字都不该动。'));

const QA2 = '## 问：x\n- 摘自：测试昵称乙—RX\n---\n正文\n';
const r2 = maskQa(QA2);
t('无徽章的摘自也遮罩', !r2.text.includes('测试昵称乙—RX'), r2.text);
t('抽到带短横线昵称', r2.names.some((n) => n.includes('测试昵称乙')));

// ---------- 3. maskQa：码 ----------
const QA3 = '## 问：y\n---\n好友码 andABCDEFGH 和 iosABCDEFGH，天宫码 JFAABCDEFG\n';
const r3 = maskQa(QA3);
t('好友码 and 被遮罩', !r3.text.includes('andABCDEFGH'), r3.text);
t('好友码 ios 被遮罩', !r3.text.includes('iosABCDEFGH'));
t('天宫码被遮罩', !r3.text.includes('JFAABCDEFG'));

// ---------- 4. 不该动的别乱遮 ----------
const QA4 = '## 问：有没有人敢挑战我这一关无人能过204088896\n- 关键词：关卡\n---\n要随机到板栗才能过\n';
const r4 = maskQa(QA4);
t('帖子标题里的关卡号不动', r4.text.includes('204088896'), r4.text);
t('普通正文不动', r4.text.includes('要随机到板栗才能过'));

// ---------- 5. 幂等：遮罩过的不再二次遮 ----------
const r5 = maskQa(r1.text);
t('遮罩结果再遮一次不变', r5.text === r1.text);

// ---------- 6. maskEvidence：本机用户名 / 码 / @昵称 ----------
const EV = [
  '- 配置写在家目录：`C:\\Users\\SomeUser\\.taptap-cli\\taptap.json`',
  '- 全局路径：`D:\\npm-global\\node_modules\\@taptap\\cli`',
  '- 作者 @某个玩家 在帖子里贴了 JFAABCDEFG',
  '- 好友码 andABCDEFGH 也贴了',
  '- 帖子 id 866300950728409356 是公开的',
  '- `C:\\Users\\Public\\shared` 是系统账户',
].join('\n');
const r6 = maskEvidence(EV);
t('本机用户名被遮罩', !r6.includes('SomeUser'), r6);
t('路径其余部分保留', r6.includes('\\.taptap-cli\\taptap.json'));
t('npm 全局路径不动（不是个人隐私）', r6.includes('D:\\npm-global\\node_modules\\@taptap\\cli'), r6);
t('@昵称被遮罩', !r6.includes('@某个玩家'));
t('天宫码被遮罩', !r6.includes('JFAABCDEFG'));
t('好友码被遮罩', !r6.includes('andABCDEFGH'));
t('帖子 id 保留（公开内容）', r6.includes('866300950728409356'));
t('系统账户 Public 不动', r6.includes('C:\\Users\\Public\\shared'));

// 指定敏感串（uid / 玩家昵称）—— 精确遮，不误伤帖子 id
const EV2 = '我的 uid 是 1234567；玩家 测试昵称丙 说过话；帖子 866300950728409356 是公开的';
const r7 = maskEvidence(EV2, { secrets: ['1234567', '测试昵称丙'] });
t('指定 uid 被遮罩', !r7.includes('1234567'), r7);
t('指定玩家昵称被遮罩', !r7.includes('测试昵称丙'), r7);
t('帖子 id 仍保留', r7.includes('866300950728409356'), r7);

console.log(`通过 ${ok} 条`);
if (fail) {
  console.log(`失败 ${fail} 条`);
  process.exit(1);
}
console.log('全部通过 ✓');