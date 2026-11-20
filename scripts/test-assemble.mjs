// C6 结构化上下文组装离线测试（P2，2026-11-17）
import { assembleMaterial, summarizeAnswer } from './lib/assemble.mjs';
import { openDb } from './lib/db.mjs';
import { initFacts, addFact } from './lib/facts.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== summarizeAnswer 结构化摘要 ==');
const long = '这关就是耗钻加运气。一般200钻就过了。但是如果没带冰车，例外情况要300钻。后期阵容成型后随便打。总体来看容错率较低。';
const s = summarizeAnswer(long, '困难6 钻 冰车', 60);
t('条件/数值句保留（如果/例外/数字）', s.includes('如果') && s.includes('300'));
t('不硬截140字特征（句界裁剪）', !s.endsWith('。') || s.length <= 60 || s.includes('如果'));
const s2 = summarizeAnswer('短答案。', 'x', 300);
t('短答案原样', s2 === '短答案。');

console.log('\n== assembleMaterial facts 全 attrs ==');
const f = join(tmpdir(), `assemble-${Date.now()}.sqlite`);
const db = openDb(f); initFacts(db);
addFact(db, { id: 'box', name: '稀有宝箱', type: 'rule', aliases: ['688'], attrs: { cost: 688, pulls: 10, 例外: '传奇宝箱2888' }, confidence: 95, provenance: { source: '官方公告', verifiedAt: 1 } });
const entry = { id: 'box', name: '稀有宝箱', question: '稀有宝箱', attrs: { cost: 688, pulls: 10, 例外: '传奇宝箱2888' }, confidence: 95, provenance: { source: '官方公告', verifiedAt: 1 }, source: 'fact' };
let m = assembleMaterial({ entry, candidates: [], db, config: {}, query: '688' });
t('attrs 全保留', m.includes('688') && m.includes('10') && m.includes('传奇宝箱2888'));
t('provenance 官方标注', m.includes('官方'));
t('置信度标注', m.includes('95%'));

console.log('\n== 冲突双方都呈现 ==');
addFact(db, { id: 'box2', name: '稀有宝箱', type: 'rule', attrs: { cost: 688, pulls: 1 }, confidence: 50, status: 'conflict' });
m = assembleMaterial({ entry: { ...entry, status: 'conflict' }, candidates: [], db, config: {}, query: '688' });
t('矛盾另一方也在资料里', m.includes('另有说法') && m.includes('pulls：1'));

console.log('\n== 多候选合成+预算裁剪 ==');
const qaCands = [
  { score: 0.9, entry: { id: 'q1', question: '困难6怎么过', answer: '用冰车加机枪。如果没冰车就用萝卜。', confidence: 95 } },
  { score: 0.5, entry: { id: 'q2', question: '钻石怎么攒', answer: '每日任务加活动。', confidence: 50 } },
  { score: 0.3, entry: { id: 'q3', question: '无关条目', answer: '这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的无关内容。', confidence: 50 } },
];
m = assembleMaterial({ entry, candidates: qaCands, db, config: { retrieve: { maxMaterialChars: 220 } }, query: '困难6' });
t('高相关 qa 入选', m.includes('困难6怎么过'));
t('低相关长条目被预算裁掉', !m.includes('无关条目'));
t('facts 必保', m.includes('稀有宝箱'));
m = assembleMaterial({ entry: null, candidates: [], config: {} });
t('无内容 → 空串', m === '');
// 回归（live 探针发现）：qa top1 自身答案必须在资料里（曾被 seen 排除）
const qaEntry = { id: 'q1', question: '困难6怎么过', answer: '用冰车加机枪。如果没冰车就用萝卜。', confidence: 95, source: 'qa' };
m = assembleMaterial({ entry: qaEntry, candidates: [{ score: 0.86, entry: qaEntry }, ...qaCands.slice(1)], db, config: {}, query: '困难6' });
t('qa top1 答案在资料里', m.includes('用冰车加机枪') && m.includes('如果没冰车'));
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);