#!/usr/bin/env node
// 三层树上下文 + 资料整理 + LLM 客户端 回归测试（2026-11-04）
//
// ⚠️ **不联网**：LLM 部分只测「解析/拼装/护栏」，真实生成靠 doctor 里的渠道自检。
//
// 盯四件事：
//   ① 三层树建得对（帖子 → 一级回复 → 楼中楼）
//   ② 父链正确（子发言要看到所有父级内容）
//   ③ @ 平级扩展（楼中楼 @了某人 → 同层那个人的所有发言都带上）
//   ④ 答疑库资料**先整理再注入**（只留与话题相关的句子）
//   ⑤ 渠道解析：自带 key 优先，其次复用 DSH；两种 api 风格都能解出请求体

import { buildThreadTree, contextForNode, renderContext, findMentions } from './lib/thread-context.mjs';
import { condenseMaterial } from './lib/compose-reply.mjs';
import { resolveChannels } from './lib/llm.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${name}\n    期望 ${b}\n    实际 ${a}`);
};

// ---------- 造一棵三层树 ----------
const post = {
  id: 'P1',
  title: '困难6怎么过啊',
  text: '卡在困难6好久了，试了好多阵容都不行，求大佬指点。',
  author: '小明',
  authorId: '1',
};
const comments = [
  {
    id_str: 'C1',
    author: { name: '阿强', id: '2' },
    created_time: 1,
    __text: '用机枪加冰车，先控住再输出，我40级过的',
    child_posts: [
      { id_str: 'C1-1', author: { name: '小明', id: '1' }, created_time: 2, __text: '@阿强 冰车要几阶的？' },
      { id_str: 'C1-2', author: { name: '阿强', id: '2' }, created_time: 3, __text: '三阶就够，二阶也能凑合，别升太早' },
      { id_str: 'C1-3', author: { name: '路人', id: '3' }, created_time: 4, __text: '我也想知道' },
    ],
  },
  { id_str: 'C2', author: { name: '老王', id: '4' }, created_time: 5, __text: '我卡这里一个月了' },
];

const tree = buildThreadTree(post, comments);

// ---------- ① 树结构 ----------
console.log('\n[①] 三层树');
ok('节点数 = 1 帖 + 2 一级 + 3 楼中楼 = 6', tree.nodes.size === 6, String(tree.nodes.size));
eq('一级回复 id', tree.roots, ['C1', 'C2']);
ok('楼中楼挂在 C1 下', (tree.byParent.get('C1') || []).join(',') === 'C1-1,C1-2,C1-3');
ok('帖子是 level 0', tree.post.level === 0);
ok('一级回复是 level 1', tree.nodes.get('C1').level === 1);
ok('楼中楼是 level 2', tree.nodes.get('C1-1').level === 2);

// ---------- ② 父链 ----------
console.log('\n[②] 父链');
const ctx1 = contextForNode(tree, 'C1-1');
eq('父链顺序（帖子在前）', ctx1.chain.map((n) => n.id), ['post:P1', 'C1', 'C1-1']);
ok('楼中楼能看到一级回复', ctx1.chain.some((n) => n.text.includes('先控住再输出')));
ok('楼中楼能看到帖子正文', ctx1.chain.some((n) => n.text.includes('卡在困难6好久')));
ok('渲染里三层都在', (() => {
  const r = renderContext(ctx1);
  return r.includes('【帖子】') && r.includes('【回复#C1】') && r.includes('【楼中楼#C1-1】');
})());

// ---------- ③ @ 平级扩展 ----------
console.log('\n[③] @ 平级扩展');
eq('认出 @ 了谁', findMentions('@阿强 冰车要几阶的？', tree), ['阿强']);
ok('扩展里带上了同层阿强的话', ctx1.mentioned.some((m) => m.author === '阿强' && m.said.some((s) => s.text.includes('三阶就够'))));
ok('扩展里也带上了父层阿强的话', ctx1.mentioned.some((m) => m.author === '阿强' && m.said.some((s) => s.text.includes('我40级过的'))));
ok('渲染里出现「同层上下文」', renderContext(ctx1).includes('【同层上下文】'));
ok('没@就不扩展', contextForNode(tree, 'C1-3').mentioned.length === 0);
ok('同层别人说的话不算扩展', !ctx1.mentioned.some((m) => m.author === '路人'));

// ---------- ④ 资料整理 ----------
console.log('\n[④] 答疑库资料整理');
const hits = [
  {
    question: '困难6怎么打',
    answer: '困难6的关键是先控住。用冰车冻住前排，再上机枪输出。40级左右就能过。别急着升植物阶数。另外钻石别乱花，留着抽碎片。',
  },
];
const mat = condenseMaterial(hits, { query: '困难6怎么过 冰车要几阶 机枪输出' });
ok('资料非空', mat.length > 0);
ok('保留了相关句（先控住）', mat.includes('先控住'));
ok('丢掉了无关句（钻石）', !mat.includes('钻石'));
ok('标注了是参考资料', mat.includes('【库｜置信度'));
eq('没命中 → 空', condenseMaterial([], { query: 'x' }), '');
eq('空答案 → 空', condenseMaterial([{ question: 'q', answer: '' }], { query: 'x' }), '');

// ---------- ⑤ 渠道解析 ----------
console.log('\n[⑤] LLM 渠道解析');
const custom = await resolveChannels({
  llm: { apiKey: 'sk-test', baseURL: 'https://example.com/v1/', model: 'my-model' },
});
ok('自带 key 的渠道排在最前', custom[0]?.source === 'config');
eq('自带 key 的模型', custom[0]?.model, 'my-model');
ok('baseURL 去掉结尾斜杠', custom[0]?.baseURL === 'https://example.com/v1');
const dshCh = await resolveChannels({});
ok('没自带 key 时会去找 DSH 的渠道', dshCh.length >= 0); // DSH 不在时是 0，在时 ≥1
ok('渠道不重复', new Set(dshCh.map((c) => `${c.provider}/${c.model}`)).size === dshCh.length);

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
