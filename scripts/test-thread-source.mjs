// 线程数据源测试（2026-11-20）：官方 CLI 优先 + 旧接口降级
import { adaptCliReply, adaptCliThread, createThreadSource } from './lib/thread-source.mjs';
import { commentText } from './lib/signature.mjs';
import { flattenContents } from './lib/http.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

/** 官方真实返回样本（取自 2026-11-20 实测） */
const cliReply = {
  comment_id: '405671600',
  content: '图里猕猴桃才10/10…… 「版主助手-小鲸鱼」[tapemoji=96][/tapemoji]',
  contents_json: JSON.stringify([
    { type: 'paragraph', children: [
      { text: '图里猕猴桃才10/10…… 「版主助手-小鲸鱼」' },
      { type: 'tap_emoji', children: [{ text: '[表情_疑惑]' }], info: { id: 96 } },
    ] },
  ]),
  author: { name: '示例用户A', user_id: '1000001', avatar: 'a.png', url: 'u' },
  created_time: 1795067295,
  images: [],
  pinned: false,
  reply_to: null,
  ups: 0,
};

console.log('\n== adaptCliReply ==');
const a = adaptCliReply(cliReply);
t('id_str ← comment_id', a.id_str === '405671600');
t('author.name', a.author.name === '示例用户A');
t('author.id ← user_id', a.author.id === '1000001');
t('created_time 保留', a.created_time === 1795067295);
t('child_posts 初始化空', Array.isArray(a.child_posts) && a.child_posts.length === 0);
t('contents.json 是数组', Array.isArray(a.contents.json));
t('保留 content_raw', a.content_raw.includes('tapemoji'));
{
  // 关键：commentText / flattenContents 必须能从转换后结构取到字
  const txt = commentText(a);
  t('commentText 取到正文', txt.includes('图里猕猴桃才10/10'), txt.slice(0, 40));
  t('commentText 带表情标记', txt.includes('[表情_疑惑]'), txt);
  t('flattenContents 直接可用', flattenContents(a.contents).includes('猕猴桃'));
}

console.log('\n== adaptCliReply：异常输入 ==');
{
  const bad = adaptCliReply({ comment_id: 'x', contents_json: 'not-json', content: '兜底文本' });
  t('contents_json 坏 → 用 content 兜底', commentText(bad) === '兜底文本', commentText(bad));
}
{
  const empty = adaptCliReply({ comment_id: 'y' });
  t('全空 → 空文本不炸', commentText(empty) === '');
  t('reply_to 为 null', empty.reply_to === null);
}
{
  const rt = adaptCliReply({ comment_id: 'z', reply_to: { name: '狐玖儿', user_id: '758092498' } });
  t('reply_to 转换', rt.reply_to.name === '狐玖儿' && rt.reply_to.id === '758092498');
}

console.log('\n== adaptCliThread ==');
const replies = [
  { comment_id: 'c1', contents_json: '[]', content: '一级1', author: { name: 'A', user_id: '1' },
    child_replies: [
      { comment_id: 'c1-1', contents_json: '[]', content: '子1', author: { name: 'B', user_id: '2' } },
      { comment_id: 'c1-2', contents_json: '[]', content: '子2', author: { name: 'C', user_id: '3' } },
      { comment_id: 'c1-3', contents_json: '[]', content: '@狐玖儿 @狐玖儿 双@样本', author: { name: 'D', user_id: '4' } },
    ] },
  { comment_id: 'c2', contents_json: '[]', content: '一级2', author: { name: 'E', user_id: '5' }, child_replies: [] },
];
const adapted = adaptCliThread(replies);
t('一级 2 条', adapted.length === 2);
t('c1 子回复 3 条（全量，非 2 条截断）', adapted[0].child_posts.length === 3, `实际 ${adapted[0].child_posts.length}`);
t('子回复带 __parentId', adapted[0].child_posts[0].__parentId === 'c1');
t('c2 无子回复', adapted[1].child_posts.length === 0);
t('双@样本保留原文', adapted[0].child_posts[2].content_raw.includes('@狐玖儿 @狐玖儿'));

console.log('\n== createThreadSource：CLI 优先 ==');
{
  const fakeCli = { listThread: async () => ({ ok: true, replies, total: 2, childTotal: 3 }) };
  const legacyCalls = [];
  const src = createThreadSource({
    cli: fakeCli,
    config: { appId: 54031, taptapCli: { enabled: true } },
    log: () => {},
    legacyList: async (o) => { legacyCalls.push(o); return { list: [] }; },
  });
  const r = await src.load({ momentId: '9' });
  t('source=cli', r.source === 'cli');
  t('comments 2 条', r.comments.length === 2);
  t('childTotal 透传', r.childTotal === 3);
  t('没走旧接口', legacyCalls.length === 0);
}

console.log('\n== createThreadSource：CLI 失败降级 ==');
{
  const fakeCli = { listThread: async () => ({ ok: false, error: 'permission_denied' }) };
  let legacyUsed = 0;
  const logs = [];
  const src = createThreadSource({
    cli: fakeCli,
    config: { appId: 54031, taptapCli: { enabled: true, fallbackToOpencli: true } },
    log: (m) => logs.push(m),
    legacyList: async () => { legacyUsed++; return { list: [{ id_str: 'legacy1' }] }; },
  });
  const r = await src.load({ momentId: '9' });
  t('降级到 legacy', r.source === 'legacy');
  t('旧接口被调用', legacyUsed === 1);
  t('拿到旧数据', r.comments.length === 1);
  t('打了降级日志', logs.some((m) => m.includes('回退旧接口')), JSON.stringify(logs));
}

console.log('\n== createThreadSource：开关与兜底 ==');
{
  // enabled=false → 直接用旧接口，不碰 CLI
  let cliUsed = 0;
  const src = createThreadSource({
    cli: { listThread: async () => { cliUsed++; return { ok: true, replies: [] }; } },
    config: { appId: 54031, taptapCli: { enabled: false } },
    legacyList: async () => ({ list: [{ id_str: 'L' }] }),
  });
  const r = await src.load({ momentId: '9' });
  t('enabled=false 不调 CLI', cliUsed === 0);
  t('enabled=false 走 legacy', r.source === 'legacy');
}
{
  // fallbackToOpencli=false → CLI 失败就不降级，明确返回 ok:false
  const src = createThreadSource({
    cli: { listThread: async () => ({ ok: false, error: 'boom' }) },
    config: { appId: 54031, taptapCli: { enabled: true, fallbackToOpencli: false } },
    legacyList: async () => ({ list: [{ id_str: 'L' }] }),
  });
  const r = await src.load({ momentId: '9' });
  t('禁用降级 → ok:false', r.ok === false);
  t('禁用降级 → 不返回旧数据', r.comments.length === 0);
}
{
  // 旧接口本身抛错 → 安全返回
  const src = createThreadSource({
    cli: null,
    config: { appId: 54031 },
    legacyList: async () => { throw new Error('net down'); },
  });
  const r = await src.load({ momentId: '9' });
  t('旧接口炸 → ok:false 不抛出', r.ok === false && r.comments.length === 0);
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);