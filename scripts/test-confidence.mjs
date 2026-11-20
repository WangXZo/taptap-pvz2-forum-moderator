// 动态置信度离线测试（2026-11-17 用户规格）
import { openDb } from './lib/db.mjs';
import { initFacts, addFact, addSource, addFeedback, lookupFact, listFacts } from './lib/facts.mjs';
import { calibrate, recordNegative, recordConfirm, reverify } from './lib/confidence.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const f = join(tmpdir(), `conf-${Date.now()}.sqlite`);
const db = openDb(f); initFacts(db);
const get = (id) => listFacts(db).find((x) => x.id === id);

addFact(db, { id: 'off', name: '官方' }); addSource(db, 'off', { source: '官方公告' });
t('官方 → 95', calibrate(db, get('off')) === 95);
addFact(db, { id: 'single', name: '单源' }); addSource(db, 'single', { source: 'A' });
t('单一渠道 → 50', calibrate(db, get('single')) === 50);
addFact(db, { id: 'two', name: '双渠道' }); addSource(db, 'two', { source: 'A' }); addSource(db, 'two', { source: 'B' });
t('>=2渠道一致 → 70', calibrate(db, get('two')) === 70);
addFact(db, { id: 'many', name: '多渠道' });
['A', 'B', 'C', 'D'].forEach((s) => addSource(db, 'many', { source: s }));
['p1', 'p2', 'p3'].forEach((p) => recordConfirm(db, 'many', { player: p }));
t('>3渠道+>=3玩家统一 → 80', calibrate(db, get('many')) === 80);
addFact(db, { id: 'neg', name: '被反对' }); addSource(db, 'neg', { source: 'A' }); addSource(db, 'neg', { source: 'B' });
recordNegative(db, 'neg', { player: 'x', reason: '早就改了' });
t('负反馈未解决 → 降30', calibrate(db, get('neg')) === 30);
t('负反馈标记 needs_reverify', get('neg').status === 'needs_reverify');
// reverify confirmed → 清负反馈重置70
const mockChat = async (cfg, opt) => ({ ok: true, text: 'confirmed' });
let rv = await reverify(db, get('neg'), { chat: mockChat });
t('核实确认 → 重置70', rv.outcome === 'confirmed' && rv.confidence === 70);
t('确认后 status active', get('neg').status === 'active');
// reverify outdated → expired
recordNegative(db, 'neg', { player: 'y', reason: '过时' });
const mockOut = async () => ({ ok: true, text: 'outdated' });
rv = await reverify(db, get('neg'), { chat: mockOut });
t('核实过时 → expired/20', rv.outcome === 'outdated' && get('neg').status === 'expired');
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);