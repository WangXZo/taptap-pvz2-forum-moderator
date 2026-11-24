// 模板匹配通道：图片 → 已知特征
//
// 走本地服务（本能力包自带 scripts/server.py）：
//   POST /match ← { image, templates:[{id,name,image(base64),threshold}] }
//               → { ok, matches:[{id,name,score,loc,scale}] }
//
// **模板库不随本包分发** —— 由调用方作为 `templates` 传入（各自领域的特征图）。
// 本包只提供匹配引擎（opencv 多尺度）。

const DEFAULT_SERVER = 'http://127.0.0.1:8791';

/**
 * 匹配一张图
 * @param {object} img 规范化后的图片
 * @param {Array} templates [{id,name,image(base64),threshold}]
 * @returns {Promise<{hits:Array, ms:number, error?:string}>}
 */
export async function matchImage(img, templates, { config = {}, log = () => {} } = {}) {
  const server = String(config.server || DEFAULT_SERVER).replace(/\/$/, '');
  const timeoutMs = Number(config.timeoutMs ?? 30000);
  const t0 = Date.now();
  const list = (templates || []).filter((t) => t && t.image);
  if (!img?.base64) return { hits: [], ms: 0, error: 'no-base64' };
  if (!list.length) return { hits: [], ms: 0, error: 'no-templates' };
  try {
    const r = await fetch(server + '/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img.base64, templates: list }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`match HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.ok === false) throw new Error(j.error || 'match 服务返回失败');
    return { hits: j.matches || [], ms: Date.now() - t0 };
  } catch (e) {
    log(`  [模板] ${img.ref || ''} 跳过：${e.message}`);
    return { hits: [], ms: Date.now() - t0, error: e.message };
  }
}

/** 批量匹配（逐张） */
export async function matchImages(images, templates, { config = {}, log = () => {} } = {}) {
  const out = [];
  for (const img of images || []) {
    out.push({ ref: img.ref, ...(await matchImage(img, templates, { config, log })) });
  }
  return out;
}