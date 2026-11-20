// C3 增强离线测试（P2 轮，2026-11-17）：bge-m3 embedding 缓存+兜底，mock fetch。
import { cosine, embedTexts, embedKey, initEmbedCache } from './lib/embed.mjs';
import { openDb } from './lib/db.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== cosine ==');
t('同向=1', Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9);
t('正交=0', cosine([1, 0], [0, 1]) === 0);
t('维度不齐=0', cosine([1], [1, 2]) === 0);
t('空=0', cosine(null, [1]) === 0);

console.log('\n== embedTexts（mock ollama）==');
const f = join(tmpdir(), `embed-${Date.now()}.sqlite`);
const db = openDb(f); initEmbedCache(db);
let calls = 0;
const fetchImpl = async (url, opt) => {
  calls++;
  const body = JSON.parse(opt.body);
  return { ok: true, json: async () => ({ embeddings: body.input.map((_, i) => [i + 1, 0]) }) };
};
let v = await embedTexts(['a', 'b'], { fetchImpl, cacheDb: db });
t('批量返回向量', Array.isArray(v) && v.length === 2 && v[0][0] === 1);
t('调用一次', calls === 1);
v = await embedTexts(['a', 'b'], { fetchImpl, cacheDb: db });
t('缓存命中不再请求', calls === 1 && v[1][0] === 2);
v = await embedTexts(['a', 'c'], { fetchImpl, cacheDb: db });
t('只嵌缺失项', calls === 2 && v.length === 2);
const badFetch = async () => { throw new Error('down'); };
v = await embedTexts(['zzz-new'], { fetchImpl: badFetch, cacheDb: db });
t('服务挂 → null（char 兜底）', v === null);
v = await embedTexts(['a'], { fetchImpl: badFetch, cacheDb: db });
t('已缓存项不受服务挂影响', Array.isArray(v) && v[0][0] === 1);
t('key 稳定', embedKey('m', 'x') === embedKey('m', 'x') && embedKey('m', 'x') !== embedKey('m2', 'x'));
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);