#!/usr/bin/env node
// 评论（游戏评价 review）专项守护：「账号丢失 / 存档丢失」自动回复
//
// ── 为什么单独一个守护，而不是塞进 watch.mjs ─────────────────────────────
// 评价跟论坛帖子是**两条完全不同的链路**（大哥 2026-11-23 明确「这个与论坛发言不一样」）：
//   · 论坛：富文本节点、可带表情、有楼中楼、按板块 feed 拉取
//   · 评价：contents 纯文本、无表情、只有一层回复、按 app 维度拉列表
// 塞进 watch 会让本来就大的 collect.mjs 继续膨胀，且两者的状态/游标/节奏都不一样。
//
// ── 节奏（大哥 2026-11-23 定）────────────────────────────────────────────
//   · 每轮**只回一条**（找到第一条需要回的，回完就收）
//   · **从新到旧**找
//   · **不设时间窗口**（不按「最近 N 分钟」过滤，按游标/队列持续消化）
//   · 按队列处理，**不设总量上限**（对应 D1：不设每日发送量闸）
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   node scripts/review-watch.mjs                # 常驻（默认每 120s 一轮）
//   node scripts/review-watch.mjs --once         # 只跑一轮
//   node scripts/review-watch.mjs --once --dry-run   # 只判定不发送
//   node scripts/review-watch.mjs --scan-only    # 只采集入队，不发送
//   node scripts/review-watch.mjs --status       # 看状态与队列
//
// ── 硬约束 ───────────────────────────────────────────────────────────────
//   · 幂等：同一条评价只回一次（状态文件 + 发送后读回校验）
//   · 校验：发完必须走 by-review 读回确认（列表里的 review_comments 是预览子集，不能信）
//   · 回不了就转人工：**绝不重发**（差评重发等于二次激怒）

import { loadConfig } from './lib/paths.mjs';
import { getTapApi } from './lib/taptap-api.mjs';
import { makeRunner, doctorOk } from './lib/replier.mjs';
import { ensureSingleInstance } from './lib/single-instance.mjs';
import { ACCOUNT_LOST_TEXT, shouldReplyReview } from './lib/review-guard.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const config = await loadConfig();
const RC = config.review || {};
// 专项配置子段（config.review.accountLost），跟「只读分析」那套配置分开
const AC = RC.accountLost || {};
const SKILL_ROOT = config.paths?.skillRoot || process.cwd();

const STATE_FILE = AC.stateFile || `${config.paths?.dataDir || 'data'}/review-state.json`;
const SESSION = String(AC.session || 'tapreview');
const APP_ID = AC.appId || config.appId;
const EVERY_SECONDS = Math.max(30, Number(AC.everySeconds ?? 120));
const SCAN_PAGES = Math.max(1, Number(AC.scanPages ?? 2)); // 每轮翻几页（每页 10 条）
const SIGNATURE = config.reply?.signature || '';
const ENABLED = AC.enabled !== false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleString('zh-CN');

function log(...a) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a);
}

// ─────────────────────────────────────────────────────────────
// 状态（**独立文件**：守护与其它进程各持一份 state 会互相覆盖，历史踩过）
// ─────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { cursor: { page: 0 }, reviews: {}, queue: [] };
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      cursor: s.cursor && typeof s.cursor === 'object' ? s.cursor : { page: 0 },
      reviews: s.reviews && typeof s.reviews === 'object' ? s.reviews : {},
      queue: Array.isArray(s.queue) ? s.queue : [],
    };
  } catch (e) {
    log(`[状态] 读取失败（${e.message}）→ 用空状态`);
    return { cursor: { page: 0 }, reviews: {}, queue: [] };
  }
}

function saveState(st) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
  } catch (e) {
    log(`[状态] 写入失败：${e.message}`);
  }
}

