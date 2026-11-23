// T30 测试（2026-11-20）：回访复查机制
//
// 场景（大哥报的实例）：帖 872166231715613408
//   我们 14:19:01 回了他 → 他 14:19:25 回「老年人用不惯qq」→ 我们再没回过
//   根因：唤醒只靠通知接口，而 @ 当时是纯文本（不触发通知）
// 解法：定期把「我们回过的帖」重新读一遍评论
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './lib/db.mjs';
import { pickRevisitTargets, enqueueRevisitTargets, markRevisit, REVISIT_EVENT } from './lib/revisit.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 't30-'));
const db = openDb(join(dir, 'rec.sqlite'));
const NOW = 1_800_000_000_000;

function addReplied(id, title, updatedAt) {
  db.prepare(
    `INSERT INTO post_record (id, title, qa_status, updated_at, first_seen) VALUES (?, ?, 'replied', ?, ?)`
  ).run(id, title, updatedAt, updatedAt);
}

console.log('\n== pickRevisitTargets：基本 ==');
{
  addReplied('P1', '帖一', NOW - 3600000);       // 1 小时前回过
  addReplied('P2', '帖二', NOW - 7200000);       // 2 小时前
  const r = pickRevisitTargets({ db, config: {}, now: NOW });
  t('ok=true', r.ok === true);
  t('找到 2 个', r.ids.length === 2, `实际 ${r.ids.length}`);
  t('按最后回复时间倒序', r.ids[0].id === 'P1', JSON.stringify(r.ids.map((x) => x.id)));
  t('带上了标题', r.ids[0].title === '帖一');
}

console.log('\n== 只回访「我们回过」的帖 ==');
{
  db.prepare(`INSERT INTO post_record (id, title, qa_status, updated_at) VALUES (?, ?, 'no_need', ?)`)
    .run('P3', '无需回复的帖', NOW - 3600000);
  db.prepare(`INSERT INTO post_record (id, title, qa_status, updated_at) VALUES (?, ?, 'manual', ?)`)
    .run('P4', '需人工的帖', NOW - 3600000);
  const r = pickRevisitTargets({ db, config: {}, now: NOW });
  t('不含 no_need', !r.ids.some((x) => x.id === 'P3'), JSON.stringify(r.ids.map((x) => x.id)));
  t('不含 manual', !r.ids.some((x) => x.id === 'P4'));
}

console.log('\n== 回访窗口（revisitDays）==');
{
  // 10 天前回过的 → 超出 3 天窗口
  addReplied('P_OLD', '很久以前的帖', NOW - 10 * 86400000);
  const r = pickRevisitTargets({ db, config: {}, now: NOW });
  t('超出窗口的不回访', !r.ids.some((x) => x.id === 'P_OLD'), JSON.stringify(r.ids.map((x) => x.id)));
  const r2 = pickRevisitTargets({ db, config: { interact: { revisitDays: 30 } }, now: NOW });
  t('窗口放大就包含', r2.ids.some((x) => x.id === 'P_OLD'));
}

console.log('\n== 回访间隔（revisitEveryMinutes）==');
{
  // 刚回访过 → 跳过（时间戳注入 NOW，保持与假时钟一致）
  markRevisit(db, 'P1', { title: '帖一' }, NOW);
  const r = pickRevisitTargets({ db, config: {}, now: NOW });
  t('刚查过的被跳过', !r.ids.some((x) => x.id === 'P1'), JSON.stringify(r.ids.map((x) => x.id)));
  t('记了 skipped', r.skipped >= 1, String(r.skipped));
  // 31 分钟后 → 又该查
  const r2 = pickRevisitTargets({ db, config: {}, now: NOW + 31 * 60000 });
  t('超过间隔又出现', r2.ids.some((x) => x.id === 'P1'), JSON.stringify(r2.ids.map((x) => x.id)));
}

console.log('\n== 单轮上限 ==');
{
  for (let i = 0; i < 15; i++) addReplied(`PL${i}`, `帖${i}`, NOW - i * 1000);
  const r = pickRevisitTargets({ db, config: {}, now: NOW, limit: 5 });
  t('不超过 limit', r.ids.length <= 5, `实际 ${r.ids.length}`);
}

console.log('\n== 开关关闭 ==');
{
  const r = pickRevisitTargets({ db, config: { interact: { revisitRepliedPosts: false } }, now: NOW });
  t('关闭 → 空', r.ids.length === 0);
  t('原因标记为 disabled', r.reason === 'disabled');
}

console.log('\n== 无库 / 异常不炸 ==');
{
  t('无 db → ok=false', pickRevisitTargets({ db: null, config: {}, now: NOW }).ok === false);
  t('markRevisit(null) → false', markRevisit(null, 'X') === false);
}

console.log('\n== enqueueRevisitTargets：入队 ==');
{
  const queue = [];
  const queued = new Set();
  const added = enqueueRevisitTargets(queue, queued, [{ id: 'P1', title: '帖一', lastReplyAt: NOW }], { log: () => {} });
  t('入队 1 个', added === 1);
  t('队列长度 1', queue.length === 1);
  t('needsComments=true（强制重读评论）', queue[0].needsComments === true, JSON.stringify(queue[0]));
  t('why 标记回访', queue[0].why === '回访复查');
  // 重复入队
  const added2 = enqueueRevisitTargets(queue, queued, [{ id: 'P1', title: '帖一', lastReplyAt: NOW }], { log: () => {} });
  t('不重复入队', added2 === 0 && queue.length === 1);
}

console.log('\n== markRevisit：落库 ==');
{
  const row = db.prepare('SELECT post_id, kind FROM post_event WHERE kind = ? LIMIT 1').get(REVISIT_EVENT);
  t('写了 revisit 事件', Boolean(row), JSON.stringify(row));
  t('post_id 正确', row?.post_id === 'P1');
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);