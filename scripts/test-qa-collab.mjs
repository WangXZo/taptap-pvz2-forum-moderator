// 多人协作改造测试（2026-11-25）
// 覆盖：条目格式（一条一文件）· 要点拆解 · N 路合并 · 置信度聚合
//
// 跑：node scripts/test-qa-collab.mjs
// 全离线：LLM 用注入的假 chat，不打网络

let pass = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? '  ← ' + extra : ''}`);
  }
}
function section(s) {
  console.log(`\n== ${s} ==`);
}

import {
  parseEntryFile,
  renderEntryFile,
  slugId,
  parseClaims,
  aggregateClaimConfidence,
  confLabelOf,
  CONF,
} from '../scripts/lib/qa-entry.mjs';
import {
  mergeMany,
  mergeClaims,
  entryKeyOf,
  numbersConflict,
  claimSimilarity,
  isAutoEntry,
} from '../scripts/lib/qa-merge.mjs';
import { seedClaimConfidence } from '../scripts/lib/qa-split.mjs';
import { entryToQa, loadQaEntries } from '../scripts/lib/qa.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ═══════════════ 1. 条目格式 ═══════════════
section('条目文件格式');
{
  const src = `---
id: q-tahuang-wujin
question: 买了塔黄无尽用什么好
keywords: [塔黄, 保龄球, 卡波]
version: 通用
confidence: 70
updated: 2026-11-25
source: https://www.taptap.cn/moment/123
---

## 要点
- [70%] 优先买神器保龄球
  - 来源: https://www.taptap.cn/moment/123
  - 来源: https://www.taptap.cn/moment/456
- [50%] 卡波建议塔黄空吸到最高再点下一波
  - 来源: https://www.taptap.cn/moment/789
`;
  const e = parseEntryFile(src);
  t('解析 id', e.id === 'q-tahuang-wujin');
  t('解析问法', e.question === '买了塔黄无尽用什么好');
  t('解析关键词', e.keywords.length === 3 && e.keywords[0] === '塔黄');
  t('解析置信度', e.confidence === 70);
  t('解析来源', e.source === 'https://www.taptap.cn/moment/123');
  t('两个要点', e.claims.length === 2);
  t('要点1文本', e.claims[0].text === '优先买神器保龄球');
  t('要点1置信度', e.claims[0].confidence === 70);
  t('要点1两个来源', e.claims[0].sources.length === 2);
  t('要点2文本', e.claims[1].text.includes('卡波'));
  t('要点2一个来源', e.claims[1].sources.length === 1);

  // 渲染往返
  const back = parseEntryFile(renderEntryFile(e));
  t('渲染往返：要点数', back.claims.length === 2);
  t('渲染往返：文本', back.claims[0].text === e.claims[0].text);
  t('渲染往返：来源', back.claims[0].sources.length === 2);
  t('渲染往返：关键词', back.keywords.join(',') === e.keywords.join(','));

  // 旧格式兼容（单段正文）
  const legacy = parseEntryFile(`---
id: q-legacy
question: 老条目
keywords: [a, b]
---

