// 资料库读取/匹配测试（2026-11-26）
import { parseDoc, splitSections, matchMaterials, formatMaterials, slangOf, loadMaterials } from './lib/qa-materials.mjs';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let ok = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) {
    ok++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? '  ← ' + extra : ''}`);
  }
}

const SAMPLE = `---
id: doc-duel-mode
title: 双人对决
type: mechanism
keywords: [双人对决, 对战, 不同步]
scope: 6.2 版本
updated: 2026-11-26
confidence: 95
---

## 不同步已修
6.2 版本重构局内通讯逻辑。

## 对手数据来源
名字头像植物分数可能来自不同玩家的历史数据。
`;

console.log('\n== 解析 ==');
{
  const d = parseDoc(SAMPLE);
  t('解析 id', d.id === 'doc-duel-mode');
  t('解析 title', d.title === '双人对决');
  t('解析 type', d.type === 'mechanism');
  t('解析 keywords', d.keywords.length === 3 && d.keywords[0] === '双人对决');
  t('解析 scope', d.scope === '6.2 版本');
  t('解析 confidence', d.confidence === 95);
  t('分节 2 个', d.sections.length === 2);
  t('节标题正确', d.sections[0].title === '不同步已修');
  t('节内容非空', d.sections[0].content.includes('通讯逻辑'));
}

console.log('\n== 分节 ==');
{
  const s = splitSections('## A\n内容A\n\n## B\n内容B');
  t('两节', s.length === 2);
  t('标题 A', s[0].title === 'A');
  t('内容 B', s[1].content === '内容B');
  t('无 ## 返回空', splitSections('没有小节').length === 0);
}

console.log('\n== 匹配 ==');
{
  const docs = [
    parseDoc(SAMPLE),
    parseDoc(`---
id: doc-panini
title: 潘妮秘宝
type: mechanism
keywords: [潘妮秘宝, 心仪植物, 奖池刷新]
---

## 刷新节奏
每 2 个月更新一次。
`),
  ];

  const hit1 = matchMaterials('双人对决不同步什么时候修', docs);
  t('命中双人对决', hit1.length >= 1 && hit1[0].doc.id === 'doc-duel-mode');
  t('挑出相关节', hit1[0].sections.some((s) => s.title.includes('不同步')));

  const hit2 = matchMaterials('潘妮秘宝多久刷新一次', docs);
  t('命中潘妮秘宝', hit2.length >= 1 && hit2[0].doc.id === 'doc-panini');

  const hit3 = matchMaterials('今天天气怎么样', docs);
  t('无关问法不命中', hit3.length === 0);

  const hit4 = matchMaterials('', docs);
  t('空问法不命中', hit4.length === 0);
}

console.log('\n== 格式化 ==');
{
  const docs = [parseDoc(SAMPLE)];
  const hits = matchMaterials('双人对决不同步', docs);
  const txt = formatMaterials(hits);
  t('带【资料】标记', txt.includes('【资料｜双人对决'));
  t('带 scope', txt.includes('6.2 版本'));
  t('带节标题', txt.includes('不同步已修'));
}

console.log('\n== 黑话提取 ==');
{
  const docs = [
    parseDoc(`---
id: doc-glossary-plants
title: 植物缩写
type: glossary
keywords: [原大, 电大, 原葵]
---
## x
y`),
    parseDoc(SAMPLE),
  ];
  const slang = slangOf(docs);
  t('只提 glossary 的关键词', slang.includes('原大') && slang.includes('电大'));
  t('不含普通资料的词', !slang.includes('双人对决'));
}

console.log('\n== 目录加载 ==');
{
  const dir = await mkdtemp(join(tmpdir(), 'qa-mat-'));
  await writeFile(join(dir, 'doc-a.md'), SAMPLE, 'utf8');
  await writeFile(join(dir, 'README.md'), '# 说明\n不算资料', 'utf8');
  const list = await loadMaterials(dir);
  t('只加载 doc-*.md（跳过 README）', list.length === 1 && list[0].id === 'doc-duel-mode');
  t('目录不存在返回空', (await loadMaterials(join(dir, 'nope'))).length === 0);
}

console.log(`\n结果：${ok} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);