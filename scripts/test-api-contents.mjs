#!/usr/bin/env node
// 接口回复「内容格式」单测：段落拆分 / 表情节点 / 去标记 / id 提取
//
// 为什么值得测：这些格式错了**不会报错**——服务器照收，
// 只是玩家看到的是「签名黏在正文后面」或者一串字面文本 `[表情_开心]`。
// 静默错内容比抛异常更危险，所以钉死。

import {
  buildContents,
  buildContentsWithEmoji,
  stripEmojiMarks,
  momentIdFromUrl,
} from './lib/taptap-api.mjs';

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${name}\n    期望 ${b}\n    实际 ${a}`);
};
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

// ---------- 1. 段落拆分 ----------
eq('单行 → 1 段', buildContents('你好').length > 0 ? JSON.parse(buildContents('你好')).length : 0, 1);

const twoLines = JSON.parse(buildContents('正文内容\n\n「版主助手-小鲸鱼」'));
eq('正文+签名 → 2 段', twoLines.length, 2);
eq('第 1 段文字', twoLines[0].children[0].text, '正文内容');
eq('第 2 段文字', twoLines[1].children[0].text, '「版主助手-小鲸鱼」');
eq('节点类型都是 paragraph', [...new Set(twoLines.map((n) => n.type))], ['paragraph']);

const threeLines = JSON.parse(buildContents('a\nb\nc'));
eq('三个单行 → 3 段', threeLines.length, 3);

const blank = JSON.parse(buildContents('   \n\n  '));
eq('全空白 → 1 段空文本', blank.length, 1);
eq('全空白段落文本为空', blank[0].children[0].text, '');

// ---------- 2. 表情节点 ----------
const map = { 比心: { id: 99, url: 'https://x/e.gif' }, 星星眼: { id: 88, url: '' } };

const withEmoji = buildContentsWithEmoji('有你在就好了[表情_比心]\n\n「版主助手-小鲸鱼」', map);
eq('表情回复 → 2 段', JSON.parse(withEmoji.json).length, 2);
eq('表情命中数', withEmoji.emojiHit, 1);

const p1 = JSON.parse(withEmoji.json)[0];
const emojiNode = p1.children.find((c) => c.type === 'tap_emoji');
ok('生成了 tap_emoji 节点', Boolean(emojiNode));
eq('表情节点 identifier', emojiNode?.children?.[0]?.text, '[表情_比心]');
eq('表情节点 id', emojiNode?.info?.id, 99);
eq('表情节点 url', emojiNode?.info?.url, 'https://x/e.gif');
eq('表情前有正文', p1.children[0].text, '有你在就好了');

const noUrl = buildContentsWithEmoji('好[表情_星星眼]', map);
eq('无 url 的表情不写 url 字段', JSON.parse(noUrl.json)[0].children[1].info.url, undefined);

// 表里没有的表情必须丢掉，不能变成字面文本
const unknown = buildContentsWithEmoji('你好[表情_不存在]呀', map);
eq('未知表情被丢弃', buildContentsWithEmoji('你好[表情_不存在]呀', map).emojiHit, 0);
const unknownTexts = JSON.parse(unknown.json)[0].children.map((c) => c.text).join('');
ok('未知表情不残留字面文本', !unknownTexts.includes('[表情_'), `实际：${unknownTexts}`);
eq('未知表情两侧文字都保留', unknownTexts, '你好呀');

// 只有表情、没有文字
const onlyEmoji = buildContentsWithEmoji('[表情_比心]', map);
eq('纯表情也能成段', JSON.parse(onlyEmoji.json).length, 1);

// ---------- 3. 去标记 ----------
eq('strip 去掉表情标记', stripEmojiMarks('好耶[表情_比心]'), '好耶');
eq('strip 去掉 TapTap× 标记', stripEmojiMarks('好耶[TapTap×某某_开心]'), '好耶');
eq('strip 保留普通方括号', stripEmojiMarks('见[公告]'), '见[公告]');
eq('strip 保留换行', stripEmojiMarks('甲\n\n乙'), '甲\n\n乙');

// ---------- 4. id 提取 ----------
eq('从链接取 momentId', momentIdFromUrl('https://www.taptap.cn/moment/864806259805654695'), '864806259805654695');
eq('带 query 也能取', momentIdFromUrl('https://www.taptap.cn/moment/865145863293372831?group_id=40173'), '865145863293372831');
eq('非帖子链接取不到', momentIdFromUrl('https://www.taptap.cn/app/54031'), '');

// ---------- 结果 ----------
console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
