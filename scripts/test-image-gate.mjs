// 图片流水线门控离线测试（S1/S2/S5）
// 全部离线：注入假识别器，不打网络、不起 Python。
//
// 2026-11-24：图片识别已拆成独立能力包 `pvz2-image-recognition`，
//   这里从**能力包**取实现，判定函数由主 skill **注入**给能力包（单一事实源）。
//   顺带验证薄壳：能力包不在时静默跳过，主流程照跑。
// 跑：node scripts/test-image-gate.mjs
import { pathToFileURL } from 'node:url';
import { extractImages } from './lib/http.mjs';
import { looksLikeCodeAsk } from './lib/code-guard.mjs';
import { detectFriendRequest } from './lib/mod-task.mjs';
import { looksLikeQuestion } from './lib/qa.mjs';
import { resolveImageEntry } from './lib/image-bridge.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const img = (over = {}) => ({
  original_url: 'https://img2-tc.tapimg.com/moment/etag/abc_20261116.jpg',
  url: 'https://img2-tc.tapimg.com/moment/etag/abc_20261116.jpg/_tap_ugc.jpg',
  medium_url: '..._m.jpg', small_url: '..._s.jpg',
  original_format: 'jpeg', width: 2400, height: 1080, original_size: 1601663, ...over,
});
const item = (images, topic = {}) => ({ moment: { id_str: '1', topic: { type: 2, title: '', summary: '', footer_images: images, ...topic } } });

console.log('\n== 能力包可发现 ==');
const entry = resolveImageEntry();
t('找到 pvz2-image-recognition 入口', Boolean(entry), String(entry));
if (!entry) {
  console.log('\n结果：0 通过 / 1 失败（能力包缺失）');
  process.exit(1);
}
const pkg = await import(pathToFileURL(entry).href);
const { isCodeIntent, imageRelevance, enrichPostImages } = pkg;
/** 主 skill 注入给能力包的判定依赖 */
const deps = { extractImages, looksLikeCodeAsk, detectFriendRequest, looksLikeQuestion };

console.log('\n== extractImages（footer_images schema）==');
{
  const r = extractImages(item([img()]));
  t('取到 1 张', r.length === 1);
  t('url 用原图 original_url', r[0].url === 'https://img2-tc.tapimg.com/moment/etag/abc_20261116.jpg');
  t('width/height 解析', r[0].width === 2400 && r[0].height === 1080);
  t('format/size 解析', r[0].format === 'jpeg' && r[0].size === 1601663);
  t('无 footer_images → []', extractImages(item([])).length === 0);
  t('无 moment → []', extractImages({}).length === 0);
  t('过滤无 url 的脏节点', extractImages(item([{ width: 1 }, img()])).length === 1);
  t('original_url 缺失回退 url', extractImages(item([{ url: 'u' }]))[0].url === 'u');
}

console.log('\n== isCodeIntent（规则1：码/好友跳过，判定由主 skill 注入）==');
{
  t('求码帖 → 跳过', isCodeIntent({ title: '蹲一个天宫码', text: '求一个天宫码' }, {}, deps).skip === true);
  t('加好友意图 → 跳过', isCodeIntent({ title: '加好友扩列', text: '' }, {}, deps).skip === true);
  t('普通提问 → 不跳过', isCodeIntent({ title: '困难6怎么过', text: '用什么植物好' }, {}, deps).skip === false);
  t('活动提问 → 不跳过', isCodeIntent({ title: '狂欢嘉年华奖励是什么', text: '这个活动怎么参加' }, {}, deps).skip === false);
  t('无注入时保守兜底 → 不跳过', isCodeIntent({ title: '蹲一个天宫码', text: '求码' }, {}, {}).skip === false);
}

