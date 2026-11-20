// O4 facts 扩容离线测试（2026-11-18）：分类闸 + 提案渲染
import { classifyExtractions, renderProposal } from './lib/facts-expand.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const existing = [{ name: '钻石宝箱抽取', type: 'rule', attrs: { 688: '稀有宝箱十连' } }];

console.log('\n== 分类闸 ==');
{
  const r = classifyExtractions([
    // 官方 + 有 attrs → 入库 95
    { question: 'a', layer: 'fact', entity: '瓷砖萝卜', type: 'plant', attrs: { rarity: '稀有' }, confidence: 60, official: true, source: '官方公告' },
    // 社区高置信 → 入库原置信
    { question: 'b', layer: 'fact', entity: '紫手套', type: 'item', attrs: { 用途: '打联赛' }, confidence: 75, source: '社区帖' },
    // 社区低置信 → 跳过（留 QA）
    { question: 'c', layer: 'fact', entity: '某植物', type: 'plant', attrs: { x: 1 }, confidence: 50, source: '社区帖' },
    // 与现有冲突 → 待确认
    { question: 'd', layer: 'fact', entity: '钻石宝箱抽取', attrs: { 688: '单抽' }, confidence: 90, source: '社区帖' },
    // 与现有一致 → 跳过
    { question: 'e', layer: 'fact', entity: '钻石宝箱抽取', attrs: { 688: '稀有宝箱十连' }, confidence: 90, source: '社区帖' },
    // 无实体 → 待确认
    { question: 'f', layer: 'fact', entity: '', attrs: { a: 1 }, confidence: 90 },
    // attrs 空 → 待确认
    { question: 'g', layer: 'fact', entity: 'X', attrs: {}, confidence: 90 },
    // qa 层 → 跳过
    { question: 'h', layer: 'qa', entity: 'Y', attrs: { a: 1 } },
    // activity 带时效 → 入库且记 validUntilDays
    { question: 'i', layer: 'activity', entity: '双十一团购', type: 'event', attrs: { 位阶: '钻石位' }, confidence: 70, official: true, validUntilDays: 7 },
  ], { existing });

  t('官方 → 入库 95', r.applyList.find((x) => x.name === '瓷砖萝卜')?.confidence === 95);
  t('社区 75 → 入库原值', r.applyList.find((x) => x.name === '紫手套')?.confidence === 75);
  t('社区 50 → 跳过（留 QA）', r.skipped.some((x) => x.question === 'c'));
  t('与现有冲突 → 待确认', r.uncertain.some((x) => x.question === 'd' && x.why.includes('冲突')));
  t('与现有一致 → 跳过', r.skipped.some((x) => x.question === 'e' && x.why.includes('一致')));
  t('无实体名 → 待确认', r.uncertain.some((x) => x.question === 'f'));
  t('attrs 空 → 待确认', r.uncertain.some((x) => x.question === 'g'));
  t('qa 层 → 跳过', r.skipped.some((x) => x.question === 'h'));
  t('activity 记时效', r.applyList.find((x) => x.name === '双十一团购')?.validUntilDays === 7);
  t('可入库共 3 条', r.applyList.length === 3);
}

console.log('\n== 回归：不采信 LLM 单方面 official（2026-11-19 实测教训）==');
{
  const r = classifyExtractions([
    { question: 'q', layer: 'fact', entity: '瓷砖萝卜', type: 'plant', attrs: { 稀有度: '稀有' }, confidence: 60, official: true, source: 'https://www.taptap.cn/moment/123' },
  ], { existing: [] });
  t('社区 url + LLM 说 official → 不升 95 入库', r.applyList.length === 0 || r.applyList[0].confidence !== 95);
  t('置信 60<70 且非官方 → 跳过', r.skipped.length === 1);
  const r2 = classifyExtractions([
    { question: 'q', layer: 'fact', entity: '瓷砖萝卜', type: 'plant', attrs: { 稀有度: '稀有' }, confidence: 80, source: 'https://www.taptap.cn/moment/123' },
  ], { existing: [] });
  t('社区 80 → 入库但保持 80（不冒充电信 95）', r2.applyList[0]?.confidence === 80);
  const r3 = classifyExtractions([
    { question: 'q', layer: 'fact', entity: 'X', attrs: { 获得方式: '抽取' }, confidence: 90, source: '官方公告' },
  ], { existing: [] });
  t('attrs 值过泛 → 待确认而非入库', r3.uncertain.some((u) => u.why.includes('过泛')));
  const r4 = classifyExtractions([
    { question: 'q', layer: 'fact', entity: 'Y', attrs: { 概率: '5%' }, confidence: 90, source: '官方公告' },
  ], { existing: [] });
  t('数值型短值不算过泛', r4.applyList.length === 1);
}

console.log('\n== 回归：近似同名拦重复（2026-11-19 实测）==');
{
  const ex = [{ name: '植物阶数攻防', attrs: { perStage: '+50%' } }];
  const r = classifyExtractions([
    { question: 'q', layer: 'fact', entity: '植物阶级攻防成长规则', type: 'rule', attrs: { 增幅: '+50%', 例外: '胆小菇不同' }, confidence: 78, source: 'https://www.taptap.cn/moment/1' },
  ], { existing: ex });
  t('近似同名 → 待确认（不造重复 fact）', r.uncertain.some((u) => u.why.includes('疑似与现有 fact 同实体')));
  t('近似同名不入库', r.applyList.length === 0);
  const r2 = classifyExtractions([
    { question: 'q', layer: 'fact', entity: '瓷砖萝卜', type: 'plant', attrs: { 稀有度: '稀有' }, confidence: 80, source: '社区' },
  ], { existing: ex });
  t('不同实体正常入库', r2.applyList.length === 1);
  // 不误伤：不同实体的名字相似度低
  const ex2 = [{ name: '无尽挑战', attrs: { a: 1 } }];
  const r3 = classifyExtractions([
    { question: 'q', layer: 'fact', entity: '摇滚无尽', type: 'level', attrs: { 特点: '巨人最多' }, confidence: 80, source: '社区' },
  ], { existing: ex2 });
  t('无尽挑战 vs 摇滚无尽 不判同实体', r3.applyList.length === 1);
}

console.log('\n== 提案渲染 ==');
{
  const md = renderProposal({
    applyList: [{ name: '瓷砖萝卜', type: 'plant', attrs: { rarity: '稀有' }, confidence: 95, official: true, validUntilDays: null }],
    uncertain: [{ question: '冲突项', entity: 'X', why: '与现有 fact 冲突', attrs: {} }],
    skipped: [{ question: '低置', why: '置信 50<70' }],
    failed: 1, candidates: 5, date: new Date('2026-11-19'),
  });
  t('含标题日期', md.includes('facts 扩容提案 2026-11-19'));
  t('含统计行', md.includes('候选 5') && md.includes('可入库 1') && md.includes('待确认 1'));
  t('含入库表', md.includes('| 瓷砖萝卜 |') && md.includes('(官方)'));
  t('长期标注', md.includes('长期'));
  t('待确认段', md.includes('待大哥确认') && md.includes('冲突项'));
  t('跳过段', md.includes('置信 50<70'));
  t('空提案不崩', renderProposal({}).includes('_无候选_'));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);