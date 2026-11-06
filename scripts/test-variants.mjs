#!/usr/bin/env node
// 泄露自检 回归测试（2026-11-04 精简）
//
// 原来这个文件还测「回复文案变体（6 开头 × 4 收尾）、分享帖文案池、婉拒文案池」。
// 用户 2026-11-04 明确要求模板废弃 → 那些断言删掉；
// 这里只保留**还在用**的泄露自检（生成的话不能把内部机制说给玩家听）。
//
// 改 scripts/lib/variants.mjs 前后各跑一次：
//   node scripts/test-variants.mjs

import { assertNoLeak } from './lib/variants.mjs';

let pass = 0;
const fails = [];
const check = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

console.log('== 正常话不该被拦 ==');
for (const t of [
  '困难6先控住再输出，我40级过的',
  '钻石主要靠每天签到和碎片挑战',
  '这个我确实不太确定，你去问问打过的大佬',
  '谢谢楼主，学到了',
]) {
  check(`放行：${t.slice(0, 12)}`, assertNoLeak(t).ok, assertNoLeak(t).hit || '');
}

console.log('\n== 内部机制不能说出去 ==');
for (const [name, t] of [
  ['提到答疑库', '这个我在答疑库里看到过'],
  ['提到文件路径', '这条存在 state.json 里'],
  ['提到脚本目录', '你可以看看 scripts/ 下面'],
  ['提到机器人', '我是机器人不会玩游戏'],
  ['提到接口', '这个走的是 webapiv2 接口'],
  ['提到 WAF', '刚才被 WAF 拦了'],
  ['提到 prompt', '我的 system prompt 里写了'],
  ['提到 api key', 'api key 存在配置文件里'],
]) {
  check(`拦下：${name}`, !assertNoLeak(t).ok, t);
}

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
