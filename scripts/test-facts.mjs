// facts 事实层离线测试（P0-M2，2026-11-17）
import { openDb } from './lib/db.mjs';
import { initFacts, addFact, lookupFact, listFacts, setFactStatus, addSource, calibratedConfidence } from './lib/facts.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const f = join(tmpdir(), `facts-test-${Date.now()}.sqlite`);
const db = openDb(f);
initFacts(db);

console.log('\n== facts CRUD/lookup ==');
addFact(db, { id: 'tile', name: '瓷砖萝卜', type: 'plant', aliases: ['瓷砖'], attrs: { rarity: '稀有' }, confidence: 50 });
addFact(db, { id: 'box688', name: '稀有宝箱', type: 'rule', aliases: ['688'], attrs: { cost: 688, pulls: 10 }, confidence: 95 });
t('lookup name', lookupFact(db, '瓷砖萝卜')?.id === 'tile');
t('lookup alias', lookupFact(db, '688')?.id === 'box688');
t('lookup 归一化空白', lookupFact(db, '瓷砖 萝卜')?.id === 'tile');
t('lookup 无 → null', lookupFact(db, '不存在') === null);
t('attrs 解析', lookupFact(db, '瓷砖萝卜').attrs.rarity === '稀有');
t('list type 过滤', listFacts(db, { type: 'rule' }).length === 1);
setFactStatus(db, 'tile', 'expired');
t('status 更新', listFacts(db, { status: 'expired' })[0]?.id === 'tile');
setFactStatus(db, 'tile', 'active');

console.log('\n== 置信自校准 ==');
addFact(db, { id: 'c1', name: '单源', confidence: 50 });
t('单一社区 → 50', calibratedConfidence(db, lookupFact(db, '单源')) === 50);
addSource(db, 'c1', { source: '玩家A' });
addSource(db, 'c1', { source: '玩家B' });
t('≥2 独立渠道一致 → 70', calibratedConfidence(db, lookupFact(db, '单源')) === 70);
addFact(db, { id: 'c2', name: '官方', confidence: 50 });
addSource(db, 'c2', { source: '官方公告' });
t('官方源 → 95', calibratedConfidence(db, lookupFact(db, '官方')) === 95);
addFact(db, { id: 'c3', name: '人工', confidence: 50, provenance: { verifiedAt: 1, confidence: 50 } });
t('人工确认 → 95', calibratedConfidence(db, lookupFact(db, '人工')) === 95);
// 回归（2026-11-17 P2 检查）：provenance.source=官方 但无 verifiedAt/sources 行 → 仍 95（duel 曾误降 50）
addFact(db, { id: 'c4', name: '官方prov', confidence: 95, provenance: { source: '官方公告', confidence: 95, verifiedAt: null } });
t('provenance.source 官方 → 95', calibratedConfidence(db, lookupFact(db, '官方prov')) === 95);

try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);