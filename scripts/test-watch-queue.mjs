#!/usr/bin/env node
// 守护队列入队回归测试（用户 2026-11-06）
//
// 锁两件事：
//   ① 通知（回复我 / @我 / 呼唤我）里的帖子**必须能入队** —— 哪怕它早已滑出最新 10 条
//   ② 队列**只重排、不删**：按发布时间新→旧排序，超过 10 条是正常的（上限 200）
//
// 纯离线。

import {
  collectNotifyIds,
  enqueueNotifyIds,
  enqueueNotifyFromNotes,
  enqueueFeedItem,
  sortAndCap,
} from './lib/watch-queue.mjs';

let ok = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

// ---------- 1. collectNotifyIds ----------
t('空 state → 空列表', collectNotifyIds().length === 0);
t('空对象 → 空列表', collectNotifyIds({}).length === 0);

const state1 = {
  interactPending: { P1: { reason: '回复了你的评论' }, P2: { reason: '@了你' } },
  posts: { P3: { interactPending: true }, P4: { interactPending: false } },
};
const ids1 = collectNotifyIds(state1);
t('全局表里的都收', ids1.some((x) => x.id === 'P1') && ids1.some((x) => x.id === 'P2'));
t('帖子级标记也收', ids1.some((x) => x.id === 'P3'));
t('没标记的帖子不收', !ids1.some((x) => x.id === 'P4'));
t('带出原因', ids1.find((x) => x.id === 'P1')?.reason === '回复了你的评论');

// 同一个 id 两处都有 → 只算一条
const ids2 = collectNotifyIds({
  interactPending: { P9: { reason: 'x' } },
  posts: { P9: { interactPending: true } },
});
t('两处重复的只算一条', ids2.filter((x) => x.id === 'P9').length === 1, JSON.stringify(ids2));

// ---------- 2. enqueueNotifyIds ----------
{
  const queue = [];
  const queued = new Set();
  const state = {
    interactPending: { OLD1: { reason: '回复了你的评论' }, OLD2: { reason: '@了你' } },
    // 注意：这两个帖**不在**最新 10 条里，state.posts 也没有 → publishTime = 0
    posts: {},
  };
  const r = enqueueNotifyIds(queue, state, queued);
  t('通知帖全部入队', r.added === 2 && queue.length === 2, JSON.stringify(r));
  t('入队原因带「通知：」前缀', queue[0].why.startsWith('通知：'), queue[0].why);
  t('id 已记入 queued', queued.has('OLD1') && queued.has('OLD2'));
  t('不在 state 里也不影响入队（publishTime=0）', queue.every((q) => Number(q.publishTime) === 0));

  // 再跑一次：不重复入队
  const r2 = enqueueNotifyIds(queue, state, queued);
  t('已在队列里的不重复加', r2.added === 0 && queue.length === 2, JSON.stringify(r2));
}

// 已有 publishTime 的帖子 → 排序时能排到正确位置
{
  const queue = [];
  const queued = new Set();
  const state = {
    interactPending: { N1: { reason: '回复' } },
    posts: { N1: { publishTime: 1700000000 } },
  };
  enqueueNotifyIds(queue, state, queued);
  t('能从 state 取到发布时间', Number(queue[0].publishTime) === 1700000000, JSON.stringify(queue[0]));
}

// ---------- 3. sortAndCap：只重排不删，可超过 10 条 ----------
{
  const queue = [
    { id: 'a', publishTime: 100 },
    { id: 'b', publishTime: 300 },
    { id: 'c', publishTime: 200 },
  ];
  const sorted = sortAndCap(queue, 200);
  t('按发布时间新→旧', sorted.map((x) => x.id).join('') === 'bca', sorted.map((x) => x.id).join(''));

  // 12 条 > 10 条 → 一条都不能少
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), publishTime: i }));
  const kept = sortAndCap(many, 200);
  t('超过 10 条也不截断（12 条都在）', kept.length === 12, String(kept.length));
  t('排序正确（最大的在最前）', kept[0].id === '11', kept[0].id);

  // 超过上限才截
  const over = Array.from({ length: 205 }, (_, i) => ({ id: String(i), publishTime: i }));
  t('超过上限 200 才截断', sortAndCap(over, 200).length === 200);
  t('截断保留的是最新的', sortAndCap(over, 200)[0].id === '204');
}

