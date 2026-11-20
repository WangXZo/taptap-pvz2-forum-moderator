// O1 渠道健康冷却离线测试（2026-11-18 B1）：纯逻辑 + chatWithChannels 注入渠道。
import { noteHealth, filterHealthy, chatWithChannels } from './lib/llm.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== noteHealth 纯逻辑 ==');
{
  const m = new Map();
  const now = 1000;
  noteHealth(m, 'p/a', false, now, { baseCooldownMs: 100, maxCooldownMs: 400 });
  t('首次失败 → 冷却 base', m.get('p/a').cooldownUntil === now + 100);
  noteHealth(m, 'p/a', false, now, { baseCooldownMs: 100, maxCooldownMs: 400 });
  t('二次失败 → 指数翻倍', m.get('p/a').cooldownUntil === now + 200);
  noteHealth(m, 'p/a', false, now, { baseCooldownMs: 100, maxCooldownMs: 400 });
  noteHealth(m, 'p/a', false, now, { baseCooldownMs: 100, maxCooldownMs: 400 });
  t('指数封顶 max', m.get('p/a').cooldownUntil === now + 400);
  noteHealth(m, 'p/a', true, now, {});
  t('成功清零', !m.has('p/a'));
}

console.log('\n== filterHealthy ==');
{
  const now = 10000;
  const chs = [{ provider: 'a', model: '1' }, { provider: 'b', model: '2' }];
  const m = new Map([['a/1', { fails: 1, cooldownUntil: now + 500 }]]);
  const out = filterHealthy(chs, m, now);
  t('期内跳过冷却渠道', out.length === 1 && out[0].provider === 'b');
  const m2 = new Map([['a/1', { cooldownUntil: now + 500 }], ['b/2', { cooldownUntil: now + 500 }]]);
  const out2 = filterHealthy(chs, m2, now);
  t('全冷却 → 留最后一个探针', out2.length === 1 && out2[0].provider === 'b');
  const out3 = filterHealthy(chs, m, now + 999);
  t('冷却过期恢复', out3.length === 2);
}

console.log('\n== chatWithChannels（stub fetch）==');
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  // 渠道 bad 恒失败、good 恒成功
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes('bad')) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok-text' } }] }) };
  };
  const chs = [
    { provider: 'bad', model: 'm', api: 'openai-completions', baseURL: 'http://bad/v1', apiKey: 'k' },
    { provider: 'good', model: 'm', api: 'openai-completions', baseURL: 'http://good/v1', apiKey: 'k' },
  ];
  const cfg = { llm: { health: { enabled: true, baseCooldownMs: 600000, maxCooldownMs: 600000, persist: false } } };
  let r = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg);
  t('首轮成功（撞一次失败）', r.ok && r.text === 'ok-text' && calls === 2);
  calls = 0;
  r = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, cfg);
  t('次轮冷却跳过失败渠道（只 1 次调用）', r.ok && calls === 1);
  // 关闭冷却 → 又撞两次
  calls = 0;
  r = await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }] }, { llm: { health: { enabled: false } } });
  t('冷却关闭 → 恢复撞墙', r.ok && calls === 2);
  globalThis.fetch = realFetch;
}

console.log('\n== 小任务 openai 前置（F2）==');
{
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ content: [{ text: 'yes' }] }) };
  };
  const chs = [
    { provider: 'an', model: 'm', api: 'anthropic-messages', baseURL: 'http://an', apiKey: 'k' },
    { provider: 'oa', model: 'm', api: 'openai-completions', baseURL: 'http://oa/v1', apiKey: 'k' },
  ];
  const cfg = { llm: { health: { enabled: false, smallTaskPreferOpenai: true } } };
  await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }, cfg);
  t('小任务先走 openai', seen[0]?.includes('oa'));
  seen.length = 0;
  await chatWithChannels(chs, { messages: [{ role: 'user', content: 'x' }], maxTokens: 600 }, cfg);
  t('大任务保持原序（anthropic 在前）', seen[0]?.includes('an'));
  globalThis.fetch = realFetch;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);