// QA 自治治理统一入口（O3，2026-11-18）：分层 junk 剔除 → 语义近重复合并 → 归档 + 报告。
// 原则：**只移动不删除**（归档可恢复）；默认 auto（大哥 2026-11-18 决策），出报告供抽检/回滚线索。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { renderEntry } from './archive.mjs';
import { scanJunkLayered, DEFAULT_JUNK_PATTERNS, DEFAULT_NOISE_PATTERNS } from './qa-junk.mjs';
import { findNearDuplicates, mergeInto, normQuestion } from './qa-dedup.mjs';

const p2 = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;

/** 从原始 Markdown 解析条目（与 archive.renderEntry 对称）。
 *  ⚠️ 2026-11-19 审查：原版只取 question/keywords/answer，**丢掉 来源/版本/签名/总结时间/语义确认** ——
 *  治理重写主库时这些元数据会静默消失（实测花盆挂件的「语义确认：true」即如此丢失）。
 *  字段必须与 renderEntry 白名单一一对应。 */
export function parseQaEntries(raw) {
  const out = [];
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  for (const b of parts.slice(1)) {
    if (!/^##\s/m.test(b)) continue;
    const question = (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim();
    const meta = (name) => (b.match(new RegExp(`^-\\s*${name}：(.*)$`, 'm'))?.[1] || '').trim();
    const kwLine = meta('关键词');
    const answer = b.split(/\n---\n/)[1] || '';
    const semRaw = meta('语义确认');
    out.push({
      id: normQuestion(question),
      question,
      keywords: kwLine.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
      version: meta('版本') || null,
      signature: meta('签名') || null,
      source: meta('来源') || null,
      summarizedAt: meta('总结时间') || null,
      semanticConfirm: semRaw ? /true|是|yes/i.test(semRaw) : false,
      answer: answer.trim(),
    });
  }
  return out;
}

/**
 * 执行 QA 治理。
 * @param {object} o
 * @param {string} o.qaFile
 * @param {string} o.archiveDir
 * @param {Array}  [o.entries]  已解析条目（不给则从 qaFile 解析）
 * @param {object} [o.usage]
 * @param {object} [o.config]
 * @param {boolean} [o.apply]
 * @param {Date} [o.now]
 * @returns {Promise<{junk:Array, groups:Array, keep:Array, before:number, after:number, changed:boolean, archivedFiles:object, report:string}>}
 */
export async function governQa({ qaFile, archiveDir, entries = null, usage = {}, config = {}, apply = true, now = new Date() }) {
  const gcfg = config?.qaGovern || {};
  let raw = '';
  try {
    raw = await readFile(qaFile, 'utf8');
  } catch {
    return { junk: [], groups: [], keep: [], before: 0, after: 0, changed: false, archivedFiles: {}, report: '（答疑库读不到，跳过治理）' };
  }
  const list = entries || parseQaEntries(raw);
  const citedOf = (q) => {
    const st = usage.items?.[q] || usage.items?.[normQuestion(q)];
    return Number(st?.cited || 0);
  };

  // ① 分层 junk/噪声
  const scanned = scanJunkLayered(raw, {
    junkPatterns: gcfg.junkPatterns || DEFAULT_JUNK_PATTERNS,
    noisePatterns: gcfg.noisePatterns || DEFAULT_NOISE_PATTERNS,
    citedOf,
    shortQuestionLen: Number(gcfg.shortQuestionLen ?? 0), // 默认 0=关闭组合判据（防误伤有效短问答）
    shortAnswerLen: Number(gcfg.shortAnswerLen ?? 12),
  });

  // ② 语义近重复（在保留集上做）
  const keepQuestions = new Set(
    scanned.keep.map((b) => (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim()).filter(Boolean)
  );
  const survivors = list.filter((e) => keepQuestions.has(e.question));
  const { groups } = findNearDuplicates(survivors, {
    threshold: Number(gcfg.dedupThreshold ?? 0.94),
    citedOf: (id) => {
      const st = usage.items?.[id];
      return Number(st?.cited || 0);
    },
  });

  const dropIds = new Set();
  const merged = [];
  for (const g of groups) {
    merged.push(mergeInto(g.keep, g.drop));
    for (const d of g.drop) dropIds.add(d.question);
  }
  const mergedByQ = new Map(merged.map((m) => [m.question, m]));
  const finalList = survivors
    .filter((e) => !dropIds.has(e.question))
    .map((e) => mergedByQ.get(e.question) || e);

  const before = list.length;
  const after = finalList.length;
  const changed = scanned.hits.length > 0 || groups.length > 0;

  const archivedFiles = {};
  if (apply && changed) {
    await mkdir(archiveDir, { recursive: true }).catch(() => {});
    const stamp = stampOf(now);
    // junk/噪声归档
    if (scanned.hits.length) {
      const f = `${archiveDir}/答疑库-治理剔除-${stamp}.md`;
      const body =
        `# 答疑库 · 治理剔除（${stamp}）\n\n` +
        `> junk 层=求码/加好友/广告（命中即剔，不看引用）；噪声层=无信息标题（引用>0 豁免）。\n` +
        `> **只移动不删除**，可拷回 qa/答疑库.md。\n\n---\n` +
        scanned.hits.map((h) => `\n<!-- ${h.layer}：${h.pattern} -->\n${h.block.trim()}\n`).join('');
      await writeFile(f, body, 'utf8');
      archivedFiles.junk = f;
    }
    // 近重复归档
    if (groups.length) {
      const f = `${archiveDir}/答疑库-治理合并-${stamp}.md`;
      const body =
        `# 答疑库 · 语义近重复合并（${stamp}）\n\n` +
        `> 阈值 ${gcfg.dedupThreshold ?? 0.94}；关键数字冲突（如困难6/困难8）**不合并**。\n` +
        `> 保留者正文已追加「同义问法」。被并条目**只移动不删除**。\n\n---\n` +
        groups
          .map(
            (g) =>
              `\n<!-- 合并到：《${g.keep.question}》 相似度 ${g.similarity} -->\n` +
              g.drop.map((d) => renderEntry(d)).join('\n')
          )
          .join('');
      await writeFile(f, body, 'utf8');
      archivedFiles.merged = f;
    }
    // 主库重写（备份后）
    const backup = `${qaFile}.before-govern-${stamp}`;
    await copyFile(qaFile, backup).catch(() => {});
    const head =
      `# 植物大战僵尸2 · 答疑库\n\n` +
      `> 本文件就是答疑数据库，直接在这里加/改问答即可。改完不用改代码，下一轮自动生效。\n` +
      `> 上次治理：${now.toISOString().slice(0, 16).replace('T', ' ')}（剔除 ${scanned.hits.length} / 合并 ${groups.length} 组 / ${before}→${after} 条）\n\n` +
      `> 格式：\`## 问：\` 问法 / \`- 关键词：\` 匹配词 / \`- 签名：\` 可选 / \`---\` 正文起点\n\n`;
    await writeFile(qaFile, head + finalList.map(renderEntry).join('\n'), 'utf8');
    archivedFiles.backup = backup;
  }

  const report = renderGovernReport({ scanned, groups, before, after, now, apply });
  return { junk: scanned.hits, groups, keep: finalList, before, after, changed, archivedFiles, report, exempted: scanned.exempted };
}

/** 治理报告（Markdown） */
export function renderGovernReport({ scanned = {}, groups = [], before = 0, after = 0, now = new Date(), apply = false } = {}) {
  const L = [];
  L.push(`# 答疑库治理报告 ${now.toISOString().slice(0, 10)}`);
  L.push('');
  L.push(`> 模式：${apply ? '**已应用**（归档可恢复）' : 'dry-run（未改库）'} ｜ ${before} → ${after} 条`);
  L.push('');
  const junk = (scanned.hits || []).filter((h) => h.layer === 'junk');
  const noise = (scanned.hits || []).filter((h) => h.layer === 'noise');
  L.push('| 类别 | 条数 | 规则 |');
  L.push('|---|---|---|');
  L.push(`| junk（求码/加好友/广告） | ${junk.length} | 命中即剔 |`);
  L.push(`| noise（无信息标题） | ${noise.length} | 引用>0 豁免（本次豁免 ${scanned.exempted || 0}） |`);
  L.push(`| 近重复合并组 | ${groups.length} | 阈值 0.94 + 数字否决 |`);
  L.push('');
  if (junk.length) {
    L.push('## junk 剔除');
    L.push('');
    for (const h of junk) L.push(`- 《${h.question}》 ← ${h.pattern}`);
    L.push('');
  }
  if (noise.length) {
    L.push('## 噪声剔除');
    L.push('');
    for (const h of noise) L.push(`- 《${h.question}》 ← ${h.pattern}`);
    L.push('');
  }
  if (groups.length) {
    L.push('## 近重复合并');
    L.push('');
    for (const g of groups) {
      L.push(`- 保留《${g.keep.question}》（相似度 ${g.similarity}）← ${g.drop.map((d) => `《${d.question}》`).join('、')}`);
    }
    L.push('');
  }
  if (!junk.length && !noise.length && !groups.length) L.push('_库干净，无需治理_');
  return L.join('\n');
}