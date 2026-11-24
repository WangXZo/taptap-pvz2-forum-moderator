// 模板匹配离线测试 —— mock fetch + 真实模板库读取。
//
// 2026-11-24 重构：
//   · 匹配引擎在独立 skill image-recognition-ai-ocr（features.mjs → server.py /match）
//   · **模板库仍留在本 skill**（assets/game-features），运行时传给能力包
// 所以两边都测：本 skill 的 loadTemplates 能读出库，能力包的 matchImage 能消费它。
//
// 跑：node scripts/test-features.mjs
import { pathToFileURL } from 'node:url';
import { resolveImageEntry, loadTemplates } from './lib/image-recognition.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const entry = resolveImageEntry();
if (!entry) {
  console.error('✗ 找不到 image-recognition-ai-ocr 能力包');
  process.exit(1);
}
const pkg = await import(pathToFileURL(entry).href);
const { matchImage, matchImages, loadMaterials, formatMaterials } = pkg;

const realFetch = globalThis.fetch;
let calls = [];
function mock(h) { calls = []; globalThis.fetch = async (u, o) => { calls.push({ url: String(u), o }); return h(String(u), o); }; }
function restore() { globalThis.fetch = realFetch; }
const matchRes = (matches) => ({ ok: true, status: 200, json: async () => ({ ok: true, matches }) });

const cfg = { server: 'http://127.0.0.1:8791' };
const img = { ref: 'img1', base64: 'A'.repeat(200) };

console.log('\n== 本 skill loadTemplates（模板库在本 skill）==');
{
  const { dir, defs, templates } = loadTemplates({});
  t('读到特征定义', defs.length >= 1);
  t('含钻石特征', defs.some((d) => d.id === 'diamond' && d.name === '钻石'));
  t('dir 指向本 skill 的 assets/game-features', dir.replace(/\\/g, '/').endsWith('assets/game-features'));
  t('pending 植物模板也在定义里', defs.some((d) => d.id === 'peashooter' && d.pending === true));
  t('转成 templates（带 base64 图）', templates.length >= 1 && templates[0].image.length > 100);
  t('templates 带 threshold', typeof templates[0].threshold === 'number');
  t('celebrate 特征可识别', defs.some((d) => d.trigger === 'celebrate'));
}

console.log('\n== 能力包 matchImage（消费传入的模板）==');
{
  const { templates } = loadTemplates({});
  mock(() => matchRes([{ id: 'diamond', name: '钻石', score: 0.92 }]));
  const r = await matchImage(img, templates, { config: cfg });
  restore();
  t('命中特征', r.hits.length === 1 && r.hits[0].name === '钻石');
  t('POST /match 带 templates', calls.some((c) => c.url.endsWith('/match') && JSON.parse(c.o.body).templates.length >= 1));
  t('模板 base64 非空', JSON.parse(calls.find((c) => c.url.endsWith('/match')).o.body).templates[0].image.length > 50);
}

console.log('\n== 默认端口 8791 ==');
{
  mock(() => matchRes([]));
  await matchImage(img, [{ id: 'x', name: 'x', image: 'QUJD' }], { config: {} });
  restore();
  t('未配 server 时走 8791', calls[0].url.includes('127.0.0.1:8791'));
}

console.log('\n== 批量 ==');
{
  mock(() => matchRes([{ name: '钻石' }]));
  const r = await matchImages([img, { ...img, ref: 'img2' }], [{ id: 'd', name: '钻石', image: 'QUJD' }], { config: cfg });
  restore();
  t('逐张返回', r.length === 2 && r[0].ref === 'img1' && r[1].ref === 'img2');
}

console.log('\n== 降级：无模板 / 服务挂 / 无命中 ==');
{
  const noTpl = await matchImage(img, [], { config: cfg });
  t('无模板 → no-templates 不请求', noTpl.error === 'no-templates' && noTpl.hits.length === 0);

  mock(() => { throw new Error('refused'); });
  const down = await matchImage(img, [{ id: 'd', name: '钻石', image: 'QUJD' }], { config: cfg });
  restore();
  t('服务挂 → 空命中不抛错', down.hits.length === 0 && Boolean(down.error));

  mock(() => matchRes([]));
  const none = await matchImage(img, [{ id: 'd', name: '钻石', image: 'QUJD' }], { config: cfg });
  restore();
  t('无命中 → 空数组', none.hits.length === 0 && !none.error);

  const noB64 = await matchImage({ ref: 'x', base64: '' }, [{ id: 'd', name: 'd', image: 'QUJD' }], { config: cfg });
  t('无 base64 → 不请求', noB64.error === 'no-base64');
}

console.log('\n== 能力包内置资料（资料层）==');
{
  const mats = loadMaterials({});
  t('有内置资料', mats.length >= 1);
  t('含场景分类法', mats.some((m) => m.id === 'scene-types'));
  t('可格式化为 prompt 块', formatMaterials(mats).length > 50);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);