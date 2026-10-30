#!/usr/bin/env node
// 向量检索单测：分词 / 余弦 / 建库召回 / 路径记录
//
// 重点验证两件事：
//   1) 语义相近的问法能被召回（「无尽卡波」对「无尽关卡卡住」这类措辞差异）
//   2) **不相关的问法不能被召回成高分**（向量只用来加分，不能拿它触发自动回复）

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './lib/db.mjs';
import { buildIndex, search, tokenize, cosine, makeHttpDense, indexVersion, VEC_VERSION } from './lib/qa-vector.mjs';
import { matchPost } from './lib/qa.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

const dir = mkdtempSync(join(tmpdir(), 'qavec-'));
const db = openDb(join(dir, 'idx.sqlite'));

const entries = [
  {
    id: '无尽卡波',
    question: '无尽关卡一直卡波怎么办',
    keywords: ['无尽', '卡波', '进度'],
    answer: '换阵容或者手动打，前面几波别硬冲。',
  },
  {
    id: '钻石',
    question: '钻石怎么快速获得',
    keywords: ['钻石', '刷钻', '免费钻石'],
    answer: '日常任务和活动攒，签到也送。',
  },
  {
    id: '植物',
    question: '植物怎么升级',
    keywords: ['升级', '等级'],
    answer: '喂碎片或者用银卡升级。',
  },
  {
    id: '卡关',
    question: '某个关卡打不过去怎么办',
    keywords: ['关卡', '打不过', '阵容'],
    answer: '换个植物组合试试，或者看攻略。',
  },
];

const built = buildIndex(db, entries);
ok('建库条数正确', built.entries === 4, `实际 ${built.entries}`);
ok('特征词不为空', built.tokens > 10, `实际 ${built.tokens}`);
ok('索引记了格式版本', indexVersion(db) === VEC_VERSION, String(indexVersion(db)));

// ---------- 分词 ----------
const toks = tokenize('无尽关卡卡波');
ok('中文切出 2-gram', toks.includes('无尽'), JSON.stringify(toks.slice(0, 6)));
ok('中文切出 3-gram', toks.includes('无尽关'), JSON.stringify(toks.slice(0, 8)));
ok('英文保留整词', tokenize('iOS 12').includes('ios'), JSON.stringify(tokenize('iOS 12')));

// ---------- 余弦 ----------
const a = new Map([['x', 1]]);
const b = new Map([['x', 1]]);
const c = new Map([['y', 1]]);
ok('同向量余弦=1', Math.abs(cosine(a, b) - 1) < 1e-9);
ok('无关向量余弦=0', Math.abs(cosine(a, c)) < 1e-9);

// ---------- 召回 ----------
const r1 = await search(db, '无尽关卡卡波好严重', { topN: 3 });
ok('检索有结果', r1.results.length > 0);
ok('路径标成 char-tfidf', r1.path === 'char-tfidf', r1.path);
ok('Top1 是无尽那条', r1.results[0]?.entryId === '无尽卡波', JSON.stringify(r1.results[0] || {}));

const r2 = await search(db, '钻石怎么免费拿', { topN: 3 });
ok('问法不同也能召回钻石条', r2.results[0]?.entryId === '钻石', JSON.stringify(r2.results[0] || {}));

const r3 = await search(db, '怎么把植物喂到满级', { topN: 3 });
ok('植物升级问法命中', ['植物', '卡关'].includes(r3.results[0]?.entryId), JSON.stringify(r3.results[0] || {}));

// 不相关问法：分数必须低（不能靠向量直接触发自动回复）
const r4 = await search(db, '今天天气怎么样适合出去玩吗', { topN: 3, minScore: 0.02 });
ok(
  '无关问法最高分 < 0.15',
  (r4.results[0]?.score ?? 0) < 0.15,
  `实际 ${r4.results[0]?.score}`
);

// ---------- 与旧打分的关系 ----------
const postText = '无尽关卡一直卡波怎么办';
const oldBest = matchPost(postText, entries, 3)[0];
const vecScores = Object.fromEntries(r1.results.map((x) => [x.entryId, x.score]));
const newBest = matchPost(postText, entries, 3, { vecScores })[0];
ok('接入向量后仍能匹配到同一条', newBest?.entry.id === '无尽卡波', JSON.stringify(newBest?.entry?.id));
ok('向量不会把分数拉低', newBest.score >= oldBest.score - 1e-9, `${oldBest.score} → ${newBest.score}`);
ok(
  '光靠向量够不到自动回复阈值(0.6)',
  matchPost('今天天气怎么样适合出去玩吗', entries, 3, {
    vecScores: Object.fromEntries((r4.results || []).map((x) => [x.entryId, x.score])),
  })[0]?.score < 0.6,
  String(matchPost('今天天气怎么样适合出去玩吗', entries, 3, {
    vecScores: Object.fromEntries((r4.results || []).map((x) => [x.entryId, x.score])),
  })[0]?.score)
);

// ---------- dense 路径不可用时自动退回 ----------
const badDense = async () => {
  throw new Error('dense 挂了');
};
const r5 = await search(db, '钻石', { topN: 2, dense: badDense });
ok('dense 失败自动退回 char', String(r5.path).includes('char-tfidf'), r5.path);
ok('退回后仍有结果', r5.results.length > 0);

// ---------- dense 后端工厂 ----------
ok('没配 endpoint 不产出客户端', makeHttpDense({ model: 'bge' }) === null);
ok('配了 endpoint 产出客户端', typeof makeHttpDense({ endpoint: 'http://x/v1/embeddings', model: 'bge' }) === 'function');

// 关闭数据库再删临时目录（WAL 文件被占用时删不掉）
try {
  db.close();
} catch {}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
