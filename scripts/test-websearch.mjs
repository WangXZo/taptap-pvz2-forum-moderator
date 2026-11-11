// 联网补答接线测试（离线，不打网络）
//
// 验的是「适配层 ↔ baidu-websearch」的契约，不是百度本身：
//   ① 答案 → mode:'answer'，可作答
//   ② 只有结果页 → mode:'page'，**不许当答案用**（answer 必须为空）
//   ③ 配額用完 / 被风控 / 超时 → ok:false，转人工
//   ④ 单轮配额：resetSearchRound 会调到 skill 的 resetRound；quotaLeft 透传
//   ⑤ 没装 skill / DSH_BAIDU_WEBSEARCH=none → 返回 null（主流程静默跳过）
//
// 做法：把 DSH_BAIDU_WEBSEARCH 指向一个**假 skill 模块**，让适配层按真实路径去 import。

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = join(tmpdir(), `ws-test-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const FAKE = join(TMP, 'websearch.mjs');

writeFileSync(
  FAKE,
  `
export const MAX_QUERIES_PER_ROUND = 2;
let used = 0;
export function resetRound() { used = 0; globalThis.__resetCalls = (globalThis.__resetCalls || 0) + 1; }
export function quotaLeft() { return Math.max(0, MAX_QUERIES_PER_ROUND - used); }
export async function search(q, opts = {}) {
  used += 1;
  const r = globalThis.__FAKE_WS__ || { ok: false, mode: 'none', reason: 'error', detail: 'no fake' };
  return { attempts: 1, ms: 1, text: '', answer: '', refs: [], results: [], snippets: [], ...r, q, opts };
}
`,
  'utf8'
);

process.env.DSH_BAIDU_WEBSEARCH = FAKE;
const ws = await import('./lib/websearch.mjs');

let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  }
};

// ---------- ① 有 AI 答案 ----------
console.log('\n① 有 AI 答案（可作答）');
globalThis.__FAKE_WS__ = {
  ok: true,
  mode: 'answer',
  detail: 'AI 答案 30 字｜引用 2 条',
  text: '【AI 答案】铜钱草靠周年活动拿',
  answer: '铜钱草主要靠周年活动、限时抽奖、追击商店兑换拿。'.repeat(2),
  refs: ['https://a.com', 'https://b.com'],
  results: [{ title: '铜钱草怎么得', url: 'https://a.com' }],
};
ws._resetForTest();
let r = await ws.websearch('铜钱草怎么获得');
ok('ok=true', r?.ok === true);
ok("mode='answer'", r?.mode === 'answer', `实际 ${r?.mode}`);
ok('answer 有内容', (r?.answer || '').length > 10);
ok('text 透传', String(r?.text || '').includes('铜钱草'));
ok('refs 透传', (r?.refs || []).length === 2);
ok('titles 从 results 提取', (r?.titles || [])[0] === '铜钱草怎么得');

// ---------- ② 只有结果页 ----------
console.log('\n② 只有结果页（不许当答案用）');
globalThis.__FAKE_WS__ = {
  ok: true,
  mode: 'page',
  detail: '没取到 AI 答案（结果页没内嵌 sseApi），退回结果页：8 条',
  text: '【百度结果页】查询：xxx',
  answer: '', // ← 关键：page 模式不允许有答案
  refs: [],
  results: [
    { title: '某攻略', url: 'https://x.com/1' },
    { title: '某贴吧', url: 'https://x.com/2' },
  ],
};
ws._resetForTest();
r = await ws.websearch('某个冷门问题');
ok('ok=true', r?.ok === true);
ok("mode='page'", r?.mode === 'page', `实际 ${r?.mode}`);
ok('answer 必须为空（不当答案用）', (r?.answer || '') === '', `实际「${r?.answer}」`);
ok('titles 有 2 条线索', (r?.titles || []).length === 2);

// ---------- ③ 各类失败 ----------
console.log('\n③ 失败三种：配额 / 风控 / 搜不到');
for (const [reason, needle] of [
  ['quota', '配额'],
  ['blocked', '风控'],
  ['empty', '没搜到'],
]) {
  globalThis.__FAKE_WS__ = { ok: false, mode: 'none', reason, detail: `detail-${reason}` };
  ws._resetForTest();
  r = await ws.websearch('问题');
  ok(`reason=${reason} → ok=false`, r?.ok === false);
  ok(`reason=${reason} 透传`, r?.reason === reason, `实际 ${r?.reason}`);
  ok(`reason=${reason} answer 为空`, (r?.answer || '') === '');
  void needle;
}

// ---------- ④ 配额接口 ----------
console.log('\n④ 单轮配额接口');
globalThis.__resetCalls = 0;
globalThis.__FAKE_WS__ = { ok: true, mode: 'answer', text: 't', answer: 'a'.repeat(20), refs: [], results: [] };
ws._resetForTest();
await ws.resetSearchRound(() => {});
ok('resetSearchRound 调到了 skill.resetRound', globalThis.__resetCalls === 1, `实际 ${globalThis.__resetCalls}`);
const before = ws.searchQuotaLeft();
ok('quotaLeft 透传且 ≤ 上限 2', before <= 2, `实际 ${before}`);

// ---------- ⑤ 没装 skill / 明确禁用 ----------
console.log('\n⑤ 没装 skill → 静默跳过（null）');
process.env.DSH_BAIDU_WEBSEARCH = 'none';
ws._resetForTest();
ok('resolveWebsearchEntry() = null', ws.resolveWebsearchEntry() === null);
r = await ws.websearch('问题');
ok('websearch 返回 null（不抛错）', r === null, `实际 ${JSON.stringify(r)}`);
ok('quotaLeft 不拦（Infinity）', ws.searchQuotaLeft() === Infinity);

// ---------- ⑥ 入口不存在 ----------
console.log('\n⑥ 入口路径不存在 → 也当没装（回退到默认候选）');
process.env.DSH_BAIDU_WEBSEARCH = join(TMP, 'nope', 'websearch.mjs');
ws._resetForTest();
const entry = ws.resolveWebsearchEntry();
ok('不会返回不存在的路径', entry === null || entry !== join(TMP, 'nope', 'websearch.mjs'));

try {
  rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(`\n通过 ${pass} 项` + (process.exitCode ? '（有失败）' : ' 全部通过 ✓'));