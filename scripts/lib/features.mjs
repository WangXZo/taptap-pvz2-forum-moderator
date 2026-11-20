// S6 游戏特征模板匹配（本地 skill 资产库，2026-11-16）
//
// 读 assets/game-features/features.json + 模板图 → 下载场景图 → POST 本地图像服务 /match
// （opencv 多尺度模板匹配）→ 命中特征文本。模板库自包含、跟 skill 分发、离线免费；
// 新植物/新 UI 只需补模板。服务未起 / 缺模板 → 降级返回空（不抛错）。
//
// 特征定义 schema（features.json）：
//   { id, name, category, method:'template', template:'templates/x.png', threshold:0.85, aliases:[] }

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(LIB_DIR, '..', '..'); // scripts/lib → skill 根
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 读特征定义（features.json）。dir 支持 {{SKILL}} 占位。 */
export function loadFeatures(config = {}) {
  const raw = config?.image?.features?.dir;
  const dir = raw
    ? resolve(raw.replace(/\{\{SKILL\}\}/g, SKILL_ROOT))
    : resolve(SKILL_ROOT, 'assets', 'game-features');
  let defs = [];
  try {
    defs = JSON.parse(readFileSync(resolve(dir, 'features.json'), 'utf8')).features || [];
  } catch { /* 无特征库 */ }
  return { dir, defs };
}

async function downloadBase64(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.taptap.cn/' } });
  if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('图片过小/无效');
  return buf.toString('base64');
}

/**
 * 模板匹配一组图片，返回命中的特征文本。
 * @returns {{text:string, sources:string[]}}
 */
export async function matchFeatures(images, { config = {}, log = () => {}, cache = null } = {}) {
  const fc = config?.image?.features || {};
  const { dir, defs } = loadFeatures(config);
  const tplDefs = defs.filter((d) => d.method === 'template' && d.template);
  if (!tplDefs.length) return { text: '', sources: [] };

  const templates = [];
  for (const d of tplDefs) {
    const p = resolve(dir, d.template);
    if (!existsSync(p)) continue;
    try {
      templates.push({ id: d.id, name: d.name, threshold: Number(d.threshold ?? 0.85), image: readFileSync(p).toString('base64') });
    } catch { /* 模板读失败跳过 */ }
  }
  if (!templates.length) return { text: '', sources: [] };

  const server = (fc.server || config?.image?.ocr?.server || 'http://127.0.0.1:8790').replace(/\/$/, '');
  const timeoutMs = Number(fc.timeoutMs ?? 30000);
  const found = new Map();
  const defById = new Map(defs.map((d) => [d.id, d]));
  let celebrate = false;
  for (const im of images || []) {
    if (!im?.url) continue;
    const key = 'feat:' + createHash('sha1').update(im.url + templates.map((t) => t.id).join(',')).digest('hex');
    const cached = cache?.get?.(key);
    if (cached) {
      (cached.names || []).forEach((n) => found.set(n, true));
      if (cached.celebrate) celebrate = true;
      continue;
    }
    try {
      const b64 = await downloadBase64(im.url);
      const r = await fetch(server + '/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: b64, templates }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`match HTTP ${r.status}`);
      const j = await r.json();
      const ms = j.matches || [];
      const names = ms.map((m) => m.name).filter(Boolean);
      const cel = ms.some((m) => defById.get(m.id)?.trigger === 'celebrate');
      cache?.set?.(key, { names, celebrate: cel });
      if (cel) celebrate = true;
      names.forEach((n) => found.set(n, true));
    } catch (e) {
      log(`  [特征] 跳过 ${String(im.url).slice(0, 40)}…：${e.message}`);
    }
  }
  const names = [...found.keys()];
  if (!names.length) return { text: '', sources: [], celebrate: false, features: [] };
  return { text: `图中识别到：${names.join('、')}`, sources: ['template'], celebrate, features: names };
}