// 插件：review（评价只读分析，P4-c，2026-11-19）
//
// 大哥 2026-11-18 决策：**只读分析 + 低分提醒，不自动回复评价**（评价对外公开、性质比论坛回帖更重；
// 删评也归人工）。所以本插件只有 scheduled，没有 planBatch（永不发送）。
//
// 数据源：lib 里已有的评价接口能力（scripts/review.mjs 系列 / lib 无直连时由调用方注入 fetchReviews）。
// 为控制风险：**默认关闭**（config.review.enabled=false），开启后也只在 scheduled 里跑一次分析出报告。
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILL_ROOT } from '../lib/paths.mjs';

const reportsDirOf = (config) => String(config?.paths?.reportsDir || resolve(SKILL_ROOT, 'reports')).replace(/\{\{SKILL\}\}/g, SKILL_ROOT);
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 低分判定（1-2 星）+ 关键词归类（纯规则，零成本） */
const NEG_WORDS = [
  { k: '闪退/崩溃', re: /闪退|崩溃|卡死|打不开/ },
  { k: '卡顿/掉帧', re: /卡顿|掉帧|掉线|延迟/ },
  { k: '收费/逼氪', re: /收费|逼氪|氪金|骗钱|太贵|抽不到/ },
  { k: '平衡/难度', re: /不平衡|难度|太难|削弱|增强|数值/ },
  { k: '客服/申述', re: /客服|申诉|退款|封号|举报/ },
  { k: '版本/更新', re: /版本|更新|bug|维护/ },
];

export function analyzeReviews(list = [], { lowScoreMax = 2 } = {}) {
  const lows = [];
  const byTag = {};
  for (const r of list) {
    const score = Number(r?.score ?? r?.star ?? 0);
    const text = String(r?.text || r?.contents?.json?.[0]?.children?.[0]?.text || '').trim();
    if (!text) continue;
    if (score > lowScoreMax) continue;
    lows.push({ score, text: text.slice(0, 160), at: r?.createdAt || r?.updated_time || null });
    for (const { k, re } of NEG_WORDS) if (re.test(text)) byTag[k] = (byTag[k] || 0) + 1;
  }
  return { total: list.length, lowCount: lows.length, lows, byTag };
}

export function renderReviewReport({ analyzed, date, config } = {}) {
  const L = [];
  L.push(`# 评价分析（只读）${date}`);
  L.push('');
  L.push(`> 生成于 ${new Date().toLocaleString('zh-CN')} ｜ **不自动回复评价**（决策：评价对外公开，处置归人工）`);
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('|---|---|');
  L.push(`| 本次分析条数 | ${analyzed?.total ?? 0} |`);
  L.push(`| 低分（≤2星）条数 | ${analyzed?.lowCount ?? 0} |`);
  L.push('');
  const tags = analyzed?.byTag || {};
  const keys = Object.keys(tags).sort((a, b) => tags[b] - tags[a]);
  if (keys.length) {
    L.push('## 差评归因（关键词规则）');
    L.push('');
    L.push('| 类别 | 条数 |');
    L.push('|---|---|');
    for (const k of keys) L.push(`| ${k} | ${tags[k]} |`);
    L.push('');
  }
  const lows = (analyzed?.lows || []).slice(0, 20);
  if (lows.length) {
    L.push('## 低分评价原文（供人工判断，最多 20 条）');
    L.push('');
    for (const x of lows) L.push(`- [${x.score}★] ${x.text}`);
    L.push('');
  }
  if (!analyzed?.total) L.push('_本次无评价数据（接口未返回或未启用）_');
  return L.join('\n');
}

export default {
  id: 'review',
  name: '评价分析（只读）',

  /**
   * @param {object} ctx {config, log, fetchReviews?: async () => Array}
   * fetchReviews 由调用方注入（默认从 scripts 里已有的评价接口能力取；缺失则安全跳过）。
   */
  async scheduled(ctx = {}) {
    const { config = {}, log = () => {}, fetchReviews = null } = ctx;
    if (config.review?.enabled !== true) return { skipped: 'disabled' };
    let list = [];
    if (typeof fetchReviews === 'function') {
      try { list = (await fetchReviews()) || []; } catch (e) { log(`  [评价] 拉取失败（${e.message}）→ 跳过`); return { skipped: 'fetch_failed' }; }
    } else {
      // 没注入取数函数 → 不擅自调接口（评价接口有 WAF/权限风险）
      log('  [评价] 未注入 fetchReviews → 本次跳过（避免擅自调评价接口）');
      return { skipped: 'no_fetcher' };
    }
    const analyzed = analyzeReviews(list, { lowScoreMax: Number(config.review?.lowScoreMax ?? 2) });
    const date = ymd(new Date());
    const md = renderReviewReport({ analyzed, date, config });
    const out = resolve(reportsDirOf(config), `评价分析-${date}.md`);
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, md);
    log(`  [评价] 分析 ${analyzed.total} 条（低分 ${analyzed.lowCount}）→ ${out}（不回复）`);
    return { ok: true, out, total: analyzed.total, lowCount: analyzed.lowCount };
  },
};