// O7 就绪矩阵离线测试（2026-11-19）：探测降级语义 + 矩阵渲染
import { probe, probePythonModule, probeModelDir, buildMatrix, renderMatrix } from './lib/readiness.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

console.log('\n== probe 三态 ==');
{
  const ok = probe('x', [], { spawnImpl: () => ({ status: 0, stdout: '2.0.3', stderr: '' }) });
  t('成功 → ok', ok.state === 'ok');
  const miss = probe('x', [], { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'not found' }) });
  t('非零退出 → missing', miss.state === 'missing');
  const eperm = probe('x', [], { spawnImpl: () => ({ error: Object.assign(new Error('EPERM'), { code: 'EPERM' }) }) });
  t('EPERM → unknown（不误判缺失）', eperm.state === 'unknown');
  const exc = probe('x', [], { spawnImpl: () => { throw new Error('boom'); } });
  t('抛错 → unknown', exc.state === 'unknown');
}

console.log('\n== probePythonModule ==');
{
  const noPy = probePythonModule('rapidocr', { spawnImpl: () => ({ status: 1, stderr: 'python not found' }) });
  t('python 缺失 → missing', noPy.state === 'missing');
  let n = 0;
  const withPy = probePythonModule('rapidocr', { spawnImpl: () => { n++; return n === 1 ? { status: 0, stdout: 'Python 3.8.6' } : { status: 0, stdout: 'ok' }; } });
  t('python 有 + 模块有 → ok', withPy.state === 'ok');
  let m = 0;
  const noMod = probePythonModule('tokenizers', { spawnImpl: () => { m++; return m === 1 ? { status: 0, stdout: 'Python 3.8.6' } : { status: 1, stderr: 'ModuleNotFoundError' }; } });
  t('python 有 + 模块缺 → missing', noMod.state === 'missing');
}

console.log('\n== probeModelDir ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mdl-'));
  t('空 modelDir → missing', probeModelDir('').state === 'missing');
  t('目录不存在 → missing', probeModelDir(join(dir, 'nope')).state === 'missing');
  t('缺文件 → missing', probeModelDir(dir).state === 'missing');
  writeFileSync(join(dir, 'model_quant.onnx'), 'x');
  t('缺 tokenizer.json → missing', probeModelDir(dir).state === 'missing');
  writeFileSync(join(dir, 'tokenizer.json'), '{}');
  const r = probeModelDir(dir);
  t('齐全 → ok', r.state === 'ok' && r.detail.includes('model_quant'));
  // model_quantized 优先级
  const dir2 = mkdtempSync(join(tmpdir(), 'mdl2-'));
  writeFileSync(join(dir2, 'model_quantized.onnx'), 'x');
  writeFileSync(join(dir2, 'model.onnx'), 'x');
  writeFileSync(join(dir2, 'tokenizer.json'), '{}');
  t('优先认 model_quantized', probeModelDir(dir2).detail === 'model_quantized.onnx');
  try { rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); } catch {}
}

console.log('\n== buildMatrix（全 stub）==');
{
  const stubOk = (c, a) => ({ status: 0, stdout: a && a[0] === '-c' ? 'ok' : '2.0.3 bge-m3', stderr: '' });
  const dir = mkdtempSync(join(tmpdir(), 'mdlb-'));
  writeFileSync(join(dir, 'model_quant.onnx'), 'x');
  writeFileSync(join(dir, 'tokenizer.json'), '{}');
  const m = buildMatrix({ config: { rerank: { modelDir: dir }, llm: { apiKey: 'k', baseURL: 'u', model: 'm' } }, spawnImpl: stubOk });
  t('矩阵含 7 项', m.rows.length >= 7);
  t('全可用时 missing=0', m.summary.missing === 0);
  t('含答疑主链路', m.rows.some((r) => r.feature.includes('答疑')));
  const txt = renderMatrix(m);
  t('渲染含标题', txt.includes('功能就绪矩阵'));
  t('渲染含合计', txt.includes('合计'));
  // 缺失时提示降级
  const m2 = buildMatrix({ config: {}, spawnImpl: () => ({ status: 1, stderr: 'x' }) });
  t('缺依赖 → missing>0', m2.summary.missing > 0);
  t('缺依赖提示降级', renderMatrix(m2).includes('会自行降级'));
  t('缺失项给出补法', renderMatrix(m2).includes('补法'));
  t('checkPython=false 跳过检测', buildMatrix({ config: {}, spawnImpl: () => ({ status: 1 }), checkPython: false }).rows.some((r) => r.state === 'unknown'));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);