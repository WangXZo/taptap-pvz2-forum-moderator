// C11 摄入离线测试（P1，2026-11-17）—— mock LLM。
import { ingest } from './lib/ingest.mjs';
import { openDb } from './lib/db.mjs';
import { listFacts, sourcesOf } from './lib/facts.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"layer":"fact","entity":"瓷砖萝卜","type":"plant","attrs":{"rarity":"稀有"},"aliases":["瓷砖"],"confidence":50}' } }] }) });
const f = join(tmpdir(), `ingest-${Date.now()}.sqlite`);
const db = openDb(f);
const stat = await ingest([{ text: '瓷砖萝卜是稀有植物', source: 'weekly总结', url: 'http://x' }], { config: { llm: { apiKey: 'k', baseURL: 'http://x/v1', model: 'm' } }, db, log: () => {} });
globalThis.fetch = realFetch;
t('fact 摄入1', stat.fact === 1);
const facts = listFacts(db);
t('facts 含瓷砖萝卜', facts.some((x) => x.name === '瓷砖萝卜'));
t('带渠道来源', sourcesOf(db, facts.find((x) => x.name === '瓷砖萝卜').id).some((s) => s.source === 'weekly总结'));
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);