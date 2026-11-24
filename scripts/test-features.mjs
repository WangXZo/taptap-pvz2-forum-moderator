// S6 特征模板匹配离线测试 —— mock fetch + 真实特征库读取。
// 2026-11-24：实现已拆到独立能力包 `pvz2-image-recognition`，模板库随包分发。
// 跑：node scripts/test-features.mjs
import { pathToFileURL } from 'node:url';
import { resolveImageEntry } from './lib/image-bridge.mjs';

const entry = resolveImageEntry();
if (!entry) {
  console.error('✗ 找不到 pvz2-image-recognition 能力包');
  process.exit(1);
}
const { loadFeatures, matchFeatures } = await import(pathToFileURL(entry).href);

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const realFetch = globalThis.fetch;
let calls = [];
function mock(h) { calls = []; globalThis.fetch = async (u, o) => { calls.push({ url: String(u), o }); return h(String(u), o); }; }
function restore() { globalThis.fetch = realFetch; }
const imgRes = () => { const b = new Uint8Array(200); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return { ok: true, status: 200, arrayBuffer: async () => b.buffer }; };
const matchRes = (matches) => { const obj = { ok: true, matches }; return { ok: true, status: 200, json: async () => obj }; };
const cfg = { image: { features: { enabled: true }, ocr: { server: 'http://127.0.0.1:8790' } } };
const imgs = [{ url: 'https://img2-tc.tapimg.com/scene.jpg' }];

console.log('\n== loadFeatures（读 skill 资产库）==');
{
  const { dir, defs } = loadFeatures({});
  t('读到特征定义', defs.length >= 1);
  t('含钻石特征', defs.some((d) => d.id === 'diamond' && d.name === '钻石'));
  t('dir 指向 assets/game-features', dir.replace(/\\/g, '/').endsWith('assets/game-features'));
  t('pending 植物模板也在定义里', defs.some((d) => d.id === 'peashooter' && d.pending === true));
}

console.log('\n== matchFeatures（命中→文本）==');
{
  mock((u) => u.endsWith('/match') ? matchRes([{ id: 'diamond', name: '钻石', score: 0.92 }]) : imgRes());
  const r = await matchFeatures(imgs, { config: cfg });
  restore();
  t('命中特征 → 文本含钻石', r.text.includes('钻石') && r.sources.includes('template'));
  t('POST /match 带 templates', calls.some((c) => c.url.endsWith('/match') && JSON.parse(c.o.body).templates.length >= 1));
  t('模板 base64 非空', JSON.parse(calls.find((c) => c.url.endsWith('/match')).o.body).templates[0].image.length > 50);
}

console.log('\n== 缓存命中 ==');
{
  const m = new Map(); const cache = { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
  mock((u) => u.endsWith('/match') ? matchRes([{ name: '钻石' }]) : imgRes());
  await matchFeatures(imgs, { config: cfg, cache });
  const n = calls.length;
  const r2 = await matchFeatures(imgs, { config: cfg, cache });
  restore();
  t('缓存命中文本一致', r2.text.includes('钻石'));
  t('缓存命中不再请求', calls.length === n);
}

console.log('\n== 降级：无模板/服务挂 ==');
{
  const noTpl = await matchFeatures(imgs, { config: { image: { features: { dir: 'Z:/nonexistent-xyz' } } } });
  t('无特征库 → 空不抛错', noTpl.text === '' && noTpl.sources.length === 0);
  mock(() => { throw new Error('refused'); });
  const down = await matchFeatures(imgs, { config: cfg });
  restore();
  t('服务挂 → 空不抛错', down.text === '');
  mock((u) => u.endsWith('/match') ? matchRes([]) : imgRes());
  const none = await matchFeatures(imgs, { config: cfg });
  restore();
  t('无命中 → 空文本', none.text === '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);