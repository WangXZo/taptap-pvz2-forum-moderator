// 语义确认门离线测试（2026-11-17）—— mock fetch，不打网络。
// 跑：node scripts/test-semantic-gate.mjs
import { confirmSemantic } from './lib/semantic-gate.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const realFetch = globalThis.fetch;
function mock(content, ok = true) {
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
}
function restore() { globalThis.fetch = realFetch; }
const cfg = { llm: { apiKey: 'k', baseURL: 'http://x/v1', model: 'm' } };
const post = { title: '花盆挂件碎片会过期吗', text: '用不了放背包', imageText: '图中识别到：花盆挂件碎片自选' };
const entry = { question: '花盆挂件碎片5片自选会过期吗', answer: '只能活动期间用，下一期令营才能用' };

console.log('\n== confirmSemantic ==');
{
  mock('yes');
  t('LLM yes → 选用', (await confirmSemantic(post, entry, { config: cfg })) === true);
  restore();
  mock('no');
  t('LLM no → 不选用', (await confirmSemantic(post, entry, { config: cfg })) === false);
  restore();
  mock('', false);
  t('LLM 挂 → 不自动选用', (await confirmSemantic(post, entry, { config: cfg })) === false);
  restore();
}

console.log('\n== 库解析「语义确认」标记 ==');
{
  const f = join(tmpdir(), `sem-qa-${Date.now()}.md`);
  writeFileSync(f, '## 问：甲问题\n- 关键词：甲\n- 语义确认：true\n---\n甲答案\n\n## 问：乙问题\n- 关键词：乙\n---\n乙答案\n', 'utf8');
  const qa = await loadQaLibrary(f);
  unlinkSync(f);
  const a = qa.find((e) => e.question === '甲问题');
  const b = qa.find((e) => e.question === '乙问题');
  t('带标记 → semanticConfirm=true', a?.semanticConfirm === true);
  t('无标记 → semanticConfirm=false', b?.semanticConfirm === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);