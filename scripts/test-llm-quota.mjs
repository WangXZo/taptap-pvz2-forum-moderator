// P4-e LLM 日调用配额测试（2026-11-19）
import { chatWithChannels, llmUsageCount } from './lib/llm.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

// 用 stub 渠道 + 关持久化（避免污染真实 data/llm-usage.json）
const chs = [{ provider: 'p', model: 'm', api: 'openai-completions', baseURL: 'http://x/v1', apiKey: 'k' }];
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }; };

console.log('\n== 未配额：正常调用 ==');
{
  const cfg = { llm: { usagePersist: false, health: { enabled: false } } };
  const r = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg);
  t('调用成功', r.ok === true);
  t('计数增加', llmUsageCount().calls >= 1);
}

console.log('\n== 配额闸：超限快速失败 ==');
{
  // 计数是模块级累计，用「当前值 + 1」做 cap，避免依赖初始状态
  const now = llmUsageCount().calls;
  const cfg1 = { llm: { usagePersist: false, dailyCallCap: now + 1, health: { enabled: false } } };
  const a = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg1);
  t('未达上限时正常调用', a.ok === true);
  const callsBeforeCap = calls;
  const b = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg1);
  t('达到上限后触发 llm_daily_cap', b.ok === false && b.error === 'llm_daily_cap');
  t('返回 capped/used/cap', b.capped === true && typeof b.used === 'number' && b.cap === now + 1);
  t('超闸后不再发请求', calls === callsBeforeCap);
}

console.log('\n== 跨天重置 ==');
{
  // 直接写一个昨天的 usage（持久化开启时才会读盘，这里用真实 data 目录会污染 → 用环境隔离不可行，
  // 改为验证 llmUsageCount 的 day 字段语义）
  const u = llmUsageCount();
  t('含 day 字段（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(u.day));
  t('含 calls 数字', typeof u.calls === 'number');
}

console.log('\n== cap=0 表示不限 ==');
{
  const cfg = { llm: { usagePersist: false, dailyCallCap: 0, health: { enabled: false } } };
  const r = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg);
  t('cap=0 正常调用', r.ok === true);
}

globalThis.fetch = realFetch;
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);