// T29 测试（2026-11-20）：@ 改真 mention 节点
//
// 官方 CLI 的接口规范（实测自 taptap-cli --help）：
//   行内支持 mention（info.id + info.name）、tap_emoji（info.id）
//   mention 结构：{ type:'mention', children:[{text:'@名字'}], info:{id, name} }
//
// 为什么要节点：纯文本 `@名字` 不触发对方通知、不可点击。
import { buildContentsWithMentions } from './lib/taptap-api.mjs';
import { replyTargetFor } from './lib/interact.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}
const parse = (json) => JSON.parse(json);
/** 取某个 paragraph 的 children */
const kids = (json, i = 0) => parse(json)[i].children;

console.log('\n== 基本：@名字 → mention 节点 ==');
{
  const r = buildContentsWithMentions('@狐玖儿 图里10/10', [{ id: '758092498', name: '狐玖儿' }]);
  t('mentionHit=1', r.mentionHit === 1, `实际 ${r.mentionHit}`);
  const c = kids(r.json);
  t('第一个是 mention 节点', c[0].type === 'mention', JSON.stringify(c[0]));
  t('type=mention', c[0].type === 'mention');
  t('children[0].text=@名字', c[0].children?.[0]?.text === '@狐玖儿');
  t('info.id=user_id', c[0].info?.id === '758092498');
  t('info.name=昵称', c[0].info?.name === '狐玖儿');
  t('后面是普通文字', c[1]?.text === ' 图里10/10', JSON.stringify(c[1]));
  t('纯文本里不再残留 @狐玖儿', !r.json.includes('"@狐玖儿"},'), r.json.slice(0, 200));
}

console.log('\n== 关键：不会出现两个 @ ==');
{
  // 模型不听话写了 @，或脚本重复拼 —— 节点结构下同一名字只应有一个节点
  const r = buildContentsWithMentions('@狐玖儿 @狐玖儿 你好', [{ id: '758092498', name: '狐玖儿' }]);
  const c = kids(r.json);
  const mentions = c.filter((x) => x.type === 'mention');
  t('只生成 1 个 mention 节点', mentions.length === 1, `实际 ${mentions.length}`);
  t('mentionHit=1', r.mentionHit === 1, `实际 ${r.mentionHit}`);
  t('剩余文本没有多余 @', !/@狐玖儿 @狐玖儿/.test(c.map((x) => x.text || '').join('')), JSON.stringify(c.map((x) => x.text)));
}

console.log('\n== 不同名字各一次 ==');
{
  const r = buildContentsWithMentions('@A 和 @B 都说了', [{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
  const c = kids(r.json);
  const mentions = c.filter((x) => x.type === 'mention');
  t('生成 2 个 mention 节点', mentions.length === 2, `实际 ${mentions.length}`);
  t('mentionHit=2', r.mentionHit === 2);
  t('两个 id 都对', mentions.map((m) => m.info.id).sort().join(',') === '1,2');
}

console.log('\n== 缺 id → 降级纯文本（内容不丢） ==');
{
  const r = buildContentsWithMentions('@狐玖儿 你好', [{ id: '', name: '狐玖儿' }]);
  const c = kids(r.json);
  t('没有 mention 节点', !c.some((x) => x.type === 'mention'));
  t('mentionHit=0', r.mentionHit === 0);
  t('文本保留 @狐玖儿', c.map((x) => x.text || '').join('').includes('@狐玖儿'));
}

console.log('\n== 与表情共存 ==');
{
  const emojiMap = { 酷: { id: 72 } };
  const r = buildContentsWithMentions('@狐玖儿 真酷[表情_酷]', [{ id: '758092498', name: '狐玖儿' }], emojiMap);
  const c = kids(r.json);
  t('emojiHit=1', r.emojiHit === 1, `实际 ${r.emojiHit}`);
  t('mentionHit=1', r.mentionHit === 1);
  t('同时有 mention 和 tap_emoji', c.some((x) => x.type === 'mention') && c.some((x) => x.type === 'tap_emoji'));
  const e = c.find((x) => x.type === 'tap_emoji');
  t('表情 info.id 正确', e.info?.id === 72);
}

console.log('\n== 名字含特殊字符 ==');
{
  const r = buildContentsWithMentions('@哲学家尼采（杯哲） 说得好', [{ id: '395809907', name: '哲学家尼采（杯哲）' }]);
  const c = kids(r.json);
  t('生成 mention 节点', c.some((x) => x.type === 'mention'), JSON.stringify(c));
  t('info.name 完整', c.find((x) => x.type === 'mention')?.info?.name === '哲学家尼采（杯哲）');
}
{
  // 长名字优先匹配，避免「张三」吃掉「张三丰」
  const r = buildContentsWithMentions('@张三丰 好', [{ id: '1', name: '张三' }, { id: '2', name: '张三丰' }]);
  const m = kids(r.json).find((x) => x.type === 'mention');
  t('长名优先', m?.info?.id === '2', JSON.stringify(m));
}

console.log('\n== 无 @ / 空输入 ==');
{
  const r = buildContentsWithMentions('普通回复', []);
  t('无 mention', r.mentionHit === 0);
  t('是纯文本节点', kids(r.json)[0].type === undefined, JSON.stringify(kids(r.json)[0]));
  const r2 = buildContentsWithMentions('', [{ id: '1', name: 'A' }]);
  t('空串不炸', typeof r2.json === 'string');
  t('空串至少一个 paragraph', parse(r2.json).length >= 1);
}

console.log('\n== 多行 ==');
{
  const r = buildContentsWithMentions('@A 第一行\n第二行', [{ id: '1', name: 'A' }]);
  const p = parse(r.json);
  t('拆成 2 段', p.length === 2, `实际 ${p.length}`);
  t('第一段含 mention', p[0].children.some((x) => x.type === 'mention'));
  t('第二段是纯文本', p[1].children[0].text === '第二行');
}

console.log('\n== replyTargetFor：带上 mentionId ==');
{
  const t1 = replyTargetFor({ level: 1, commentId: 'c9', author: 'A', authorId: '111' });
  t('一级回复：不 @ 别人', t1.mention === '' && t1.mentionId === '');
  const t2 = replyTargetFor({ level: 2, commentId: 'c1-1', parentId: 'c1', author: '小明', authorId: '888' });
  t('楼中楼：mention=名字', t2.mention === '小明');
  t('楼中楼：mentionId=user_id', t2.mentionId === '888', JSON.stringify(t2));
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);