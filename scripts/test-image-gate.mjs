// 图片流水线门控离线测试（S1/S2/S5，2026-11-16）
// 全部离线：注入假识别器，不打网络、不起 Python。
// 跑：node scripts/test-image-gate.mjs
import { extractImages } from './lib/http.mjs';
import { isCodeIntent, imageRelevance, enrichPostImages } from './lib/image.mjs';

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

console.log('\n== enrichPostImages（流水线 + 规则3回灌）==');
{
  const fakeRec = async () => ({ text: '获得奖励：紫手套碎片×15、钻石×334；狂欢嘉年华活动', sources: ['vlm'] });
  const cfg = { image: { enabled: true } };
  const base = { config: cfg, title: '这个活动奖励是什么', text: '看图', recognize: fakeRec };

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);