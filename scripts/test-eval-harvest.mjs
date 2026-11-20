// O5 评测收割离线测试（2026-11-19）
import { dedupeCandidates, mergeIntoSet, candidateToCase, renderHarvestReport } from './lib/eval-harvest.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== dedupeCandidates ==');
{
  const existing = [{ postId: 'p1', title: '困难6怎么过' }];
  const cands = [
    { postId: 'p1', title: '重复帖子ID' },
    { postId: 'p2', title: '困难6怎么过' },        // 标题重复（归一化）
    { postId: 'p3', title: '新问题' },
    { postId: 'p4', title: '新问题' },             // 同批标题重复
  ];
  const out = dedupeCandidates(cands, existing);
  t('去重后只剩 1 条', out.length === 1);
  t('保留的是新标题那条', out[0].postId === 'p3');
}

console.log('\n== mergeIntoSet ==');
{
  const existing = [{ id: 'a' }, { id: 'b', permanent: true }];
  const r = mergeIntoSet(existing, [{ id: 'c' }, { id: 'd' }], { maxCases: 10 });
  t('正常合并不裁剪', r.cases.length === 4 && r.trimmed === 0 && r.added === 2);
  // 超限：permanent 必须保留
  const big = Array.from({ length: 8 }, (_, i) => ({ id: 'x' + i }));
  const r2 = mergeIntoSet([{ id: 'perm', permanent: true }, ...big], [{ id: 'new1' }, { id: 'new2' }], { maxCases: 5 });
  t('超限触发裁剪', r2.trimmed > 0 && r2.cases.length === 5);
  t('permanent 未被裁', r2.cases.some((c) => c.id === 'perm'));
  t('新用例优先保留', r2.cases.some((c) => c.id === 'new2'));
}

console.log('\n== candidateToCase ==');
{
  const c = candidateToCase({ postId: 'p9', title: '某个问题', text: '正文', reason: 'abstain_low_conf' }, { intent: 'qa', entryIncludes: '关卡打不过' });
  t('id 用 postId', c.id === 'p9');
  t('expect 带 intent+entryIncludes', c.expect.intent === 'qa' && c.expect.entryIncludes === '关卡打不过');
  t('标记来源 harvest', c.source === 'harvest');
  t('保留原因', c.reason === 'abstain_low_conf');
  const c2 = candidateToCase({ title: '无ID标题' }, {});
  t('无 postId 也能生成 id', Boolean(c2.id) && c2.id.length > 0);
}

console.log('\n== renderHarvestReport ==');
{
  const md = renderHarvestReport({ cands: 3, fresh: [{ id: 'p1', title: 'q', reason: 'abstain', expect: { intent: 'qa' } }], cases: [{}, {}], added: 1, trimmed: 0, apply: true, date: new Date('2026-11-19') });
  t('含日期标题', md.includes('评测候选收割 2026-11-19'));
  t('含已合并标记', md.includes('**已合并**'));
  t('含用例表', md.includes('| p1 |') && md.includes('abstain'));
  t('含集内条数', md.includes('共 2 条'));
  t('空候选提示', renderHarvestReport({ fresh: [], cases: [] }).includes('无新候选可并入'));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);