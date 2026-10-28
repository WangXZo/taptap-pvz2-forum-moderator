#!/usr/bin/env node
// 「答疑库缺口」报表：把没命中答疑库的问题汇总起来，告诉你该补什么
//
// 为什么需要它：
//   实测 12 轮守护里「待回复」一直是 0 —— 不是阈值太高，而是答疑库跟真实问题几乎不重叠。
//   降阈值没用（分数两极分布），唯一有效的办法是**照着真实问题补库**。
//   这个脚本就是那份「该补什么」的清单。
//
// 用法：
//   node scripts/report-gaps.mjs             # 从状态库统计（历史上所有未命中的提问）
//   node scripts/report-gaps.mjs --fresh 20  # 顺带抓最新 20 条，把当下也没命中的一起算上
//
// 输出：reports/gaps.md

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { loadQaLibrary, matchPost, looksLikeQuestion } from './lib/qa.mjs';
import { loadState, STATUS, REASON } from './lib/state.mjs';

const argv = process.argv.slice(2);
const { argOf } = argvOf(argv);
const config = await loadConfig();
const qa = await loadQaLibrary(config.paths.qaFile);
const state = await loadState(config.paths.stateFile);

/** 从标题里提「主题词」：去掉疑问词、标点、长数字/兑换码、单字 */
const STOP = /^(怎么|如何|什么|有没有|是不是|能不能|为什么|请问|求助|大佬|萌新|新手|一下|这个|那个|可以|时候|知道|问题|帮忙|问下)/;
function topics(title) {
  const t = String(title || '')
    .replace(/\[表情[^\]]*\]/g, '')
    .replace(/[A-Za-z0-9]{6,}/g, ' ')
    .replace(/[^\u4e00-\u9fa5]+/g, ' ')
    .trim();
  const out = new Set();
  for (const seg of t.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= seg.length; i += 2) {
      const w = seg.slice(i, i + 2);
      if (!STOP.test(w)) out.add(w);
    }
  }
  return [...out];
}

const gaps = [];
let skippedNonQuestion = 0;
for (const [id, p] of Object.entries(state.posts || {})) {
  if (p.status !== STATUS.MANUAL) continue;
  if (p.reason !== REASON.NO_QA_MATCH && p.reason !== REASON.LOW_CONFIDENCE) continue;
  // 历史状态里可能残留旧规则下的判定（例如「【官方攻略】…」曾被判成提问）
  // → 用当前规则再过一遍，非提问的不算缺口
  if (!looksLikeQuestion(p.title || '')) {
    skippedNonQuestion++;
    continue;
  }
  gaps.push({ id, title: p.title || '(无标题)', url: p.url, reason: p.reason, at: p.lastSeen || '' });
}

// 可选：把当前最新帖子也过一遍，找出「现在也没命中」的
let freshRows = [];
const fresh = Number(argOf('--fresh', 0));
if (fresh > 0) {
  const { listFeed, extractText, MOMENT_URL } = await import('./lib/http.mjs');
  try {
    const feed = await listFeed({ groupId: config.groupId, from: 0, limit: Math.min(fresh, 10), sort: 'created' });
    const top = Math.min(fresh, 3);
    for (const item of feed.list) {
      const m = item.moment || {};
      const { title, text } = extractText(item);
      const cands = matchPost(text, qa, 1);
      const score = cands[0]?.score ?? 0;
      if (score < config.match.autoReplyScore) {
        freshRows.push({
          id: String(m.id_str),
          url: MOMENT_URL(String(m.id_str)),
          title: title || text.slice(0, 30) || '(无标题)',
          score: Number(score.toFixed(3)),
          nearest: cands[0]?.entry?.question || '-',
        });
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (freshRows.length >= top) break;
    }
  } catch (e) {
    console.error(`[fresh] 抓取失败：${e.message}`);
  }
}

// 主题词频统计：出现 ≥2 次的说明是「反复被问但库里没有」
const freq = new Map();
for (const g of gaps) for (const w of topics(g.title)) freq.set(w, (freq.get(w) || 0) + 1);
const hot = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20);

