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

/**
 * 抢救被截断的 JSON：把文本里**每一个能完整闭合的对象**单独抠出来解析。
 *
 * 为什么要这个（2026-11-25 实测）：判定任务输出是"一个意图一个对象"的数组，
 * 一旦撞到 maxTokens 上限，尾巴被切掉 → 整个 JSON 解析失败 → 这一张图的判定全丢。
 * 其实前两个意图的对象是完整的，只丢最后一个才对。抢救后至少保住大部分。
 *
 * @returns {Array<object>} 能解析成功的对象（含嵌套对象）
 */
export function salvageJsonObjects(text) {
  const t = String(text || '');
  const out = [];
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      stack.push(i);
      continue;
    }
    if (ch === '}') {
      const start = stack.pop();
      if (start === undefined) continue;
      const slice = t.slice(start, i + 1);
      if (!slice.includes(':')) continue;
      try {
        const v = JSON.parse(slice);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(v);
      } catch {
        /* 这个对象本身也是断的，跳过 */
      }
    }
  }
  return out;
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