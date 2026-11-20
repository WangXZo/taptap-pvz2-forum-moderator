// C3 混合检索离线测试（P1，2026-11-17）
import { bm25Scores } from './lib/bm25.mjs';
import { rrf, hybridSearch } from './lib/hybrid.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const qa = [
  { id: 'a', question: '困难6怎么过', keywords: ['困难6'], answer: '冰车加机枪' },
  { id: 'b', question: '钻石怎么获得', keywords: ['钻石'], answer: '每日任务' },
];
console.log('\n== BM25 ==');
const bm = bm25Scores(qa.map((e) => e.question + ' ' + e.keywords.join(' ')), '困难6');
t('精确词命中分更高', bm[0] > bm[1]);
console.log('\n== RRF ==');
const f = rrf([[0, 1], [1, 0]]);
t('RRF 融合两路', f.length === 2 && f[0].score > 0);
console.log('\n== hybridSearch ==');
let h = hybridSearch(qa, '困难6怎么过');
t('top 为相关条目', h[0].entry.id === 'a');
t('分值归一 0-1', h[0].score >= 0 && h[0].score <= 1);
h = hybridSearch(qa, '完全无关xyz');
t('无关 query 分低', h[0].score < 0.2);
t('空库 → []', hybridSearch([], 'x').length === 0);
console.log('\n== P2：bge-m3 dense 余弦路 ==');
h = hybridSearch(qa, '随便', { dense: { q: [1, 0], docs: [[1, 0], [0, 1]] } });
t('dense 余弦决定语义路', h[0].entry.id === 'a');
h = hybridSearch(qa, '困难6怎么过', { dense: { q: [1], docs: [] } });
t('dense 不齐 → char 兜底不崩', h[0].entry.id === 'a');
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);