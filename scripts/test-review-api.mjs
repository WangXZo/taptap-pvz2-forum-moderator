#!/usr/bin/env node
// 游戏评价接口单测（2026-11-13 新增）
//
// 覆盖：端点常量 / 参数规范化（含踩过的 400 坑）/ 纯文本载荷 / 结构摊平 / 落库校验。
// **全部离线** —— 用假 get/post 注入，不联网。
//
// 夹具用的是 2026-11-13 **真实验证过**的数据（review 51123606），不是编的。

import {
  REVIEW_LIST_PATH,
  REVIEW_COMMENTS_PATH,
  REVIEW_REPLY_PATH,
  REVIEW_LIMIT_MAX,
  REVIEW_ORDERS,
  normalizeListParams,
  normalizeCommentsParams,
  normalizeReview,
  reviewCommentText,
  buildReviewContents,
  reviewIdFromUrl,
  pickReviewComment,
  makeReviewApi,
} from './lib/review.mjs';

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${name}\n    期望 ${b}\n    实际 ${a}`);
};
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

const SIG = '「版主助手-小鲸鱼」';

// ---------- 真实夹具（2026-11-13 实测） ----------
const REAL_REVIEW = {
  id: 51123606,
  score: 1,
  played_spent: 11880,
  contents: {
    text: '我之前的号是OPPO渠道服的，这次特地下载的官服，就是为了换别的牌的手机也能使用，结果登录之后我的号又丢了，还老是闪退',
    raw_text: '我之前的号是OPPO渠道服的…',
  },
  review_comments: [
    {
      id: 36691583,
      contents: { text: '渠道之间的数据是不互通的，小僵僵如果想登录之前的账号需要下载之前的渠道包体才可以。' },
      is_official: true,
      author: { id: 325718297, name: '戴夫得不到的玉米卷' },
    },
  ],
  stage: 'publish',
  stage_label: '',
  source: 'taptap',
  total_played_spent: 11880,
};

const REAL_LIST_ITEM = {
  type: 'moment',
  identification: 'moment:870292567579689482',
  moment: {
    id_str: '870292567579689482',
    created_time: 1794546717,
    publish_time: 1794546717,
    commented_time: 1794556863,
    author: { user: { id: 802972706, name: '兑勾打团来' } },
    device: 'PC 客户端',
    review: REAL_REVIEW,
  },
};

// by-review 的真实返回（2 条：1 条官方 + 1 条我们自己的）
const REAL_COMMENTS = [
  {
    id: 36691583,
    contents: { text: '渠道之间的数据是不互通的，小僵僵如果想登录之前的账号需要下载之前的渠道包体才可以。' },
    raw_text: '',
    ups: 0,
    downs: 0,
    created_time: 1794549741,
    is_official: true,
    collapsed: false,
    author: { id: 325718297, name: '戴夫得不到的玉米卷' },
  },
  {
    id: 36692150,
    contents: { text: '还不如用taptap方便是吧！' },
    raw_text: '还不如用taptap方便是吧！',
    ups: 0,
    downs: 0,
    created_time: 1794556863,
    is_official: false,
    collapsed: false,
    author: { id: 63000064, name: '枫之****Zo' },
  },
];

// ---------- 1. 端点常量（照抄大哥给的 cURL） ----------
eq('列表端点', REVIEW_LIST_PATH, '/webapiv2/review/v2/list-by-app');
eq('回复端点', REVIEW_REPLY_PATH, '/webapiv2/review-comment/v1/create');
eq('读回复端点', REVIEW_COMMENTS_PATH, '/webapiv2/review-comment/v1/by-review');

// ---------- 2. 参数规范化 ----------
{
  const p = normalizeListParams({ appId: 54031 });
  eq('列表默认 limit', p.limit, 10);
  eq('列表默认 sort', p.sort, 'new');
  eq('列表 app_id 是字符串', p.app_id, '54031');
  eq('列表空字段照发', [p.label, p.mapping, p.source_type, p.stage_type, p.test_plan_id], ['', '', '', '', '']);
  eq('列表 limit 超上限被夹', normalizeListParams({ appId: 1, limit: 999 }).limit, REVIEW_LIMIT_MAX);
  eq('列表 limit 下限保护', normalizeListParams({ appId: 1, limit: 0 }).limit, 1);
  eq('列表 limit 非数字回落默认', normalizeListParams({ appId: 1, limit: 'abc' }).limit, 10);
}
{
  // ⚠️ 实测踩过的坑：order 必填(oneof)、limit 上限 10
  const p = normalizeCommentsParams({ reviewId: 51123606 });
  eq('读回复默认 order=desc', p.order, 'desc');
  eq('读回复默认 limit=10', p.limit, 10);
  eq('读回复默认 from=0', p.from, 0);
  eq('合法 order 保留', normalizeCommentsParams({ reviewId: 1, order: 'asc' }).order, 'asc');
  eq('非法 order 回落 desc', normalizeCommentsParams({ reviewId: 1, order: 'sideways' }).order, 'desc');
  eq('大写 order 归一', normalizeCommentsParams({ reviewId: 1, order: 'ASC' }).order, 'asc');
  eq('读回复 limit 超上限被夹', normalizeCommentsParams({ reviewId: 1, limit: 20 }).limit, REVIEW_LIMIT_MAX);
  eq('order 合法值表', REVIEW_ORDERS, ['asc', 'desc']);
  ok('limit 上限就是 10（实测 15/20 会 400）', REVIEW_LIMIT_MAX === 10);
}

// ---------- 3. 载荷是纯文本（跟论坛回复最大的差异） ----------
{
  eq('纯文本原样', buildReviewContents('还不错'), '还不错');
  eq('表情标记被剥掉', buildReviewContents('好耶[表情_比心]'), '好耶');
  eq('TapTap× 标记被剥掉', buildReviewContents('好耶[TapTap×某某_开心]'), '好耶');
  ok('不会产出富文本 JSON', !buildReviewContents('正文').trim().startsWith('['));
  eq('多行压成单行', buildReviewContents('第一行\n\n第二行'), '第一行 第二行');
  eq('普通方括号保留', buildReviewContents('见[公告]'), '见[公告]');
}

// ---------- 4. 结构摊平 ----------
{
  const r = normalizeReview(REAL_LIST_ITEM);
  eq('reviewId', r.reviewId, '51123606');
  eq('分数', r.score, 1);
  eq('评价人 id', r.authorId, '802972706');
  eq('评价人名字', r.authorName, '兑勾打团来');
  eq('评价链接', r.url, 'https://www.taptap.cn/review/51123606');
  ok('正文非空', r.text.includes('OPPO渠道服'));
  eq('预览回复数（只是子集）', r.previewComments.length, 1);

  // ⚠️ detail 接口的 data.review 是**空壳**，真正的在 data.moment.review
  eq('空壳 review 认出来是 null', normalizeReview({ review: {} }), null);
  eq('detail 形态也能摊平', normalizeReview({ moment: { review: REAL_REVIEW } }).reviewId, '51123606');
  eq('完全不认识的结构 → null', normalizeReview({}), null);
  eq('null 安全', normalizeReview(null), null);
}
{
  eq('回复正文（对象）', reviewCommentText(REAL_COMMENTS[1]), '还不如用taptap方便是吧！');
  eq('回复正文（字符串兜底）', reviewCommentText({ contents: '裸字符串' }), '裸字符串');
  eq('回复正文（空）', reviewCommentText({}), '');
}

// ---------- 5. 从链接取 id ----------
eq('从链接取 reviewId', reviewIdFromUrl('https://www.taptap.cn/review/51123606'), '51123606');
eq('非评价链接取不到', reviewIdFromUrl('https://www.taptap.cn/app/54031'), '');

// ---------- 6. 找到我们发的那条 ----------
{
  const hit = pickReviewComment(REAL_COMMENTS, '还不如用taptap方便是吧！');
  eq('命中我们那条', hit.found, true);
  eq('命中的是正确 id', hit.id, 36692150);
  eq('没命中时 found=false', pickReviewComment(REAL_COMMENTS, '完全不同的内容xyz').found, false);
  eq('空文本不误判', pickReviewComment(REAL_COMMENTS, '').found, false);
}

// ---------- 7. 四个动作（注入假 get/post） ----------
{
  const calls = { get: [], post: [] };
  const fakeGet = async (path, params) => {
    calls.get.push({ path, params });
    if (path === REVIEW_LIST_PATH) {
      return { ok: true, status: 200, json: { success: true, data: { list: [REAL_LIST_ITEM], total: 10000 } } };
    }
    if (path === REVIEW_COMMENTS_PATH) {
      return { ok: true, status: 200, json: { success: true, data: { list: REAL_COMMENTS, total: 2 } } };
    }
    return { ok: false, status: 404 };
  };
  const fakePost = async (path, form, opt) => {
    calls.post.push({ path, form, opt });
    return { ok: true, status: 200, json: { success: true, data: { id: 999 } } };
  };
  const api = makeReviewApi({ get: fakeGet, post: fakePost });

  // 列表
  const l = await api.reviewList({ appId: 54031 });
  eq('列表 ok', l.ok, true);
  eq('列表摊平后条数', l.list.length, 1);
  eq('列表 total', l.total, 10000);
  eq('列表打的是 list-by-app', calls.get[0].path, REVIEW_LIST_PATH);
  eq('列表参数带 app_id', calls.get[0].params.app_id, '54031');
  const noApp = await api.reviewList({});
  eq('缺 appId 直接报错不请求', [noApp.ok, noApp.error], [false, '缺少 appId']);

  // 读回复
  const c = await api.reviewComments({ reviewId: 51123606 });
  eq('读回复 ok', c.ok, true);
  eq('读回复条数', c.list.length, 2);
  const cp = calls.get[calls.get.length - 1].params;
  eq('读回复带 review_id', cp.review_id, '51123606');
  eq('读回复带 order', cp.order, 'desc');
  eq('读回复 limit 被夹到 10', cp.limit, 10);

  // 校验落库
  const v = await api.hasReviewReplyText({ reviewId: 51123606, text: '还不如用taptap方便是吧！' });
  eq('校验：找到我们那条', v.found, true);
  eq('校验：id 正确', v.id, 36692150);
  const v2 = await api.hasReviewReplyText({ reviewId: 51123606, text: '我们没发过的话xyz' });
  eq('校验：没发过 → false', v2.found, false);

  // 回复（写）
  const r = await api.reviewReply({
    reviewId: 51123606,
    text: '换渠道的话旧号要登回旧包体',
    signature: SIG,
  });
  eq('回复 ok', r.ok, true);
  const pc = calls.post[0];
  eq('回复打的是 create', pc.path, REVIEW_REPLY_PATH);
  eq('表单带 review_id', pc.form.review_id, '51123606');
  ok('contents 是纯文本不是 JSON', typeof pc.form.contents === 'string' && !pc.form.contents.startsWith('['));
  eq('正文内容正确', pc.form.contents, `换渠道的话旧号要登回旧包体 ${SIG}`);
  eq('runtimeEnv 用 release（照真实 cURL）', pc.opt.runtimeEnv, 'release');
  eq('回复返回也带回载荷', r.contents, pc.form.contents);

  // 签名不重复加
  await api.reviewReply({ reviewId: 51123606, text: `已经带签名了 ${SIG}`, signature: SIG });
  const pc2 = calls.post[calls.post.length - 1];
  eq('签名只出现一次', (pc2.form.contents.match(/版主助手-小鲸鱼/g) || []).length, 1);

  // 直接指定 contents 时不加签名
  await api.reviewReply({ reviewId: 51123606, text: '会被忽略', contents: '原样发出' });
  const pc3 = calls.post[calls.post.length - 1];
  eq('指定 contents 就原样用', pc3.form.contents, '原样发出');

  // 缺 review_id 不发
  const noId = await api.reviewReply({ text: 'x' });
  eq('缺 review_id 被拦下', [noId.ok, noId.stage], [false, 'no_review_id']);
}

// ---------- 8. 失败路径不崩 ----------
{
  const api = makeReviewApi({
    get: async () => ({ ok: false, status: 500 }),
    post: async () => ({ ok: false, status: 400, error: 'InvalidArgument' }),
  });
  const l = await api.reviewList({ appId: 1 });
  eq('列表失败 → ok=false', l.ok, false);
  const c = await api.reviewComments({ reviewId: 1 });
  eq('读回复失败 → ok=false', c.ok, false);
  const v = await api.hasReviewReplyText({ reviewId: 1, text: 'x' });
  eq('校验失败 → found=false', v.found, false);
  const r = await api.reviewReply({ reviewId: 1, text: 'x' });
  eq('回复失败 → ok=false', r.ok, false);
  const empty = await api.reviewComments({});
  eq('缺 review_id 被拦下', [empty.ok, empty.error], [false, '缺少 review_id']);
}

// ---------- 结果 ----------
console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
