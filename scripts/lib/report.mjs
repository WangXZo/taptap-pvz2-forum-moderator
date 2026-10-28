// 报表：全量问题清单（四类标记）+ 本轮扫描明细
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STATUS, LABEL, REASON_LABEL } from './state.mjs';

const fmtTime = (v) => {
  if (!v) return '-';
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export async function renderReport({ results = [], config, qa, root, state, usage = null, learned = 0 }) {
  const dir = config.paths.reportsDir || resolve(root, 'reports');
  await mkdir(dir, { recursive: true });

  const all = Object.entries(state?.posts || {}).map(([id, p]) => ({
    id,
    url: p.url,
    title: p.title || '(无标题)',
    author: p.author || '',
    publishTime: p.publishTime || 0,
    lastSeen: p.lastSeen,
    commentCount: p.commentCount ?? 0,
    status: p.status,
    reason: p.reason,
    score: p.score || 0,
    matchedQa: p.matchedQa || null,
    matchedQuestion: p.matchedQa || null,
    repliedAt: p.repliedAt,
  }));

  const countIn = (arr, s) => arr.filter((r) => r.status === s).length;
  const byTime = (a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '');

  let md = `# ${config.appName} 论坛问题清单

> 更新时间：${fmtTime(new Date())}
> 论坛：${config.forumUrl}
> 答疑库：${qa.length} 条（社区沉淀 ${qa.filter((e) => e.auto).length} 条）　|　累计收录：${all.length} 条　|　本轮扫描：${results.length} 条${learned ? `　|　本轮新沉淀：${learned} 条` : ''}

## 总览

| 标记 | 数量 |
|---|---|
| ${LABEL[STATUS.PENDING]} | ${countIn(all, STATUS.PENDING)} |
| ${LABEL[STATUS.REPLIED]} | ${countIn(all, STATUS.REPLIED)} |
| ${LABEL[STATUS.NO_NEED]} | ${countIn(all, STATUS.NO_NEED)} |
| ${LABEL[STATUS.MANUAL]} | ${countIn(all, STATUS.MANUAL)} |

`;

  // 答疑库使用情况（按引用次数排序，对应「常用+新」优先级）
  if (usage?.items && Object.keys(usage.items).length) {
    const rows = Object.entries(usage.items)
      .map(([id, s]) => ({ id, ...s }))
      .filter((s) => !s.archived)
      .sort((a, b) => (b.cited || 0) - (a.cited || 0) || String(b.lastCitedAt || '').localeCompare(String(a.lastCitedAt || '')))
      .slice(0, 10);
    if (rows.length) {
      md += `\n## 答疑库使用排行（前 ${rows.length}）\n\n`;
      md += `> 引用次数越多、越新的条目，匹配时权重越高。超过 ${config.archive?.staleDays ?? 30} 天未引用会被归档。\n\n`;
      md += `| 条目 | 引用次数 | 最后引用 | 来源 |\n|---|---|---|---|\n`;
      for (const r of rows) {
        const e = qa.find((x) => x.id === r.id);
        md += `| ${esc(e?.question || r.id)} | ${r.cited || 0} | ${r.lastCitedAt ? fmtTime(r.lastCitedAt) : '从未'} | ${r.source ? '社区' : '人工'} |\n`;
      }
    }
  }

  if (results.length) {
    md += `\n## 本轮扫描（${results.length} 条）\n\n`;
    md += `| 标记 | 标题 | 作者 | 发布时间 | 命中 QA | 分数 | 说明 |\n|---|---|---|---|---|---|---|\n`;
    for (const r of results) {
      md += `| ${LABEL[r.status] || r.status} | [${esc(r.title)}](${r.url}) | ${esc(r.author)} | ${fmtTime(r.publishTime)} | ${esc(r.matchedQuestion || '-')} | ${r.score ? r.score.toFixed(2) : '-'} | ${esc(REASON_LABEL[r.reason] || r.note || '-')} |\n`;
    }
    const drafts = results.filter((r) => r.replyDraft);
    if (drafts.length) {
      md += `\n<details><summary>本轮回复草稿（${drafts.length} 条）</summary>\n\n`;
      for (const r of drafts) {
        md += `**${r.title}** — ${r.url}\n\n\`\`\`\n${r.replyDraft}\n\`\`\`\n\n`;
      }
      md += `</details>\n`;
    }
  }

  const sections = [
    [STATUS.PENDING, '命中 QA，等待发出'],
    [STATUS.MANUAL, '未命中 / 低置信 / 敏感词 / 发送失败'],
    [STATUS.REPLIED, '已发出回复的帖子'],
    [STATUS.NO_NEED, '非提问 / 重复问题 / 早已回复'],
  ];

  for (const [status, desc] of sections) {
    const rows = all.filter((r) => r.status === status).sort(byTime);
    md += `\n## ${LABEL[status]}（${rows.length}）\n\n`;
    if (rows.length) md += `> ${desc}\n\n`;
    if (!rows.length) {
      md += `_暂无_\n`;
      continue;
    }
    md += `| 标题 | 作者 | 发布时间 | 回复数 | 原因 |\n|---|---|---|---|---|\n`;
    for (const r of rows) {
      md += `| [${esc(r.title)}](${r.url}) | ${esc(r.author)} | ${fmtTime(r.publishTime)} | ${r.commentCount} | ${esc(REASON_LABEL[r.reason] || '-')} |\n`;
    }
  }

  await writeFile(resolve(dir, 'questions.md'), md, 'utf8');

  const csvEsc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const header = ['标记', '标题', '链接', '作者', '发布时间', '回复数', '原因', '命中QA', '分数', '回复时间'];
  const lines = [header.join(',')];
  for (const r of all.sort(byTime)) {
    lines.push(
      [
        LABEL[r.status] || r.status,
        r.title,
        r.url,
        r.author,
        fmtTime(r.publishTime),
        r.commentCount,
        REASON_LABEL[r.reason] || '',
        r.matchedQuestion || '',
        r.score || '',
        fmtTime(r.repliedAt),
      ]
        .map(csvEsc)
        .join(',')
    );
  }
  await writeFile(resolve(dir, 'questions.csv'), '\uFEFF' + lines.join('\r\n'), 'utf8');

  return md;
}
