// 图片识别业务门控 + 回灌离线测试
//
// 2026-11-24 重构：识别能力拆到独立 skill image-recognition-ai-ocr（任务驱动）。
// 本 skill 侧只剩**业务逻辑**：求码/加好友门控、相关性启发式、结果回灌。
// 所以这里测的是业务层，识别用注入的假 recognize 顶替（离线、不打网络）。
//
// 跑：node scripts/test-image-gate.mjs
import { extractImages } from './lib/http.mjs';
import { isCodeIntent, imageRelevance, enrichPostImages, resolveImageEntry, loadTemplates } from './lib/image-recognition.mjs';

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

/** 假 recognize：模拟识图 skill 的返回（2026-11-25 起统一「一图一条」） */
function fakeRecognize({ textOut = '获得奖励：紫手套碎片×15、钻石×334', features = [], desc = '' } = {}) {
  return async () => ({
    ok: true,
    mode: 'explicit',
    tasks: ['text', 'feature'],
    results: [
      {
        image: 'img1',
        tasks: ['text', 'feature'],
        text: textOut,
        chars: textOut.length,
        lines: [],
        labels: ['含数字'],
        matches: null,
        features,
        description: desc,
        method: features.length ? 'ocr+template' : 'ocr+vlm',
      },
    ],
    meta: { images: [{ ref: 'img1' }], methods: ['ocr'], degraded: [], skipped: [], ms: 10 },
  });
}

console.log('\n== 识图 skill 可发现 ==');
{
  const entry = resolveImageEntry();
  t('找到 image-recognition-ai-ocr 入口', Boolean(entry), String(entry || '（未装，属正常降级）'));
}

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

console.log('\n== isCodeIntent（规则1：码/好友跳过）==');
{
  t('求码帖 → 跳过', isCodeIntent({ title: '蹲一个天宫码', text: '求一个天宫码' }).skip === true);
  t('加好友意图 → 跳过', isCodeIntent({ title: '加好友扩列', text: '' }).skip === true);
  t('普通提问 → 不跳过', isCodeIntent({ title: '困难6怎么过', text: '用什么植物好' }).skip === false);
  t('活动提问 → 不跳过', isCodeIntent({ title: '狂欢嘉年华奖励是什么', text: '这个活动怎么参加' }).skip === false);
}

console.log('\n== imageRelevance（规则2：纯启发式）==');
{
  const images = [img()];
  t('无图 → none', imageRelevance({ title: 'x', text: 'y', images: [] }) === 'none');
  t('求助意图+图 → relevant', imageRelevance({ title: '这关怎么过', text: '卡住了怎么办', images }) === 'relevant');
  t('正文短+图 → relevant', imageRelevance({ title: '萌新', text: '看图', images }) === 'relevant');
  t('正文长且明确 → decorative', imageRelevance({ title: '分享', text: '今天天气不错出去玩了'.repeat(12), images }) === 'decorative');
  const mid = '今天终于把这个植物抽到了感觉还不错属性挺高的就是升级材料有点缺慢慢攒吧不急';
  t('中等正文默认按相关', imageRelevance({ title: '晒一下', text: mid, images }) === 'relevant');
  t('unknownAsRelevant=false → unknown', imageRelevance({ title: '晒一下', text: mid, images }, { image: { relevanceGate: { unknownAsRelevant: false } } }) === 'unknown');
}

console.log('\n== loadTemplates（PVZ2 模板库留在本 skill）==');
{
  const { templates, defs, dir } = loadTemplates({});
  t('读到特征定义', defs.length >= 1);
  t('含钻石特征', defs.some((d) => d.id === 'diamond' && d.name === '钻石'));
  t('dir 指向 assets/game-features', dir.replace(/\\/g, '/').endsWith('assets/game-features'));
  t('转成识图 skill 要的 templates 格式', templates.length >= 1 && templates[0].image.length > 50);
  t('templates 带 threshold', typeof templates[0].threshold === 'number');
}

