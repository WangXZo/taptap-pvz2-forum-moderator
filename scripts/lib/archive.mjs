// 答疑库归档：超过 30 天未被引用的条目 → 冷数据，主库重新整理
//
// 触发时机：每月 1~5 号，且本月还没整理过（见 usage.shouldArchive）
// 归档去向：qa/归档/答疑库-冷数据-YYYY-MM.md（仍是 Markdown，人能看）
// 主库处理：删除已归档条目，重排为统一格式
//
// 安全设计：
//   - 只移动，不删除（冷数据文件永久保留）
//   - 归档前逐条打印，写入 reports/archive-YYYY-MM.log
//   - 可以手动把条目从冷数据拷回主库，下次运行会重新纳入统计

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DAY = 86400000;

/**
 * 判断某条目是否该归档
 * 规则：最后引用（没有则用入库时间）距今 > staleDays 天 → 归档
 */
export function isStale(stat, { staleDays = 30, now = Date.now() } = {}) {
  const anchor = stat.lastCitedAt || stat.createdAt;
  if (!anchor) return false;
  return now - Date.parse(anchor) > staleDays * DAY;
}

/** 把解析出来的条目还原成标准 Markdown 块 */
export function renderEntry(e) {
  const lines = [`## 问：${e.question}`];
  const kw = (e.keywords || []).join(', ');
  if (kw) lines.push(`- 关键词：${kw}`);
  if (e.version && e.version !== '通用') lines.push(`- 版本：${e.version}`);
  if (e.signature) lines.push(`- 签名：${e.signature}`);
  if (e.source) lines.push(`- 来源：${e.source}`);
  if (e.summarizedAt) lines.push(`- 总结时间：${e.summarizedAt}`);
  lines.push('---');
  lines.push(e.answer.trim());
  return lines.join('\n') + '\n';
}

/**
 * 执行归档
 * @returns {{archived:string[], kept:string[], coldFile:string|null, log:string[]}}
 */
export async function archiveStale({
  qaFile,
  archiveDir,
  entries,
  usage,
  staleDays = 30,
  now = new Date(),
}) {
  const log = [];
  const archived = [];
  const kept = [];
  const coldBlocks = [];

  for (const e of entries) {
    const stat = usage.items?.[e.id];
    // 没有统计记录的条目：补一条（以现在为入库时间），本轮不归档
    if (!stat) {
      usage.items = usage.items || {};
      usage.items[e.id] = {
        cited: 0,
        lastCitedAt: null,
        createdAt: now.toISOString(),
        source: e.source || null,
        archived: false,
      };
      kept.push(e);
      continue;
    }
    if (isStale(stat, { staleDays, now: now.getTime() })) {
      archived.push(e);
      coldBlocks.push(
        `<!-- 归档于 ${fmt(now)}，最后引用 ${stat.lastCitedAt || '从未'}，累计引用 ${stat.cited || 0} 次 -->\n` +
          renderEntry(e)
      );
      usage.items[e.id].archived = true;
      log.push(
        `归档：《${e.question}》 引用 ${stat.cited || 0} 次，最后引用 ${
          stat.lastCitedAt ? fmt(new Date(stat.lastCitedAt)) : '从未'
        }`
      );
    } else {
      kept.push(e);
    }
  }

  let coldFile = null;
  if (archived.length) {
    await mkdir(archiveDir, { recursive: true });
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    coldFile = join(archiveDir, `答疑库-冷数据-${ym}.md`);

    // 冷数据文件可能是多个月累积写同一个「本月」文件；已存在则追加
    let prev = '';
    try {
      await access(coldFile);
      prev = await readFile(coldFile, 'utf8');
    } catch {
      prev =
        `# 答疑库 · 冷数据（${ym}）\n\n` +
        `> 超过 ${staleDays} 天未被引用的条目，自动归档到此。仍可手工拷回 \`qa/答疑库.md\` 恢复使用。\n\n`;
    }
    await writeFile(coldFile, prev.replace(/\s*$/, '\n\n') + coldBlocks.join('\n'), 'utf8');
  }

  // 主库重写：保留未归档条目，统一格式
  const head =
    `# 植物大战僵尸2 · 答疑库\n\n` +
    `> 本文件就是答疑数据库，直接在这里加/改问答即可。改完不用改代码，下一轮自动生效。\n` +
    `> 上次整理：${fmt(now)}（归档 ${archived.length} 条，保留 ${kept.length} 条）\n\n` +
    `> 格式：\`## 问：\` 问法 / \`- 关键词：\` 匹配词 / \`- 签名：\` 可选 / \`---\` 正文起点\n\n`;
  await writeFile(qaFile, head + kept.map(renderEntry).join('\n'), 'utf8');

  return { archived: archived.map((e) => e.question), kept: kept.map((e) => e.question), coldFile, log };
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
