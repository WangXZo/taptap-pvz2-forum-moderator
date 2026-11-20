// 自治治理离线测试（P0-M4，2026-11-17）
import { openDb } from './lib/db.mjs';
import { initFacts, addFact, listFacts, addSource } from './lib/facts.mjs';
import { governFacts } from './lib/govern.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const f = join(tmpdir(), `govern-${Date.now()}.sqlite`);
const db = openDb(f); initFacts(db);
const past = Date.now() - 1000;
addFact(db, { id: 'exp', name: '过期活动', validUntil: past });
addFact(db, { id: 'd1', name: '重复植物', confidence: 90 });
addFact(db, { id: 'd2', name: '重复植物', confidence: 50 });
addFact(db, { id: 'c1', name: '冲突植物', type: 'plant', attrs: { a: 1 } });
addFact(db, { id: 'c2', name: '冲突植物', type: 'plant', attrs: { a: 2 } });
addFact(db, { id: 'cal', name: '佐证植物', confidence: 50 });
addSource(db, 'cal', { source: 'A' }); addSource(db, 'cal', { source: 'B' });
const rep = governFacts(db, { log: () => {} });
const get = (id) => listFacts(db).find((x) => x.id === id);
t('过期标记', get('exp').status === 'expired' && rep.expired >= 1);
t('去重留高置信', get('d1').status === 'active' && get('d2').status === 'archived');
t('冲突标记', get('c2').status === 'conflict' && rep.conflict >= 1);
t('置信自校准回写(2渠道=70)', get('cal').provenance.confidence === 70);
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);