console.log('\n== enrichPostImages（业务门控 + 回灌）==');
{
  const cfg = { image: { enabled: true, features: { enabled: false } } };
  const base = { config: cfg, title: '这个活动奖励是什么', text: '看图' };

  const r1 = await enrichPostImages(item([img()]), { ...base, recognize: fakeRecognize() });
  t('识别 → 回灌文本含[图片内容]', r1.text.includes('[图片内容]') && r1.text.includes('紫手套碎片'));
  t('imageText 单独保留', r1.imageText.includes('钻石×334'));
  t('sources 记录', r1.sources.includes('ocr'));
  t('relevance=relevant', r1.relevance === 'relevant');
  t('skipped 为空', r1.skipped === '');

  const r2 = await enrichPostImages(item([]), { ...base, recognize: fakeRecognize() });
  t('无图 → no-image，文本不变', r2.skipped === 'no-image' && r2.text === '看图');

  const r3 = await enrichPostImages(item([img()]), { ...base, title: '蹲一个天宫码', text: '求码', recognize: fakeRecognize() });
  t('码意图 → code-intent 跳过', r3.skipped.startsWith('code-intent') && r3.text === '求码');

  const r4 = await enrichPostImages(item([img()]), { ...base, title: '分享', text: '今天天气不错出去玩了'.repeat(12), recognize: fakeRecognize() });
  t('无关配图 → decorative 跳过', r4.skipped === 'decorative');

  const r5 = await enrichPostImages(item([img()]), { ...base, config: { image: { enabled: false } }, recognize: fakeRecognize() });
  t('开关关闭 → disabled', r5.skipped === 'disabled');

  const r6 = await enrichPostImages(item([img()]), { ...base, recognize: async () => { throw new Error('boom'); } });
  t('识别异常 → error 降级，文本不变', r6.skipped.startsWith('error:') && r6.text === '看图');

  const r7 = await enrichPostImages(item([img()]), {
    ...base,
    recognize: async () => ({ ok: true, results: [], meta: { degraded: ['ocr:img1:HTTP 500'] } }),
  });
  t('识别空 → empty-recognition 带原因', r7.skipped.startsWith('empty-recognition') && r7.skipped.includes('ocr'));

  const r8 = await enrichPostImages(item([img()]), {
    ...base,
    recognize: async () => ({ ok: false, error: 'no images' }),
  });
  t('识图 skill ok:false → error 降级', r8.skipped.startsWith('error:'));
}

console.log('\n== 模板命中 → entities / celebrate ==');
{
  const cfg = { image: { enabled: true, features: { enabled: true } } };
  const rec = fakeRecognize({
    textOut: '',
    features: [{ id: 'tile_turnip_card', name: '瓷砖萝卜', method: 'template', score: 0.93 }],
    desc: '画面是植物卡片',
  });
  const r = await enrichPostImages(item([img()]), { config: cfg, title: '终于有了', text: '看图', recognize: rec });
  t('entities 透传', r.entities.includes('瓷砖萝卜'));
  t('trigger=celebrate 特征 → celebrate', r.celebrate === true);
  t('模板命中进 sources', r.sources.includes('template'));
  t('描述进 imageText', r.imageText.includes('植物卡片'));

  const rec2 = fakeRecognize({ textOut: '普通文字', features: [], desc: '' });
  const r2 = await enrichPostImages(item([img()]), { config: cfg, title: '问', text: '看图', recognize: rec2 });
  t('无 celebrate 特征 → 不celebrate', r2.celebrate === false);
  t('无模板命中 entities 空', r2.entities.length === 0);
}

console.log('\n== 识图 skill 缺失时静默跳过 ==');
{
  const prev = process.env.DSH_IMAGE_RECOGNITION;
  process.env.DSH_IMAGE_RECOGNITION = 'none';
  const m = await import('./lib/image-recognition.mjs?noskill=1');
  m._resetForTest();
  const r = await m.enrichPostImages(item([img()]), { title: '看图', text: '看图' });
  t('缺识图 skill → skipped=no-image-skill', r.skipped === 'no-image-skill');
  t('缺识图 skill → 文本原样返回', r.text === '看图');
  t('缺识图 skill → 不抛错', Boolean(r));
  if (prev === undefined) delete process.env.DSH_IMAGE_RECOGNITION;
  else process.env.DSH_IMAGE_RECOGNITION = prev;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);