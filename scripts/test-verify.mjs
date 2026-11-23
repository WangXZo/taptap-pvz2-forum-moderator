// 分档验证离线测试（P0-M5 + P2 泛化，2026-11-17）
import { tierOf, verifyCandidate, checkFaithfulness } from './lib/verify.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const cacheFile = join(tmpdir(), `verify-test-${Date.now()}.json`);
console.log('\n== tierOf 分档 ==');
t('官方95+judge ok → high', tierOf(95, true) === 'high');
t('多渠道70+judge ok → high', tierOf(70, true) === 'high');
t('单一社区50+judge ok → mid', tierOf(50, true) === 'mid');
t('负反馈30+judge ok → abstain', tierOf(30, true) === 'abstain');
t('高+judge no → abstain', tierOf(95, false) === 'abstain');
t('边界70 → high', tierOf(70, true) === 'high');
t('边界50 → mid', tierOf(50, true) === 'mid');
console.log('\n== verifyCandidate（mock LLM + 缓存）==');
const realFetch = globalThis.fetch;
const mock = (content, ok = true) => { globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }); };
const cfg = { llm: { apiKey: 'k', baseURL: 'http://x/v1', model: 'm' } };
const post = { title: '瓷砖萝卜稀有吗', text: '' };
const vo = { config: cfg, cacheFile };
mock('yes');
let r = await verifyCandidate(post, { name: '瓷砖萝卜', confidence: 95, attrs: { rarity: '稀有' } }, vo);
t('高+yes → ok/high', r.ok && r.tier === 'high');
globalThis.fetch = realFetch;
mock('yes');
r = await verifyCandidate(post, { id: 'n30', name: 'x', confidence: 30 }, vo);
t('负反馈30+yes → abstain', !r.ok && r.tier === 'abstain');
globalThis.fetch = realFetch;
mock('yes');
r = await verifyCandidate(post, { id: 'n50', name: 'x', confidence: 50 }, vo);
t('单一社区50+yes → mid(仍答)', r.ok && r.tier === 'mid');
globalThis.fetch = realFetch;
mock('no');
r = await verifyCandidate(post, { id: 'n95', name: 'x', confidence: 95 }, vo);
t('高+no → abstain', !r.ok);
globalThis.fetch = realFetch;
console.log('\n== P2：relevance/faithfulness 拆分 + 缓存 ==');
mock('{"relevance":"yes","faithfulness":"no"}');
r = await verifyCandidate(post, { id: 'j1', name: 'x', confidence: 95, answer: 'a' }, vo);
t('rel yes faith no → abstain', !r.ok && r.relevance === true && r.faithfulness === false);
globalThis.fetch = realFetch;
mock('{"relevance":"yes","faithfulness":"yes"}');
r = await verifyCandidate(post, { id: 'j2', name: 'y', confidence: 50, answer: 'b' }, vo);
t('JSON 双 yes → mid', r.ok && r.tier === 'mid');
globalThis.fetch = async () => { throw new Error('net down'); };
r = await verifyCandidate(post, { id: 'j2', name: 'y', confidence: 50, answer: 'b' }, vo);
t('缓存命中（fetch 挂仍判）', r.ok && r.tier === 'mid');
globalThis.fetch = realFetch;
console.log('\n== P3：fact faithfulness 循环论证修正 ==');
mock('{"relevance":"yes","faithfulness":"no"}');
r = await verifyCandidate(post, { id: 'f1', name: '阶数', source: 'fact', confidence: 95, attrs: { perStage: '+50%' }, answer: 'perStage：+50%' }, vo);
t('fact attrs 非空 → faith 恒 true → high', r.ok && r.tier === 'high' && r.faithfulness === true);
globalThis.fetch = realFetch;
mock('{"relevance":"no","faithfulness":"yes"}');
r = await verifyCandidate(post, { id: 'f2', name: '摇滚', source: 'fact', confidence: 50, attrs: { 特点: '巨人多' }, answer: '特点：巨人多' }, vo);
t('fact relevance no → 仍 abstain（供回退）', !r.ok && r.relevance === false);
globalThis.fetch = realFetch;
console.log('\n== P2：生成后忠实度自检 ==');
mock('yes');
t('事实被支持 → true', (await checkFaithfulness('200钻就过', '资料：200钻就过', { config: cfg })) === true);
globalThis.fetch = realFetch;
mock('no');
t('事实无支持 → false', (await checkFaithfulness('500钻', '资料：200钻', { config: cfg })) === false);
globalThis.fetch = realFetch;
t('无资料 → 跳过 true', (await checkFaithfulness('x', '', { config: cfg })) === true);
try { unlinkSync(cacheFile); } catch {}
console.log('\n== O11：缓存键含 status/confidence/material ==');
{
  const vf = join(tmpdir(), `verify-o11-${Date.now()}.json`);
  let n = 0;
  const realF = globalThis.fetch;
  globalThis.fetch = async () => { n++; return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"relevance":"yes","faithfulness":"yes"}' } }] }) }; };
  const vo2 = { config: cfg, cacheFile: vf };
  const base = { id: 'o11', name: 'x', answer: 'a', confidence: 95 };
  await verifyCandidate(post, base, vo2);
  await verifyCandidate(post, base, vo2);
  t('同输入 → 缓存命中（1 次调用）', n === 1);
  n = 0;
  await verifyCandidate(post, { ...base, confidence: 50 }, vo2);
  t('置信变化 → 不复用旧判', n === 1);
  n = 0;
  await verifyCandidate(post, { ...base, status: 'conflict' }, vo2);
  t('状态变化 → 不复用旧判', n === 1);
  n = 0;
  await verifyCandidate(post, base, { ...vo2, material: '- 【事实】新资料' });
  t('material 变化 → 不复用旧判', n === 1);
  globalThis.fetch = realF;
  try { unlinkSync(vf); } catch {}
}
console.log('\n== 回归：缓存 judgeOk 必须是布尔（2026-11-23 修）==');
{
  // 背景：原代码在 judgeOk 算出来之前就写缓存 → 缓存里 judgeOk=undefined（JSON 序列化成 null）
  //       → 日志「judge=undefined」。修复后写缓存放在 judgeOk=rel&&faith 之后。
  const vf = join(tmpdir(), `verify-judgeok-${Date.now()}.json`);
  const realF = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"relevance":"yes","faithfulness":"yes"}' } }] }) });
  const vo3 = { config: cfg, cacheFile: vf };
  await verifyCandidate(post, { id: 'jo1', name: 'x', answer: 'a', confidence: 95 }, vo3);
  const { readFileSync } = await import('node:fs');
  const stored = JSON.parse(readFileSync(vf, 'utf8'));
  const entry = Object.values(stored)[0];
  t('写缓存的 judgeOk 是布尔 true（不是 undefined/null）', entry.judgeOk === true, JSON.stringify(entry));
  t('写缓存的 rel/faith 也是布尔', entry.rel === true && entry.faith === true);
  globalThis.fetch = realF;
  try { unlinkSync(vf); } catch {}
}
{
  // 旧脏缓存：judgeOk=null 但 rel/faith=true → 必须重算成 ok，不能因脏 judgeOk 误弃答
  const vf = join(tmpdir(), `verify-dirty-${Date.now()}.json`);
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const post2 = { title: '脏缓存帖', text: '' };
  const ent = { id: 'dirty1', name: 'x', answer: 'a', confidence: 95 };
  const ctx = [post2.title, post2.text, post2.imageText].filter(Boolean).join('\n');
  const ans = String(ent.answer);
  const stamp = `${ent.status || ''}|${ent.confidence ?? ''}`;
  const key = createHash('sha1').update(`${ctx}|${ent.id}|${ans}|${stamp}|`).digest('hex');
  writeFileSync(vf, JSON.stringify({ [key]: { judgeOk: null, rel: true, faith: true, at: Date.now() } }));
  const realF = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('不应调用 LLM（应命中缓存）'); };
  const r = await verifyCandidate(post2, ent, { config: cfg, cacheFile: vf });
  t('脏缓存 judgeOk=null 但 rel/faith=true → 重算为 ok/high', r.ok && r.tier === 'high', JSON.stringify(r));
  globalThis.fetch = realF;
  try { unlinkSync(vf); } catch {}
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);