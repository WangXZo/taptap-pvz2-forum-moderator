// O5 评测闭环（2026-11-19）：弃答候选 → 评测集。纯函数便于测试。
// 规则：事故 case 标 permanent 永不裁剪；上限默认 100，超了先裁非 permanent 的最旧项。

const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

/** 候选去重：同一 postId / 同一归一化标题已在集里的跳过 */
export function dedupeCandidates(cands = [], existingCases = []) {
  const ids = new Set();
  const titles = new Set();
  for (const c of existingCases || []) {
    if (c.postId) ids.add(String(c.postId));
    if (c.title) titles.add(norm(c.title));
  }
  const out = [];
  for (const c of cands || []) {
    const pid = c.postId ? String(c.postId) : '';
    const nt = norm(c.title);
    if (pid && ids.has(pid)) continue;
    if (nt && titles.has(nt)) continue;
    if (pid) ids.add(pid);
    if (nt) titles.add(nt);
    out.push(c);
  }
  return out;
}

/**
 * 合并进评测集。
 * @param {Array} existingCases
 * @param {Array} newCases 形如 {id,title,text,expect,permanent?}
 * @param {object} o {maxCases=100}
 * @returns {{cases:Array, added:number, trimmed:number}}
 */
export function mergeIntoSet(existingCases = [], newCases = [], { maxCases = 100 } = {}) {
  const merged = [...(existingCases || []), ...(newCases || [])];
  let trimmed = 0;
  if (merged.length > maxCases) {
    // permanent 优先保留；其次按原顺序（老的在前）
    const keep = [];
    const droppable = [];
    for (const c of merged) (c.permanent ? keep : droppable).push(c);
    const room = Math.max(0, maxCases - keep.length);
    // 非 permanent 保留**最新的**（droppable 末尾是新增的）
    const keptDrop = droppable.slice(Math.max(0, droppable.length - room));
    trimmed = droppable.length - keptDrop.length;
    const keptSet = new Set([...keep, ...keptDrop]);
    return { cases: merged.filter((c) => keptSet.has(c)), added: (newCases || []).length, trimmed };
  }
  return { cases: merged, added: (newCases || []).length, trimmed: 0 };
}

/** 候选 → 评测 case（未预标时用检索结果兜底 expect） */
export function candidateToCase(c, { intent = null, entryIncludes = null } = {}) {
  const expect = {};
  if (intent) expect.intent = intent;
  if (entryIncludes) expect.entryIncludes = entryIncludes;
  return {
    id: String(c.postId || norm(c.title).slice(0, 16) || `cand-${Date.now()}`),
    title: String(c.title || '').slice(0, 60),
    text: String(c.text || '').slice(0, 200),
    expect,
    source: 'harvest',
    reason: c.reason || null,
  };
}

/** 提案报告 */
export function renderHarvestReport({ cands = [], fresh = [], cases = [], added = 0, trimmed = 0, apply = false, date = new Date() } = {}) {
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
  const L = [];
  L.push(`# 评测候选收割 ${ymd}`);
  L.push('');
  L.push(`> ${apply ? '**已合并**' : 'dry-run（未改集）'} ｜ 候选 ${cands.length} ／ 新增可用 ${fresh.length} ／ 本次入集 ${added} ／ 裁剪 ${trimmed}`);
  L.push('');
  if (fresh.length) {
    L.push('## 待并入用例');
    L.push('');
    L.push('| id | 标题 | 原因 | 预标 expect |');
    L.push('|---|---|---|---|');
    for (const c of fresh) L.push(`| ${c.id} | ${String(c.title || '').slice(0, 30)} | ${c.reason || '-'} | ${JSON.stringify(c.expect || {})} |`);
    L.push('');
  }
  if (!fresh.length) L.push('_无新候选可并入（候选为空或均已存在）_');
  L.push('');
  L.push(`当前评测集共 ${cases.length} 条。`);
  return L.join('\n');
}