const TERMINAL = new Set(['replied', 'no_need', 'manual']);

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────
async function runOnce({ dryRun = false, scanOnly = false } = {}) {
  const runner = makeRunner({
    opencliMain: config.reply?.opencliMain,
    session: SESSION,
  });
  const doc = doctorOk(runner);
  if (!doc.ok) {
    log(`[FAIL] opencli 不可用（session=${SESSION}）：${String(doc.text || '').split('\n')[0]}`);
    return { ok: false, scanned: 0, queued: 0, replied: 0 };
  }
  const api = getTapApi({ runner, log: (m) => log(m), intervalMs: Number(AC.apiIntervalMs ?? 0) });
  if (!api.ensureOrigin?.().ok) {
    log('[FAIL] 页面上下文未就绪（ensureOrigin 失败）');
    return { ok: false, scanned: 0, queued: 0, replied: 0 };
  }

  const st = loadState();

  // ---------- ① 采集：从新到旧翻页，命中入队 ----------
  //   分页参数是 **`from`（偏移量）**，不是 page/offset（2026-11-23 实测确认）：
  //     from=0/10/20 各返回不同的一批；page/offset/page_num 全部无效（只返回第一页）。
  //   翻到底（接口不再返回 next_page）就**回卷到 0**，于是「不设时间窗口」也能持续覆盖历史。
  const PER_PAGE = 10;
  let scanned = 0;
  let queued = 0;
  let reachedEnd = false;
  let lastPage = Number(st.cursor.page || 0);
  for (let i = 0; i < SCAN_PAGES; i++) {
    const page = Number(st.cursor.page || 0) + i;
    lastPage = page;
    const from = page * PER_PAGE;
    const r = await api.reviewList({ appId: APP_ID, limit: PER_PAGE, sort: 'new', from });
    if (!r.ok) {
      log(`[采集] from=${from} 失败（${r.error}）→ 本轮停止采集`);
      break;
    }
    const list = r.list || [];
    if (!list.length) {
      log(`[采集] from=${from} 无数据 → 已到底，游标归零`);
      reachedEnd = true;
      break;
    }
    let fresh = 0;
    for (const rv of list) {
      scanned++;
      const rec = st.reviews[rv.reviewId];
      if (rec && TERMINAL.has(String(rec.status))) continue; // 已处理过
      if (st.queue.some((q) => String(q.reviewId) === rv.reviewId)) continue; // 已在队列

      const verdict = shouldReplyReview(rv, { skipScores: AC.skipScores || [] });
      if (!verdict.reply) {
        st.reviews[rv.reviewId] = {
          status: 'no_need',
          at: new Date().toISOString(),
          score: rv.score,
          why: verdict.why,
          text: String(rv.text || '').slice(0, 100),
        };
        continue;
      }
      st.queue.push({
        reviewId: rv.reviewId,
        score: rv.score,
        authorName: rv.authorName,
        publishTime: rv.publishTime,
        text: String(rv.text || '').slice(0, 200),
        why: verdict.why,
        queuedAt: new Date().toISOString(),
      });
      fresh++;
      queued++;
      log(`  [入队] ${rv.reviewId}（${rv.score}星 / ${rv.authorName || '?'}）${verdict.why}`);
      log(`         「${String(rv.text || '').replace(/\s+/g, ' ').slice(0, 46)}」`);
    }
    log(`[采集] from=${from} 页 ${page}：${list.length} 条（新入队 ${fresh}）`);
    // 接口明确没有下一页 → 到底了
    if (!r.nextPage) {
      log('[采集] 接口未再返回 next_page → 已翻到底');
      reachedEnd = true;
      break;
    }
    await sleep(Number(AC.pageDelayMs ?? 800));
  }
  // 游标推进：到底就回卷到第一页重新开始；否则接着往下翻
  st.cursor.page = reachedEnd ? 0 : lastPage + 1;
  st.cursor.lastScanAt = new Date().toISOString();

  // 队列排序：**从新到旧**（大哥要求）
  st.queue.sort((a, b) => Number(b.publishTime || 0) - Number(a.publishTime || 0));

  if (scanOnly) {
    saveState(st);
    log(`[采集完成] 扫描 ${scanned} 条，队列 ${st.queue.length} 条（scan-only，不发送）`);
    return { ok: true, scanned, queued, replied: 0 };
  }
  if (!st.queue.length) {
    saveState(st);
    log(`[空队列] 扫描 ${scanned} 条，没有需要回复的评价`);
    return { ok: true, scanned, queued, replied: 0 };
  }

  // ---------- ② 处理：**只取一条**（大哥：先找一条） ----------
  const item = st.queue[0];
  const text = String(AC.text || ACCOUNT_LOST_TEXT);
  log(`\n  -- 回复评价 ${item.reviewId}（${item.score}星 / ${item.authorName || '?'}）`);
  log(`     「${String(item.text || '').replace(/\s+/g, ' ').slice(0, 60)}」`);

  if (dryRun) {
    log('     [dry-run] 不发送。将发送正文：');
    log(
      text
        .split('\n')
        .map((l) => `       | ${l}`)
        .join('\n')
    );
    st.queue.shift();
    st.reviews[item.reviewId] = { status: 'pending', at: new Date().toISOString(), score: item.score, dryRun: true };
    saveState(st);
    return { ok: true, scanned, queued, replied: 0 };
  }

  // 发送（keepNewlines：分步骤的自查指引压成一行就没法读了）
  const sent = await api.reviewReply({
    reviewId: item.reviewId,
    text,
    signature: AC.signature === false ? '' : SIGNATURE,
    keepNewlines: true,
  });
  if (!sent.ok) {
    log(`     [FAIL] 发送失败（${sent.stage || sent.status}）→ 转人工，不重发`);
    st.queue.shift();
    st.reviews[item.reviewId] = {
      status: 'manual',
      at: new Date().toISOString(),
      score: item.score,
      why: `send_${sent.stage || sent.status}`,
    };
    saveState(st);
    return { ok: false, scanned, queued, replied: 0 };
  }

  // 校验落库（必须走 by-review；列表里的 review_comments 是预览子集）
  // ⚠️ 2026-11-24 修：服务端有写入延迟 —— 固定等 1.2s 就查，实测 18 条**明明发出去了**
  //    却读不到 → 被误记成 manual(sent_but_unverified)。抽查 5 条全部其实已落库。
  //    改成「等 → 查 → 没有就再等再查」，仍查不到才记人工。
  const tries = Math.max(1, Number(AC.verifyRetries ?? 3));
  let v = { found: false };
  for (let i = 0; i < tries; i++) {
    await sleep(Number(AC.verifyDelayMs ?? 2500) * (i + 1));
    v = await api.hasReviewReplyText({ reviewId: item.reviewId, text: sent.contents });
    if (v.found) break;
    if (i < tries - 1) log(`     [校验] 第 ${i + 1}/${tries} 次没读到 → 再等等`);
  }
  st.queue.shift();
  if (v.found) {
    st.reviews[item.reviewId] = {
      status: 'replied',
      at: new Date().toISOString(),
      score: item.score,
      commentId: v.id ?? null,
      // 🆕 2026-11-24：留原文存证 —— 一晚回上百条，事后审计必须能看出「当时凭什么判它」
      text: String(item.text || '').slice(0, 160),
      why: item.why || '',
    };
    log(`     [OK] 已回复并校验落库（commentId=${v.id || '-'}）`);
  } else {
    // 发出去了但读回没找到：**不重发**（差评重发等于二次激怒），记 manual 让人看
    st.reviews[item.reviewId] = {
      status: 'manual',
      at: new Date().toISOString(),
      score: item.score,
      why: 'sent_but_unverified',
      text: String(item.text || '').slice(0, 160),
    };
    log('     [WARN] 已发送但多次读回仍未校验到 → 记人工，不重发');
  }
  saveState(st);
  log(`  [队列] 剩余 ${st.queue.length} 条`);
  return { ok: true, scanned, queued, replied: v.found ? 1 : 0 };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
if (hasFlag('--status')) {
  const st = loadState();
  const stat = {};
  for (const v of Object.values(st.reviews)) stat[v.status] = (stat[v.status] || 0) + 1;
  console.log('评价守护状态');
  console.log(`  状态文件：${STATE_FILE}`);
  console.log(`  session ：${SESSION}　appId：${APP_ID}`);
  console.log(`  游标页  ：${st.cursor.page ?? 0}　上次扫描：${st.cursor.lastScanAt || '-'}`);
  console.log(`  已记录  ：${Object.keys(st.reviews).length} 条　${JSON.stringify(stat)}`);
  console.log(`  待回队列：${st.queue.length} 条`);
  for (const q of st.queue.slice(0, 10)) {
    console.log(`    · ${q.reviewId}（${q.score}星）${String(q.text || '').slice(0, 40)}`);
  }
  process.exit(0);
}

// 总开关（config.review.accountLost.enabled）：关掉就整体停，不影响论坛链路
if (!ENABLED && !hasFlag('--status')) {
  console.log('[退出] review.accountLost.enabled = false → 账号丢失专项回复已关闭（改配置即可开启）');
  process.exit(0);
}

// 单实例：端口锁（第二份启动会 listen 失败 → 立刻退出，避免双实例重复回复）
await ensureSingleInstance({ port: Number(config.daemon?.ports?.review ?? 45873), name: 'review-watch' });

console.log(`═══════════════════════════════════════
  评论（游戏评价）守护 · 账号/存档丢失专项
  检查每 ${EVERY_SECONDS}s　|　每轮只回 1 条　|　从新到旧　|　不设时间窗口
  只回「账号丢失 / 存档丢失」语义，其余一律不碰
  session ${SESSION}　appId ${APP_ID}　状态 ${STATE_FILE}
  停止：Ctrl+C
═══════════════════════════════════════`);

if (hasFlag('--once')) {
  const r = await runOnce({ dryRun: hasFlag('--dry-run'), scanOnly: hasFlag('--scan-only') });
  console.log(`\n结果：扫描 ${r.scanned} 条 / 入队 ${r.queued} / 回复 ${r.replied}`);
  process.exit(r.ok ? 0 : 1);
}

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\n[退出] 收到中断，处理完本轮后停止');
});

for (;;) {
  if (stopping) break;
  try {
    await runOnce({});
  } catch (e) {
    log(`[异常] 本轮出错（${e.message}）→ 下一轮继续`);
  }
  if (stopping) break;
  await sleep(EVERY_SECONDS * 1000);
}