// 版主管理任务报表：今天处理了什么、还有哪些要人工移除
//
// 为什么需要：活动报名板（sub_type=activity_signup）网页端**没有**「管理→移除」入口，
// 只能回复。用户 2026-10-29 确认：「只回复 + 报表列待人工移除」——
// 这份报表就是那份清单，版主照着在 App 里批量处理。

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const fmt = (v) => {
  if (!v) return '-';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * 生成 reports/mod-tasks.md
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.state
 * @returns {Promise<string>} 文件内容
 */
export async function renderModReport({ config, state, now = new Date() }) {
  const dir = config.paths?.reportsDir || resolve(config.paths?.dataDir || '.', '..', 'reports');
  await mkdir(dir, { recursive: true }).catch(() => {});

  const todayP = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const isToday = (iso) => String(iso || '').startsWith(todayP);

  const posts = Object.entries(state.posts || {})
    .map(([id, p]) => ({ id, ...p, mt: p.modTask || null }))
    .filter((p) => p.mt && (isToday(p.mt.repliedAt) || isToday(p.mt.removedAt)));

  const removed = posts.filter((p) => isToday(p.mt.removedAt));
  const needManual = posts.filter((p) => p.mt.stage === 'manual_remove_needed');
  const failed = posts.filter((p) => p.mt.failed);

  const backlog = state.modTask?.backlog || [];

  let md = `# 版主管理任务 · 今日进度

> 更新时间：${fmt(now)}
> 范围：只处理**今天 00:00 之后**的帖（加好友功能今天上线，历史帖不碰）
> 规则：**只认「加好友意图」**（加好友/扩列/互赞好友/好友位/好友码/加群/加V…）；
> 　　　活动组队（十月同游/组队/一起玩）、活动邀请码、游戏功能里的「好友」一律放过；
> 　　　**官方/版主/自己发的帖直接跳过**。
> 流程：先回固定文案 → 确认发出 → 再「论坛管理 → 移除」（自动点确认）

## 总览

| 项 | 数量 |
|---|---|
| 已移除（今天） | ${removed.length} |
| **待人工移除（今天）** | ${needManual.length} |
| 回复失败转人工 | ${failed.length} |
| 队列待处理 | ${backlog.length} |

`;

  if (needManual.length) {
    md += `## 🖐 待人工移除（${needManual.length}）

> 活动报名板（\`sub_type=activity_signup\`）网页端**没有版主管理入口** ——
> 详情页只有「返回/关注/更多」，列表卡片「⋯」只有「转发/分享/投诉」。
> 这些帖已经回好固定文案，**移除请在 App 里手动做**。

| 帖子 | 作者 | 命中 | 链接 |
|---|---|---|---|
`;
    for (const p of needManual.sort((a, b) => String(b.mt.repliedAt || '').localeCompare(String(a.mt.repliedAt || '')))) {
      md += `| ${esc(String(p.title || '').slice(0, 30))} | ${esc(p.author || '')} | ${esc(p.mt.keyword || '-')} | ${p.url || `https://www.taptap.cn/moment/${p.id}`} |\n`;
    }
    md += '\n';
  }

  if (backlog.length) {
    md += `## ⏳ 队列中（${backlog.length}）

> 队列每 2 分钟重新获取并按**最新在前**重排；正在处理的那条不会被检查打断，处理完才接新队列。

| 帖子 | 作者 | 命中 | 链接 |
|---|---|---|---|
`;
    for (const b of backlog.slice(0, 30)) {
      md += `| ${esc(String(b.title || '').slice(0, 30))} | ${esc(b.author || '')} | ${esc(b.keyword || b.reason || '-')} | ${b.url || `https://www.taptap.cn/moment/${b.id}`} |\n`;
    }
    if (backlog.length > 30) md += `\n_…还有 ${backlog.length - 30} 条_\n`;
    md += '\n';
  }

  if (removed.length) {
    md += `## ✅ 已移除（今天 ${removed.length} 条）

| 帖子 | 作者 | 命中 | 移除时间 |
|---|---|---|---|
`;
    for (const p of removed.sort((a, b) => String(b.mt.removedAt).localeCompare(String(a.mt.removedAt))).slice(0, 50)) {
      md += `| ${esc(String(p.title || '').slice(0, 30))} | ${esc(p.author || '')} | ${esc(p.mt.keyword || '-')} | ${fmt(p.mt.removedAt)} |\n`;
    }
    if (removed.length > 50) md += `\n_…还有 ${removed.length - 50} 条_\n`;
    md += '\n';
  }

  if (failed.length) {
    md += `## ⚠️ 回复失败转人工（${failed.length}）

| 帖子 | 作者 | 失败阶段 |
|---|---|---|
`;
    for (const p of failed.slice(0, 30)) {
      md += `| ${esc(String(p.title || '').slice(0, 30))} | ${esc(p.author || '')} | ${esc(p.mt.failed)} |\n`;
    }
    md += '\n';
  }

  await writeFile(resolve(dir, 'mod-tasks.md'), md, 'utf8');
  return md;
}