const lines = [];
lines.push('# 答疑库缺口报表');
lines.push('');
lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}`);
lines.push(`> 答疑库现有 **${qa.length}** 条；本报表统计「没命中答疑库」的提问，用来决定补什么条目。`);
lines.push('> 补库后跑一次 `node scripts/collect.mjs --dry-run` 看命中是否提升即可。');
lines.push('');

if (hot.length) {
  lines.push('## 高频主题词（反复被问，库里没有）');
  lines.push('');
  lines.push('| 主题词 | 出现次数 | 建议动作 |');
  lines.push('|---|---|---|');
  for (const [w, n] of hot) {
    lines.push(`| ${w} | ${n} | 在答疑库里加一条含「${w}」关键词的问答 |`);
  }
  lines.push('');
}

lines.push('## 未命中的提问清单');
lines.push('');
if (!gaps.length && !freshRows.length) {
  lines.push('_（暂无。可能是新库还没积累。）_');
} else {
  lines.push('| # | 标题 | 链接 | 说明 |');
  lines.push('|---|---|---|---|');
  let i = 1;
  for (const g of gaps.slice(0, 200)) {
    const why = g.reason === REASON.LOW_CONFIDENCE ? '分数不足' : '未命中任何条目';
    lines.push(`| ${i++} | ${String(g.title).replace(/\|/g, '/').slice(0, 40)} | ${g.url || '-'} | ${why} |`);
  }
  for (const f of freshRows) {
    lines.push(`| ${i++} | ${String(f.title).replace(/\|/g, '/').slice(0, 40)} | ${f.url} | 当前分数 ${f.score}（最接近：${f.nearest}） |`);
  }
}
lines.push('');

if (freshRows.length) {
  lines.push('## 当前最新帖的匹配情况');
  lines.push('');
  lines.push('| 标题 | 分数 | 最接近的条目 |');
  lines.push('|---|---|---|');
  for (const f of freshRows) lines.push(`| ${String(f.title).slice(0, 36)} | ${f.score} | ${f.nearest} |`);
  lines.push('');
}

lines.push('## 怎么补才有效');
lines.push('');
lines.push('1. **关键词写玩家的口语，不写书面语**：');
lines.push('   - 差：`关键词：钻石, 免费钻石`');
lines.push('   - 好：`关键词：钻石, 缺钻, 钻石不够, 刷钻, 钻石怎么来, 没钻石`');
lines.push('2. **一条问答覆盖多种问法**：把「打不过 / 卡关 / 过不去 / 卡在几关 / 这关怎么过」都列进关键词');
lines.push('3. **别把活动编号写进关键词**（`1234567890` 这类只属于当次活动，过期就废）');
lines.push('4. 沉淀条目会带题干原话，**人工把关键词改口语化**后匹配能力会明显提升');
lines.push('5. 阈值先别动：实测 0.75 降到 0.45 命中数一模一样（分数两极分布），问题是覆盖不是阈值');
lines.push('');

const out = `${config.paths.reportsDir}/gaps.md`.replace(/\//g, '\\');
await mkdir(config.paths.reportsDir, { recursive: true }).catch(() => {});
await writeFile(`${config.paths.reportsDir}/gaps.md`, lines.join('\n'), 'utf8');

console.log(`答疑库 ${qa.length} 条`);
console.log(
  `未命中提问 ${gaps.length} 条` +
    (skippedNonQuestion ? `（已排除 ${skippedNonQuestion} 条按当前规则判定为非提问的历史记录）` : '') +
    (freshRows.length ? `，另有当前最新 ${freshRows.length} 条也未命中` : '')
);
if (hot.length) console.log(`高频主题词：${hot.slice(0, 8).map(([w, n]) => `${w}(${n})`).join(' ')}`);
console.log(`已写入 ${config.paths.reportsDir}/gaps.md`);
