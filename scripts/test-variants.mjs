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

console.log('\n== 表情落位：位置不限，最多 1 个（2026-11-10）==');
{
  const { applyEmojiPlacement } = await import('./lib/compose-reply.mjs');
  const config = { reply: { emoji: { enabled: true } } };
  // ⚠️ 自带固定表情表，**不依赖运行时采集的 data/emoji-map.json**：
  //    发布仓库里没有 data/（采集产物不进仓库），靠采集文件会测不成。
  //    真实表的 id/url 由 buildContentsWithEmoji 用，这里只验「名字认不认得出」。
  const FIXTURE_MAP = {
    开心: { id: 71 },
    比心: { id: 123 },
    点赞: { id: 124 },
    加油: { id: 126 },
    叹气: { id: 95 },
    微笑: { id: 70 },
    星星眼: { id: 112 },
  };
  const run = (t, kind = 'comfort') => applyEmojiPlacement(t, { kind, config, map: FIXTURE_MAP });

  const mid = run('先把材料攒够[表情_加油]再冲一波');
  check('表情在句中 → 原位置保留', mid.text === '先把材料攒够[表情_加油]再冲一波', mid.text);
  check('表情在句中 → 不再补第二个', (mid.text.match(/\[表情_/g) || []).length === 1, mid.text);

  const tail = run('这句表情在结尾[表情_比心]');
  check('表情在句尾 → 保留', tail.text === '这句表情在结尾[表情_比心]', tail.text);

  const none = run('一个表情都没写');
  check('模型没写 → 脚本补一个', /\[表情_[^\]]+\]$/.test(none.text), none.text);
  check('补的那个是合法名字', none.emoji && none.text.includes(`[表情_${none.emoji}]`), none.text);

  const bad = run('用了个不存在的[表情_不存在]表情');
  check('未知表情名 → 剔掉那个标记', !bad.text.includes('[表情_不存在]'), bad.text);
  check('剔掉后补一个合法的', /\[表情_[^\]]+\]$/.test(bad.text), bad.text);

  const many = run('两个[表情_开心]表情[表情_点赞]'),
    n = (many.text.match(/\[表情_/g) || []).length;
  check('模型写了多个 → 原样保留（不在这一层裁剪）', n === 2, String(n));
}
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
