// O10 CLI 参数解析单测（2026-11-19）：argvOf 约定裸参数名，CLI 入口须剥 -- 前缀。
// 覆盖历史 bug：ingest/eval 的 --file/--clear/--llm 曾因未剥前缀而静默不生效。
import { argvOf } from './lib/paths.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const strip = (argv) => argv.map((a) => a.replace(/^--/, ''));
const parse = (argv) => argvOf(strip(argv));

console.log('\n== argvOf 裸约定 ==');
{
  const { has, argOf } = parse(['--file', 'x.json', '--clear']);
  t('has(file)', has('file') === true);
  t('argOf(file)', argOf('file', '') === 'x.json');
  t('has(clear)', has('clear') === true);
  t('缺省回落', argOf('missing', 'def') === 'def');
}
{
  const { has } = parse(['--llm', '--save-baseline']);
  t('多个开关', has('llm') && has('save-baseline'));
  t('未给的开关 false', has('env') === false);
}
{
  const { argOf } = parse(['--dense', 'char', '--rerank', 'onnx']);
  t('取值参数1', argOf('dense', 'bge') === 'char');
  t('取值参数2', argOf('rerank', 'llm') === 'onnx');
}
{
  // 不剥前缀时应当拿不到（复现历史 bug 的根因）
  const raw = argvOf(['--llm']);
  t('不剥前缀 → has(llm)=false（历史 bug 根因）', raw.has('llm') === false);
}
{
  const { has } = parse(['llm']);
  t('裸参数也认', has('llm') === true);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);