// ---------- 4. 混合场景：feed 新帖 + 通知老帖并存 ----------
{
  const queue = [
    { id: 'FRESH', publishTime: 999, why: '新帖' },
  ];
  const queued = new Set(['FRESH']);
  const state = {
    interactPending: { OLDPOST: { reason: '回复了你的评论' } },
    posts: {},
  };
  enqueueNotifyIds(queue, state, queued);
  const out = sortAndCap(queue, 200);
  t('新帖和通知老帖都在队列里', out.length === 2);
  t('新帖排前面，老帖排后面', out[0].id === 'FRESH' && out[1].id === 'OLDPOST', out.map((x) => x.id).join(','));
}

// ---------- 5. enqueueNotifyFromNotes：直接用通知接口结果入队 ----------
{
  const queue = [];
  const queued = new Set();
  const notes = [
    { momentId: 'M1', title: '回复了你的评论', action: 'comment', time: 1700000200 },
    { momentId: 'M2', title: '@了你', action: 'at', time: 1700000100 },
    { momentId: 'M3', title: '赞了你的帖子', action: 'like', time: 1700000050 },
    { momentId: '', title: '没有 id 的脏数据' },
  ];
  const aboutMe = (n) => !/赞|收藏|关注/.test(String(n?.title || ''));
  const r = enqueueNotifyFromNotes(queue, notes, queued, aboutMe);
  t('回复/@ 的帖子入队', r.added === 2, JSON.stringify(r));
  t('点赞不入队', !queue.some((q) => q.id === 'M3'));
  t('没有 momentId 的跳过', queue.every((q) => q.id));
  t('标记 needsComments（强制读评论）', queue.every((q) => q.needsComments === true));
  t('原因带「通知：」前缀', queue[0].why.startsWith('通知：'), queue[0].why);
  t('已在队列的不重复', enqueueNotifyFromNotes(queue, notes, queued, aboutMe).added === 0);
}

// ---------- 5b. 通知去重：已处理完的帖不能重复入队（2026-11-06 真踩到） ----------
{
  const queue = [];
  const queued = new Set();
  const notes = [
    { momentId: 'DONE1', title: '回复了你的评论' }, // 已 replied 且无 pending → 跳过
    { momentId: 'DONE2', title: '@了你' }, // 已 no_need 且无 pending → 跳过
    { momentId: 'PENDING1', title: '回复了你的评论' }, // replied 但 interactPending=true → 要入队
    { momentId: 'NEW1', title: '回复了你的评论' }, // state 里没有 → 要入队
  ];
  const stateLike = {
    posts: {
      DONE1: { status: 'replied', interactPending: false },
      DONE2: { status: 'no_need', interactPending: false },
      PENDING1: { status: 'replied', interactPending: true },
    },
  };
  const shouldSkip = (id) => {
    const p = stateLike.posts[id];
    if (p) return (p.status === 'replied' || p.status === 'no_need') && !p.interactPending;
    return false;
  };
  const r = enqueueNotifyFromNotes(queue, notes, queued, () => true, shouldSkip);
  t('已处理完的帖被跳过（不重复入队）', !queue.some((q) => q.id === 'DONE1') && !queue.some((q) => q.id === 'DONE2'));
  t('待互动的帖仍要入队', queue.some((q) => q.id === 'PENDING1'));
  t('state 里没有的帖正常入队', queue.some((q) => q.id === 'NEW1'));
  t('跳过数量正确', r.skipped === 2 && r.added === 2, JSON.stringify(r));

  // 不传 shouldSkip 时行为不变（向后兼容）
  const q2 = [];
  const r2 = enqueueNotifyFromNotes(q2, notes, new Set(), () => true);
  t('不传 shouldSkip → 全量入队', r2.added === 4, JSON.stringify(r2));
}