console.log('\n== imageRelevance（规则2：纯启发式）==');
{
  const images = [img()];
  t('无图 → none', imageRelevance({ title: 'x', text: 'y', images: [] }, {}, deps) === 'none');
  t('求助意图+图 → relevant', imageRelevance({ title: '这关怎么过', text: '卡住了怎么办', images }, {}, deps) === 'relevant');
  t('正文短+图 → relevant', imageRelevance({ title: '萌新', text: '看图', images }, {}, deps) === 'relevant');
  t('正文长且明确 → decorative', imageRelevance({ title: '分享', text: '今天天气不错出去玩了'.repeat(12), images }, {}, deps) === 'decorative');
  const mid = '今天终于把这个植物抽到了感觉还不错属性挺高的就是升级材料有点缺慢慢攒吧不急';
  t('中等正文默认按相关', imageRelevance({ title: '晒一下', text: mid, images }, {}, deps) === 'relevant');
  t('unknownAsRelevant=false → unknown', imageRelevance({ title: '晒一下', text: mid, images }, { image: { relevanceGate: { unknownAsRelevant: false } } }, deps) === 'unknown');
}

console.log('\n== enrichPostImages（流水线 + 规则3回灌）==');
{
  const fakeRec = async () => ({ text: '获得奖励：紫手套碎片×15、钻石×334；狂欢嘉年华活动', sources: ['vlm'] });
  const cfg = { image: { enabled: true } };
  const base = { config: cfg, title: '这个活动奖励是什么', text: '看图', recognize: fakeRec, deps };

  const r1 = await enrichPostImages(item([img()]), base);
  t('相关图识别 → 回灌文本含[图片内容]', r1.text.includes('[图片内容]') && r1.text.includes('紫手套碎片'));
  t('imageText 单独保留', r1.imageText.includes('钻石×334'));
  t('sources 记录', r1.sources.includes('vlm'));
  t('relevance=relevant', r1.relevance === 'relevant');
  t('skipped 为空', r1.skipped === '');

  const r2 = await enrichPostImages(item([]), base);
  t('无图 → no-image，文本不变', r2.skipped === 'no-image' && r2.text === '看图');

  const r3 = await enrichPostImages(item([img()]), { ...base, title: '蹲一个天宫码', text: '求码' });
  t('码意图 → code-intent 跳过', r3.skipped.startsWith('code-intent') && r3.text === '求码');

  const r4 = await enrichPostImages(item([img()]), { ...base, title: '分享', text: '今天天气不错出去玩了'.repeat(12) });
  t('无关配图 → decorative 跳过', r4.skipped === 'decorative');

  const r5 = await enrichPostImages(item([img()]), { ...base, config: { image: { enabled: false } } });
  t('开关关闭 → disabled', r5.skipped === 'disabled');

  const r6 = await enrichPostImages(item([img()]), { ...base, recognize: async () => { throw new Error('boom'); } });
  t('识别异常 → error 降级，文本不变', r6.skipped.startsWith('error:') && r6.text === '看图');

  const r7 = await enrichPostImages(item([img()]), { ...base, recognize: async () => ({ text: '', sources: [] }) });
  t('识别空 → empty-recognition', r7.skipped === 'empty-recognition');
}

console.log('\n== 薄壳：能力包缺失时静默跳过 ==');
{
  // 用 DSH_PVZ2_IMAGE=none 模拟「没装能力包」，薄壳应跳过而不是抛错
  const prev = process.env.DSH_PVZ2_IMAGE;
  process.env.DSH_PVZ2_IMAGE = 'none';
  const bridge = await import('./lib/image-bridge.mjs?noskill=1');
  bridge._resetForTest();
  const r = await bridge.enrichPostImages(item([img()]), { title: '看图', text: '看图' });
  t('缺能力包 → skipped=no-image-skill', r.skipped === 'no-image-skill');
  t('缺能力包 → 文本原样返回', r.text === '看图');
  t('缺能力包 → 不抛错', Boolean(r));
  if (prev === undefined) delete process.env.DSH_PVZ2_IMAGE;
  else process.env.DSH_PVZ2_IMAGE = prev;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
