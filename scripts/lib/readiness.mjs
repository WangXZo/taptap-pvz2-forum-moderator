// O7 功能就绪矩阵（2026-11-19）：把「哪些功能可用、缺什么、怎么补」一次说清。
// 原则（大哥 2026-11-18）：**只提示不自动装**；探测失败（含沙盒 EPERM）报「未知」而不是「缺失」。
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const OK = 'ok';
const MISSING = 'missing';
const UNKNOWN = 'unknown';

/** 执行探测命令；spawn 失败/超时 → UNKNOWN（不误判成缺失） */
export function probe(cmd, args = [], { spawnImpl = null, timeout = 8000 } = {}) {
  const run = spawnImpl || ((c, a, o) => spawnSync(c, a, o));
  try {
    const r = run(cmd, args, { encoding: 'utf8', timeout, shell: false });
    if (!r || (r.error && /EPERM|Access is denied|EACCES/i.test(String(r.error)))) return { state: UNKNOWN, detail: 'spawn 被拦截' };
    if (r.error) return { state: UNKNOWN, detail: String(r.error.message || r.error) };
    if (r.status === 0) return { state: OK, detail: String(r.stdout || '').trim() };
    return { state: MISSING, detail: String(r.stderr || r.stdout || '').trim().slice(0, 120) };
  } catch (e) {
    return { state: UNKNOWN, detail: String(e.message || e) };
  }
}

/** python 模块是否可导入（py 缺失 → UNKNOWN，不判 missing） */
export function probePythonModule(mod, { pythonCmd = 'python', spawnImpl = null } = {}) {
  const py = probe(pythonCmd, ['--version'], { spawnImpl });
  if (py.state !== OK) return { state: py.state, detail: py.detail, python: py.state };
  const r = probe(pythonCmd, ['-c', `import ${mod}; print("ok")`], { spawnImpl });
  return { state: r.state, detail: r.detail, python: OK };
}

/** 模型目录是否齐全（bge-reranker：需要 onnx + tokenizer.json） */
export function probeModelDir(dir) {
  if (!dir) return { state: MISSING, detail: '未配置 modelDir' };
  try {
    if (!existsSync(dir)) return { state: MISSING, detail: '目录不存在' };
    const files = new Set(readdirSync(dir));
    const onnx = ['model_quantized.onnx', 'model_quant.onnx', 'model.onnx'].find((f) => files.has(f));
    if (!onnx) return { state: MISSING, detail: '缺 model.onnx / model_quant(.ized).onnx' };
    if (!files.has('tokenizer.json')) return { state: MISSING, detail: '缺 tokenizer.json' };
    return { state: OK, detail: onnx };
  } catch (e) {
    return { state: UNKNOWN, detail: String(e.message || e) };
  }
}

/**
 * 生成就绪矩阵。
 * @returns {{rows:Array<{feature,need,state,detail,fix}>, summary:{ok:number,missing:number,unknown:number}}}
 */
export function buildMatrix({ config = {}, spawnImpl = null, opencliOk = null, checkPython = true } = {}) {
  const rows = [];
  const add = (feature, need, state, detail, fix = '') => rows.push({ feature, need, state, detail, fix });

  // 答疑主链路
  add('答疑（纯文本）', 'Node ≥18 + 答疑库', OK, `node ${process.versions.node}`, '');
  // 发送通道
  if (opencliOk === null) {
    const r = probe('opencli', ['--version'], { spawnImpl });
    add('发出回复/互动', 'opencli + 浏览器扩展 + 登录 TapTap', r.state, r.detail, 'npm i -g @jackwener/opencli');
  } else {
    add('发出回复/互动', 'opencli + 浏览器扩展 + 登录 TapTap', opencliOk ? OK : MISSING, opencliOk ? '可用' : '不可用', 'npm i -g @jackwener/opencli');
  }
  // 图片 OCR
  if (checkPython) {
    const ocr = probePythonModule('rapidocr', { spawnImpl });
    add('图片 OCR', 'python3 + rapidocr + 识图skill的 server.py(8791)', ocr.state, ocr.detail, 'pip install rapidocr onnxruntime pillow numpy');
    const tok = probePythonModule('tokenizers', { spawnImpl });
    add('cross-encoder 重排', 'python3 + onnxruntime + tokenizers + 模型目录', tok.state, tok.detail, 'pip install onnxruntime tokenizers==0.20.3');
    // 模型
    const md = probeModelDir(config?.rerank?.modelDir || '');
    add('reranker 模型', 'model_quant(.ized).onnx + tokenizer.json', md.state, md.detail, '见 references/install-guide.md（模型下载教程）');
  } else {
    add('图片 OCR', 'python3 + rapidocr', UNKNOWN, '跳过检测', 'pip install rapidocr onnxruntime pillow numpy');
    add('cross-encoder 重排', 'onnxruntime + tokenizers + 模型', UNKNOWN, '跳过检测', 'pip install onnxruntime tokenizers==0.20.3');
  }
  // embedding
  {
    const r = probe('curl', ['-s', '--max-time', '3', `${config?.retrieve?.embedEndpoint || 'http://127.0.0.1:11434'}/api/tags`], { spawnImpl });
    if (r.state === OK) {
      const hasBge = /bge-m3/i.test(r.detail);
      add('向量检索（bge-m3）', 'ollama + bge-m3', hasBge ? OK : MISSING, hasBge ? 'bge-m3 已就绪' : 'ollama 在跑但没 bge-m3', 'ollama pull bge-m3');
    } else {
      add('向量检索（bge-m3）', 'ollama + bge-m3', r.state === MISSING ? MISSING : UNKNOWN, r.detail || 'ollama 不可达', 'ollama pull bge-m3（缺失时自动回落 char-ngram）');
    }
  }
  // LLM
  {
    const l = config?.llm || {};
    const own = Boolean(l.apiKey && l.baseURL && l.model);
    add('回复生成（LLM）', 'config.llm 三项 或 DSH 凭据', own ? OK : UNKNOWN, own ? '自带 key' : '跟随 DSH（运行时判定）', '填 config.llm.apiKey/baseURL/model');
  }

  const summary = rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, { ok: 0, missing: 0, unknown: 0 });
  return { rows, summary: { ok: summary[OK] || 0, missing: summary[MISSING] || 0, unknown: summary[UNKNOWN] || 0 } };
}

/** 渲染成文本（install/doctor 共用） */
export function renderMatrix(matrix, { color = null } = {}) {
  const c = color || { g: '', y: '', r: '', d: '', b: '', x: '' };
  const mark = (s) => (s === OK ? `${c.g}✓${c.x}` : s === MISSING ? `${c.r}✗${c.x}` : `${c.y}?${c.x}`);
  const label = { ok: '可用', missing: '缺失', unknown: '未知' };
  const L = [];
  L.push(`${c.b}功能就绪矩阵${c.x}`);
  for (const r of matrix.rows) {
    L.push(`  ${mark(r.state)} ${r.feature} ${c.d}(${label[r.state]})${c.x}`);
    if (r.state !== OK) {
      L.push(`      ${c.d}需要：${r.need} ｜ ${r.detail}${c.x}`);
      if (r.fix) L.push(`      ${c.d}补法：${r.fix}${c.x}`);
    }
  }
  const s = matrix.summary;
  L.push(`  ${c.d}合计：可用 ${s.ok} ／ 缺失 ${s.missing} ／ 未知 ${s.unknown}${c.x}`);
  if (s.missing) L.push(`  ${c.y}缺失功能会自行降级，不阻断答疑主链路${c.x}`);
  return L.join('\n');
}