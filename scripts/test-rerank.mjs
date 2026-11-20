// C4 重排离线测试（P1，2026-11-17）—— mock LLM。
import { rerank } from './lib/rerank.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const realFetch = globalThis.fetch;
const mock = (content, ok = true) => { globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }); };
const cfg = { llm: { apiKey: 'k', baseURL: 'http://x/v1', model: 'm' } };
const cands = [{ entry: { id: 'a', question: 'A' } }, { entry: { id: 'b', question: 'B' } }];
console.log('\n== rerank ==');
mock('[1,0]');
let r = await rerank('q', cands, { config: cfg });
t('LLM 排序生效', r[0].entry.id === 'b' && r[1].entry.id === 'a');
globalThis.fetch = realFetch;
mock('', false);
r = await rerank('q', cands, { config: cfg });
t('LLM 失败回退原序', r[0].entry.id === 'a');
globalThis.fetch = realFetch;
mock('乱码非json');
r = await rerank('q', cands, { config: cfg });
t('解析失败回退原序', r[0].entry.id === 'a');
globalThis.fetch = realFetch;
r = await rerank('q', [cands[0]], { config: cfg });
t('单候选原样', r.length === 1);
console.log('\n== P2：onnx cross-encoder backend ==');
const cfgOnnx = { ...cfg, rerank: { backend: 'onnx', server: 'http://x', modelDir: 'D:/m' } };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, scores: [0.1, 0.9] }) });
r = await rerank('q', cands, { config: cfgOnnx });
t('onnx 分数排序生效', r[0].entry.id === 'b' && r[1].entry.id === 'a');
globalThis.fetch = async (url) => String(url).endsWith('/rerank')
  ? { ok: true, json: async () => ({ ok: false, error: 'model missing' }) }
  : { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '[1,0]' } }] }) };
r = await rerank('q', cands, { config: cfgOnnx });
t('onnx 失败回退 LLM listwise', r[0].entry.id === 'b');
globalThis.fetch = realFetch;
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);