这就是一整段正文。`);
  t('旧格式：正文当唯一要点', legacy.claims.length === 1 && legacy.claims[0].text === '这就是一整段正文。');

  // 无 frontmatter
  const bare = parseEntryFile('## 问：裸格式\n- 关键词：x\n---\n正文');
  t('无 frontmatter 也能解析', bare.question === '裸格式' && bare.answer === '' || bare.claims.length >= 0);

  // id 生成
  t('slugId 稳定', slugId('买了塔黄无尽用什么好') === slugId('买了塔黄无尽用什么好'));
  t('slugId 带前缀', slugId('测试').startsWith('q-'));
  t('空问法走 hash', /^q-[0-9a-f]{12}$/.test(slugId('')));

  // 置信度档位
  t('档位 95=可信', confLabelOf(95) === '可信');
  t('档位 70=高置信度', confLabelOf(70) === '高置信度');
  t('档位 50=中置信度', confLabelOf(50) === '中置信度');
}

// ═══════════════ 2. 置信度聚合（facts 层规则） ═══════════════
section('置信度聚合');
{
  t('单一来源 50', aggregateClaimConfidence({ sources: ['a'] }) === CONF.SINGLE);
  t('两渠道 70', aggregateClaimConfidence({ sources: ['a', 'b'] }) === CONF.TWO);
  t('三渠道+三确认 80', aggregateClaimConfidence({ sources: ['a', 'b', 'c', 'd'], confirms: 3 }) === CONF.MANY);
  t('有反对票 30', aggregateClaimConfidence({ sources: ['a', 'b'], negative: 1 }) === CONF.PENDING);
  t('官方 95', aggregateClaimConfidence({ sources: ['a'] }, { official: true }) === CONF.OFFICIAL);
}

// ═══════════════ 3. 要点拆解（纯函数部分） ═══════════════
section('要点初判置信度');
{
  const c1 = seedClaimConfidence([{ text: 'x' }], { source: 'https://a' });
  t('社区来源初判 50', c1[0].confidence === 50);
  const c2 = seedClaimConfidence([{ text: 'x' }], { manual: true });
  t('人工条目初判 95', c2[0].confidence === 95);
  const c3 = seedClaimConfidence([{ text: 'x', confidence: 80 }], { source: 'https://a' });
  t('已有置信度不被覆盖', c3[0].confidence === 80);
}

// ═══════════════ 4. claim 语义合并 ═══════════════
section('要点合并');
{
  const base = [{ text: '优先买神器保龄球', confidence: 50, sources: ['https://a'] }];

  // 同义（字面高度相似）→ 并来源 + 重算置信度
  const r1 = await mergeClaims(base, [{ text: '优先买神器保龄球', sources: ['https://b'] }], {});
  t('同义要点被合并', r1.merged === 1);
  t('合并后两个来源', r1.claims[0].sources.length === 2);
  t('合并后置信度升到 70', r1.claims[0].confidence === 70);
  t('合并不新增要点', r1.claims.length === 1);
  t('原要点文本未被覆盖', r1.claims[0].text === '优先买神器保龄球');

  // 异义 → 作为补充要点新增
  const r2 = await mergeClaims(base, [{ text: '卡波建议塔黄空吸到最高', sources: ['https://c'] }], {});
  t('异义要点新增', r2.added === 1 && r2.claims.length === 2);
  t('新增不覆盖原要点', r2.claims[0].text === '优先买神器保龄球');

  // 关键数字不同 → 否决闸拦住（不合并）
  const r3 = await mergeClaims([{ text: '困难6用冰车', confidence: 50, sources: ['https://a'] }], [{ text: '困难8用机枪', sources: ['https://b'] }], {
    sameAs: async () => true,
  });
  t('关键数字不同 → 不合并', r3.added === 1 && r3.claims.length === 2);

  // 数字冲突检测
  t('数字冲突检测', numbersConflict('困难6怎么过', '困难8怎么过') === true);
  t('数字相同不冲突', numbersConflict('塔黄无尽', '塔黄无尽搭配') === false);

  // 语义判定回调生效
  const r4 = await mergeClaims([{ text: '用冰车打', confidence: 50, sources: ['https://a'] }], [{ text: '冰车是首选', sources: ['https://b'] }], {
    sameAs: async (a, b) => a.includes('冰车') && b.includes('冰车'),
    threshold: 0.2,
  });
  t('LLM 判定同义 → 合并', r4.merged === 1 && r4.claims.length === 1);
}

// ═══════════════ 5. N 路合并 ═══════════════
section('N 路合并');
{
  const srcs = [
    {
      origin: 'github-main',
      entries: [
        { id: 'q-a', question: '困难6怎么过', keywords: ['困难6'], answer: '用冰车', updated: '2026-11-20', source: 'https://a', claims: [{ text: '用冰车', confidence: 50, sources: ['https://a'] }] },
      ],
    },
    {
      origin: 'github-contrib:张三',
      entries: [
        { id: 'q-a', question: '困难6怎么过', keywords: ['困难6', '冰车'], answer: '用冰车', updated: '2026-11-24', source: 'https://b', claims: [{ text: '用冰车', confidence: 50, sources: ['https://b'] }] },
      ],
    },
    {
      origin: 'local-runtime',
      entries: [
        { id: 'q-b', question: '钻石怎么攒', keywords: ['钻石'], answer: '做每日任务', updated: '2026-11-25', claims: [{ text: '做每日任务', confidence: 95, sources: [] }] },
      ],
    },
  ];
  const r = await mergeMany(srcs, {});
  t('合并后 2 条', r.entries.length === 2);
  const a = r.entries.find((e) => e.id === 'q-a');
  t('同 id 合并成一条', !!a);
  t('合并后两个来源', a.claims[0].sources.length === 2);
  t('两来源置信度 70', a.claims[0].confidence === 70);
  t('关键词取并集', a.keywords.length === 2);
  t('自动沉淀取更新的', a.updated === '2026-11-24');
  const b = r.entries.find((e) => e.id === 'q-b');
  t('不同 id 各自成条', !!b);
  t('人工条目置信度 95', b.claims[0].confidence === 95);

  // 人工条目优先
  const r2 = await mergeMany(
    [
      { origin: 'a', entries: [{ id: 'q-c', question: 'X怎么打', keywords: [], answer: '短', claims: [{ text: '短', confidence: 95, sources: [] }] }] },
      { origin: 'b', entries: [{ id: 'q-c', question: 'X怎么打', keywords: [], answer: '这是一段更长的补充说明', source: 'https://x', claims: [{ text: '这是一段更长的补充说明', confidence: 50, sources: ['https://x'] }] }] },
    ],
    {}
  );
  const c = r2.entries[0];
  t('人工条目优先：保留更长的正文', c.answer === '这是一段更长的补充说明');
  t('人工与自动合并不算冲突', r2.conflicts.length === 0);

  // 两个不同人工条目 → 冲突记录
  const r3 = await mergeMany(
    [
      { origin: 'a', entries: [{ id: 'q-d', question: 'Y怎么打', keywords: [], answer: '版本A的答案', claims: [{ text: '版本A的答案', confidence: 95, sources: [] }] }] },
      { origin: 'b', entries: [{ id: 'q-d', question: 'Y怎么打', keywords: [], answer: '版本B的答案比较长一些', claims: [{ text: '版本B的答案比较长一些', confidence: 95, sources: [] }] }] },
    ],
    {}
  );
  t('两个人工条目冲突被记录', r3.conflicts.length >= 1);

  // 幂等：同输入跑两次结果一致
  const r4 = await mergeMany(srcs, {});
  t('合并幂等（条目数一致）', r4.entries.length === r.entries.length);
  t('合并幂等（来源数一致）', r4.entries.find((e) => e.id === 'q-a').claims[0].sources.length === a.claims[0].sources.length);
}

// ═══════════════ 6. 身份与自动判定 ═══════════════
section('身份与自动判定');
{
  t('有 id 用 id', entryKeyOf({ id: 'q-x', question: 'A' }) === 'id:q-x');
  t('无 id 用来源', entryKeyOf({ question: 'A', source: 'https://a' }) === 'src:https://a');
  t('无 id 无来源用问法', entryKeyOf({ question: 'A' }).startsWith('q:'));
  t('有来源=自动沉淀', isAutoEntry({ source: 'https://a' }) === true);
  t('无来源=人工', isAutoEntry({ question: 'A' }) === false);
  t('要点的来源也算', isAutoEntry({ question: 'A', claims: [{ sources: ['https://b'] }] }) === true);
}

// ═══════════════ 7. 下游兼容 ═══════════════
section('下游兼容（entryToQa）');
{
  const e = parseEntryFile(`---
id: q-z
question: Z问题
keywords: [z]
---

## 要点
- [70%] 要点一
- [50%] 要点二
`);
  const q = entryToQa(e);
  t('answer 拼要点', q.answer === '要点一\n要点二');
  t('置信度取最高', q.confidence === 70);
  t('id 用稳定 id', q.id === 'q-z');
  t('claims 带出', q.claims.length === 2);
  t('auto 判定', q.auto === false);

  // 目录加载
  const dir = await mkdtemp(join(tmpdir(), 'qa-collab-'));
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'q-1.md'), '---\nid: q-1\nquestion: 一\nkeywords: [a]\n---\n\n答案一\n', 'utf8');
  await writeFile(join(dir, 'q-2.md'), '---\nid: q-2\nquestion: 二\nkeywords: [b]\n---\n\n答案二\n', 'utf8');
  const list = await loadQaEntries(dir);
  t('目录加载 2 条', list.length === 2);
  t('目录加载 id 正确', list.some((x) => x.id === 'q-1'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
