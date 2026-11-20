// retrieve 检索抽象离线测试（P0-M6，2026-11-17）
import { openDb } from './lib/db.mjs';
import { initFacts, addFact, addSource } from './lib/facts.mjs';
import { retrieve } from './lib/retrieve.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const f = join(tmpdir(), `retrieve-${Date.now()}.sqlite`);
const db = openDb(f); initFacts(db);
addFact(db, { id: 'box', name: '钻石宝箱抽取', type: 'rule', aliases: ['688', '2888'], attrs: { pulls: 10 }, confidence: 95 });
addSource(db, 'box', { source: '官方公告' }); // 官方源 → 95
const qa = [{ id: 'q1', question: '困难6怎么过', keywords: ['困难6'], answer: '用冰车加机枪', confidence: 95, auto: false }];
// 离线测试：强制 char dense + 关 rerank（不依赖 ollama/LLM）
const cfg = { retrieve: { denseBackend: 'char', rerank: false } };
console.log('\n== retrieve facts优先 ==');
let r = await retrieve({ title: '688是单抽还是十连', text: '' }, { qa, db, config: cfg });
t('facts 命中 source=fact', r.source === 'fact' && r.entry.id === 'box');
t('facts answer 含 attrs', r.entry.answer.includes('10'));
t('facts confidence 95', r.entry.confidence === 95);
t('facts entry 带 provenance（C6 用）', r.entry.provenance != null && r.entry.source === 'fact');
t('candidates 带 entry（C6 多候选）', r.candidates[0]?.entry?.id === 'box');
console.log('\n== retrieve qa兜底 ==');
r = await retrieve({ title: '困难6怎么过', text: '' }, { qa, db, config: cfg });
t('无facts → qa', r.source === 'qa' && r.entry?.id === 'q1');
t('qa candidates 带 entry', r.candidates[0]?.entry?.id === 'q1');
r = await retrieve({ title: '完全无关', text: '' }, { qa, db, config: cfg });
t('无命中 entry=null', r.entry === null);
r = await retrieve({ title: '688', text: '' }, { qa, db: null, config: cfg });
t('无db → 走qa不崩', r.source === 'qa');
console.log('\n== C8 实体路由（P3）==');
r = await retrieve({ title: '看图', text: '这是啥', imageEntities: ['688'] }, { qa, db, config: cfg });
t('图片实体 → facts 直连', r.source === 'fact' && r.entry.id === 'box' && r.entry.viaEntity === true);
r = await retrieve({ title: '看图', text: '这是啥', imageEntities: ['不存在实体'] }, { qa, db, config: cfg });
t('实体未命中 → 回退 qa', r.source === 'qa');
r = await retrieve({ title: '688是单抽还是十连', text: '' }, { qa, db, config: cfg });
t('文本提及 viaEntity=false', r.entry.viaEntity === false);
// 回归（P3 eval 发现）：泛别名遮蔽专名 → 最长匹配优先
addFact(db, { id: 'endless', name: '无尽挑战', aliases: ['无尽'], attrs: {}, confidence: 50 });
addFact(db, { id: 'rock', name: '摇滚无尽', aliases: [], attrs: {}, confidence: 50 });
r = await retrieve({ title: '摇滚无尽怎么打', text: '' }, { qa, db, config: cfg });
t('最长匹配优先（摇滚无尽 > 无尽）', r.entry.id === 'rock');
r = await retrieve({ title: '688是单抽还是十连', text: '' }, { qa, db, config: cfg, skipFacts: true });
t('skipFacts 回退问答层', r.source === 'qa');
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);