// 从模型回复里稳妥地抠出 JSON
//
// 实测模型回复的三种形态都要能吃下：
//   ① 纯 JSON
//   ② ```json ... ``` 围栏
//   ③ 前后带解释文字，中间一段 JSON
// 解析不出来时**返回 null**，由调用方降级 —— 绝不因为模型话多就抛错。

/** 尝试解析一段文本为 JSON 对象 */
export function tryParseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // ① 直接解析
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch {
    /* 继续 */
  }
  // ② ```json 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const v = JSON.parse(fence[1].trim());
      if (v && typeof v === 'object') return v;
    } catch {
      /* 继续 */
    }
  }
  // ③ 首个 { 到末个 } 之间
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try {
      const v = JSON.parse(t.slice(s, e + 1));
      if (v && typeof v === 'object') return v;
    } catch {
      /* 放弃 */
    }
  }
  return null;
}

/** 从文本里抠出数字并夹到 [0,1]（模型偶尔给 92 表示 92%） */
export function toConfidence(v, fallback = 0) {
  let n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace('%', ''));
  if (!Number.isFinite(n)) return fallback;
  if (n > 1 && n <= 100) n = n / 100;
  if (n < 0) n = 0;
  if (n > 1) n = 1;
  return Math.round(n * 1000) / 1000;
}

/** 从数组里按 key 取字符串 */
export function str(v, max = 200) {
  return String(v ?? '').slice(0, max).trim();
}