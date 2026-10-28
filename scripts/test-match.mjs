#!/usr/bin/env node
// 匹配打分回归测试（命中该命中的，不命中不该命中的）
//
// 改 scripts/lib/qa.mjs 的 scoreEntry / 答疑库关键词后必跑：
//   node scripts/test-match.mjs
//
// 历史教训：旧公式 kwScore = 命中数/关键词总数，关键词越多分数越低 ——
// 一条 18 词的新条目连自己的原题都只有 0.19，等于「越用心越匹配不上」。

import { loadQaLibrary, matchPost, looksLikeQuestion } from './lib/qa.mjs';
import { loadConfig } from './lib/paths.mjs';

const config = await loadConfig();
const qa = await loadQaLibrary(config.paths.qaFile);
const TH = config.match.autoReplyScore;

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

const top = (t) => {
  const c = matchPost(t, qa, 1);
  return { score: c[0] ? Number(c[0].score.toFixed(3)) : 0, q: c[0]?.entry?.question || '-' };
};

console.log(`答疑库 ${qa.length} 条，自动回复阈值 ${TH}\n`);

console.log('== 应该命中（≥阈值）==');
const shouldHit = [
  ['十月同游剩下的换什么', '十月同游'],
  ['剩下的换什么？🤔', '剩下的'],
  ['商店剩下的换什么好', '剩下的'],
  ['双人对决说唱金卡值得买吗', '说唱/双人对决'],
  ['4回合说唱金卡值不值得氪金', '说唱'],
  ['钻石怎么快速获得', '钻石'],
  ['新手前期怎么发育', '新手'],
];
for (const [t, expect] of shouldHit) {
  const r = top(t);
  check(`《${t}》 → ${r.score}（${r.q.slice(0, 14)}）`, r.score >= TH, `期望命中「${expect}」`);
}

console.log('\n== 不该命中（必须低于阈值）==');
const shouldMiss = [
  ['为什么火龙果无尽会清场', '库里没有这条'],
  ['十月同游1234567890', '组队贴（只有活动名，没有问题）'],
  ['【官方攻略】主线 未来世界篇-困难6攻略', '攻略帖'],
  ['JFAMcG6Ne7天宫码， 用了说声', '兑换码'],
  ['兄弟们我电脑下载的pc版本找不我手机版的收据怎么弄', '数据迁移，库里没有'],
  ['同样能秒杀10阶僵尸！PVZ2两大法师谁更强？', '对比讨论，库里没有'],
  ['只剩9没过了。', '进度分享，不是提问'],
];
for (const [t, why] of shouldMiss) {
  const r = top(t);
  check(`《${t.slice(0, 22)}》 → ${r.score}`, r.score < TH, `不该命中（${why}），却匹配到「${r.q}」`);
}

console.log('\n== 分数不被关键词数量稀释 ==');
const longEntry = qa.find((e) => e.source && e.keywords.length >= 12);
if (longEntry) {
  const r = top(longEntry.question);
  check(
    `关键词 ${longEntry.keywords.length} 个的条目，自身原题应高分 → ${r.score}`,
    r.score >= TH,
    `条目：《${longEntry.question.slice(0, 20)}》`
  );
} else {
  console.log('  （库里还没有长关键词条目，跳过）');
}

console.log('\n== 非提问帖不该被当成命中 ==');
for (const t of ['【前瞻】全新装扮登场！', '满勤，速来', '组队码，高活跃']) {
  check(`《${t}》 判为非提问`, looksLikeQuestion(t) === false);
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