// ---------- 5d. 动态窗口（通用模块 lib/window-fetch.mjs，2026-11-10） ----------
// 「只拉一页 10 条」→ 停机超过几小时那批帖永远滑出窗口（实测覆盖只有 39%）
{
  const { fetchWindow, createCursorStore } = await import('./lib/window-fetch.mjs');
  const NOW = 1_800_000_000_000;

  // 造一个分页源：每页 10 条，越往后越旧（按真实密度：10 条 ≈ 4 小时）
  const makeSource = (totalPages) => {
    const calls = [];
    const fetchPage = async ({ from, limit }) => {
      calls.push(from);
      const page = Math.floor(from / limit);
      const list = [];
      for (let i = 0; i < limit; i++) {
        const idx = from + i;
        if (idx >= totalPages * limit) break;
        list.push({ t: NOW - idx * 24 * 60000 }); // 每条往前 24 分钟（≈ 10 条 4 小时）
      }
      return { list, next_page: page + 1 < totalPages ? `p${page + 1}` : null };
    };
    return { fetchPage, calls };
  };

  // ① 没有游标 → 只补 backfillMs（默认 6h），不该翻满页
  const src1 = makeSource(100);
  const r1 = await fetchWindow({
    fetchPage: src1.fetchPage,
    cursorMs: null,
    backfillMs: 6 * 3600 * 1000,
    nowMs: NOW,
    timeOf: (it) => it.t,
  });
  t('第一次：按 backfill 停，不翻满页', r1.pages < 10, `pages=${r1.pages}`);
  t('第一次：扫到的条数 = 页数 × 10', r1.items.length === r1.pages * 10, `${r1.items.length}/${r1.pages}`);
  // 游标 = **高水位**（扫到的最新一条），不是最老那条
  t('第一次：游标 = 扫到的最新一条（高水位）', r1.cursorMs === Math.max(...r1.items.map((x) => x.t)));

  // ② 有游标 → 翻到比游标还老就停（能补停机期间的缺口）
  const src2 = makeSource(100);
  const gapCursor = NOW - 30 * 3600 * 1000; // 停机 30 小时
  const r2 = await fetchWindow({
    fetchPage: src2.fetchPage,
    cursorMs: gapCursor,
    nowMs: NOW,
    timeOf: (it) => it.t,
  });
  t('停机 30h → 翻的页数够补缺口', r2.pages >= 8, `pages=${r2.pages}`);
  t('停机 30h → 翻到了游标之前', r2.oldestMs <= gapCursor, String(r2.oldestMs));
  t('停机 30h → reached 标记为真', r2.reached === true);
  t('停机 30h → 新游标前移到高水位', r2.cursorMs > gapCursor, String(r2.cursorMs));

  // ②b 关键回归：**下一轮不会又翻到同样的深度**
  //     游标存高水位（而不是最老那条）→ 第二轮只翻 1~2 页，深度收敛
  const src2b = makeSource(100);
  const r2b = await fetchWindow({
    fetchPage: src2b.fetchPage,
    cursorMs: r2.cursorMs, // 用上一轮的新游标
    nowMs: NOW,
    timeOf: (it) => it.t,
  });
  t('第二轮：深度收敛（≤2 页）', r2b.pages <= 2, `pages=${r2b.pages}`);

  // ③ maxPages 兜底：不让它无限翻
  const src3 = makeSource(1000);
  const r3 = await fetchWindow({
    fetchPage: src3.fetchPage,
    cursorMs: NOW - 1000 * 3600 * 1000,
    maxPages: 5,
    nowMs: NOW,
    timeOf: (it) => it.t,
  });
  t('maxPages 兜底生效', r3.pages === 5, `pages=${r3.pages}`);

  // ④ 单页就够（游标很新）→ 只翻 1 页
  const src4 = makeSource(100);
  const r4 = await fetchWindow({
    fetchPage: src4.fetchPage,
    cursorMs: NOW - 60 * 1000,
    nowMs: NOW,
    timeOf: (it) => it.t,
  });
  t('游标很新 → 只翻 1 页', r4.pages === 1, `pages=${r4.pages}`);

  // ⑤ 游标仓库：落盘 + 读回
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
  const f = join(dir, 'c.json');
  const c1 = createCursorStore(f);
  c1.set('created', 123456);
  c1.save();
  const c2 = createCursorStore(f);
  t('游标落盘后能读回', c2.get('created') === 123456, String(c2.get('created')));
  t('没有的来源返回 null', c2.get('commented') === null);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ---------- 5b-2. 天宫码撮合（lib/code-match.mjs，2026-11-10 用户规则） ----------
// 规则：新发码（5 分钟内）→ 链接发给 30 分钟内求码的人；每个码最多 3 人；
//       没有求贴就不处理；优先新求码贴；发码超过 5 分钟不再发。
{
  const { pickCodeMatches, buildCodeMatchText } = await import('./lib/code-match.mjs');
  const NOW = 1_800_000_000_000;
  const mk = (id, text, min) => ({ id, title: '', text, publishTime: NOW - min * 60000 });

  const base = [
    mk('S1', 'JFAabcdefg 给大家用', 2), // 2 分钟前发码 → 有效
    mk('A1', '蹲一个天宫码', 3),
    mk('A2', '求一个天宫码，蹲了好久了', 10),
    mk('A3', '求天宫码', 20),
    mk('A4', '求个天宫码', 25),
  ];
  const r1 = pickCodeMatches({ items: base, nowMs: NOW });
  t('撮合：命中 1 条发码帖', r1.length === 3 && new Set(r1.map((x) => x.share.id)).size === 1);
  t('撮合：每个码最多 3 个人', r1.length === 3, String(r1.length));
  t('撮合：优先新求码贴（A1 最先）', r1[0].asker.id === 'A1', r1[0].asker.id);
  t('撮合：顺序按新→旧', r1.map((x) => x.asker.id).join(',') === 'A1,A2,A3', r1.map((x) => x.asker.id).join(','));

  // 发码超过 5 分钟 → 不再发、不处理
  const oldShare = [mk('S2', 'JFAhijklmn 分享', 6), mk('A1', '求天宫码', 2)];
  t('撮合：发码帖超 5 分钟 → 不处理', pickCodeMatches({ items: oldShare, nowMs: NOW }).length === 0);

  // 没有求贴 → 不处理
  const noAsk = [mk('S3', 'JFAzzzzzzz 分享', 1)];
  t('撮合：没有求码帖 → 不处理', pickCodeMatches({ items: noAsk, nowMs: NOW }).length === 0);

  // 求码帖超 30 分钟 → 不再通知
  const lateAsk = [mk('S4', 'JFAqqqqqqq 分享', 1), mk('A9', '求天宫码', 31)];
  t('撮合：求码帖超 30 分钟 → 不通知', pickCodeMatches({ items: lateAsk, nowMs: NOW }).length === 0);

  // 自己贴码又求码 → 不撮合自己
  const self = [mk('X1', 'JFAmmmmmmm 求个天宫码换一下', 1)];
  t('撮合：求码帖不撮合自己', pickCodeMatches({ items: self, nowMs: NOW }).length === 0);

  // 已撮合过的对不再发
  const once = pickCodeMatches({
    items: base,
    nowMs: NOW,
    isDone: (askerId, shareId) => askerId === 'A1' && shareId === 'S1',
  });
  t('撮合：同一对只撮合一次', !once.some((x) => x.asker.id === 'A1'));

  // 文案：会话式开场 + 让他去谢谢大佬 + **链接放最后**（用户 2026-11-10 给的样式）
  const msg = buildCodeMatchText({ share: { id: 'S9' } });
  const link = 'https://www.taptap.cn/moment/S9';
  t('文案：带帖子链接', msg.includes(link));
  t('文案：链接在结尾', msg.trimEnd().endsWith(link), msg);
  t('文案：自称小鲸鱼（人格化）', /小鲸鱼/.test(msg), msg);
  t('文案：趁热 / 快去领 的口气', /趁热|快去领/.test(msg), msg);
  t('文案：让他去谢谢大佬', /谢谢/.test(msg), msg);
  t('文案：不含签名（由发送层统一追加）', !msg.includes('版主助手'));
  t('文案：同一发码帖措辞稳定（可复现）', buildCodeMatchText({ share: { id: 'S9' } }) === msg);
  const msgs = ['S1', 'S2', 'S3', 'S4'].map((id) => buildCodeMatchText({ share: { id } }));
  t('文案：不同发码帖会换说法（不是同一条模板）', new Set(msgs).size > 1, String(new Set(msgs).size));
}

// ---------- 5c. 指纹去重：同一帖同一条回复只入队一次（2026-11-06 用户要求） ----------
{
  const { notifyFingerprint, pruneSeen } = await import('./lib/watch-queue.mjs');
  const noteA = { momentId: 'M1', commentId: 'C1', title: '回复了你的评论', content: '你试试冰车' };
  const noteA2 = { momentId: 'M1', commentId: 'C1', title: '回复了你的评论', content: '内容改了点' }; // 同一条回复
  const noteB = { momentId: 'M1', commentId: 'C2', title: '回复了你的评论', content: '还是不行' }; // 同一帖的新回复
  t('同帖同评论 → 指纹相同', notifyFingerprint(noteA) === notifyFingerprint(noteA2));
  t('同帖不同评论 → 指纹不同', notifyFingerprint(noteA) !== notifyFingerprint(noteB));

  const queue = [];
  const queued = new Set();
  const seen = {};
  const r1 = enqueueNotifyFromNotes(queue, [noteA], queued, () => true, () => false, seen);
  t('第一次入队成功', r1.added === 1, JSON.stringify(r1));
  t('指纹已记账', Boolean(seen[notifyFingerprint(noteA)]));

  // 队列被处理掉（queued 清空），同一条通知再来 → 也不能再入队
  queued.clear();
  const q2 = [];
  const r2 = enqueueNotifyFromNotes(q2, [noteA2], queued, () => true, () => false, seen);
  t('同一条回复不再入队（dup）', r2.added === 0 && r2.dup === 1, JSON.stringify(r2));
  t('队列里没被加入', q2.length === 0);

  // 同一帖的新回复 → 可以入队
  const q3 = [];
  const r3 = enqueueNotifyFromNotes(q3, [noteB], queued, () => true, () => false, seen);
  t('同帖新回复可以入队', r3.added === 1, JSON.stringify(r3));

  // 指纹裁剪
  const big = {};
  for (let i = 0; i < 1000; i++) big['k' + i] = i;
  t('指纹表裁剪到上限', Object.keys(pruneSeen(big, 800)).length === 800);
}

// ---------- 6. enqueueFeedItem：feed 单条入队 ----------
{
  const queue = [];
  const queued = new Set();
  t('首次入队成功', enqueueFeedItem(queue, queued, { id: 'F1', publishTime: 100, why: '新帖' }) === true);
  t('重复入队被拒', enqueueFeedItem(queue, queued, { id: 'F1', publishTime: 100 }) === false);
  t('空 id 被拒', enqueueFeedItem(queue, queued, { id: '' }) === false);
  t('入队后 id 进集合', queued.has('F1'));
}

// ---------- 7. 三源合并场景：created 新帖 + commented 老帖 + 通知 ----------
{
  const queue = [];
  const queued = new Set();
  // created 源
  enqueueFeedItem(queue, queued, { id: 'NEW1', publishTime: 3000, why: '新帖' });
  // commented 源（老帖被回复，发布时间更早）
  enqueueFeedItem(queue, queued, { id: 'OLD_REPLIED', publishTime: 1000, why: '回复时间榜新帖' });
  // 通知源
  enqueueNotifyFromNotes(
    queue,
    [{ momentId: 'NOTIFIED', title: '回复了你的评论', time: 2000 }],
    queued,
    () => true
  );
  const out = sortAndCap(queue, 200);
  t('三源都在队列里', out.length === 3, out.map((x) => x.id).join(','));
  t('按时间新→旧排序', out.map((x) => x.id).join(',') === 'NEW1,NOTIFIED,OLD_REPLIED', out.map((x) => x.id).join(','));
  t('队列可以超过 10 条（这里 3 条不受 10 限制）', out.length === 3);
}

console.log(`通过 ${ok} 条`);
if (fail) {
  console.log(`失败 ${fail} 条`);
  process.exit(1);
}
console.log('全部通过 ✓');