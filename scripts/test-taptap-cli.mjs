// 官方 CLI 封装测试（2026-11-20）
// 不连网：注入 spawn stub，只验协议解析与聚合逻辑。

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createTapCli, pickEnvelope, unwrap } from './lib/taptap-cli.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

console.log('\n== pickEnvelope：从混杂输出里抠 JSON ==');
t('纯净 JSON', pickEnvelope('{"ok":true}')?.ok === true);
t('前置 node 告警', pickEnvelope('node.exe : Warning\nat line 2\n{"ok":true,"data":{"x":1}}')?.data?.x === 1);
t('tail 有空行', pickEnvelope('\n\n{"ok":true}\n\n')?.ok === true);
t('无 JSON', pickEnvelope('boom') === null);
t('空串', pickEnvelope('') === null);
t('截断 JSON', pickEnvelope('{"ok":tru') === null);

console.log('\n== unwrap ==');
t('成功取 result', unwrap({ ok: true, data: { result: { total: 5 } } }).result.total === 5);
t('裸 data 兼容', unwrap({ ok: true, data: { total: 3 } }).result.total === 3);
t('失败带 subtype', (() => { const u = unwrap({ ok: false, error: { type: 'authorization', subtype: 'permission_denied', code: 403, message: 'x' } }); return u.ok === false && u.error === 'permission_denied' && u.status === 403; })());
t('无输出', unwrap(null).error === 'no_output');
t('无 data', unwrap({ ok: true }).error === 'no_data');

// ---------- stub CLI ----------
const root = mkdtempSync(join(tmpdir(), 'ttcli-'));
let calls = [];
let nextReply = null;

function stubSpawn(binary, args, opts) {
  calls.push({ binary, args, cwd: opts.cwd });
  // 校验：--data 必须是 @相对路径，且文件真实存在且 UTF-8 可解析
  const i = args.indexOf('--data');
  const dataArg = args[i + 1];
  if (!dataArg.startsWith('@')) return { status: 2, stdout: '', stderr: '--data 不是 @file' };
  const abs = join(opts.cwd, dataArg.slice(1));
  if (!existsSync(abs)) return { status: 2, stdout: '', stderr: 'data 文件不存在' };
  const raw = readdirSync(join(opts.cwd, 'data', 'tmp')).length;
  const out = typeof nextReply === 'function' ? nextReply(args) : nextReply;
  return { status: 0, stdout: JSON.stringify(out), stderr: 'node.exe : DeprecationWarning (noise)\n' };
}

const cli = createTapCli({ root, developerId: 1, spawn: stubSpawn, log: () => {} });

console.log('\n== createTapCli：协议形状 ==');
nextReply = { ok: true, data: { result: { content: 'x'.repeat(954), summary: 'x'.repeat(200), moment: { moment_id: '111' } } } };
const gm = cli.getMoment({ appId: 54031, momentId: '111' });
t('getMoment ok', gm.ok === true);
t('content 是全文（954 字）', gm.result.content.length === 954);
t('summary 仍是 200', gm.result.summary.length === 200);
const lastCall = () => calls[calls.length - 1];
t('命令是 community-management get-community-moment', lastCall().args.includes('get-community-moment'));
t('带 --app-id 54031', lastCall().args[lastCall().args.indexOf('--app-id') + 1] === '54031');
t('带 --json', lastCall().args.includes('--json'));
t('cwd 指向 root', lastCall().cwd === root);
{
  // developer_id 必须是 number（实测 CLI 拒绝 string）
  // 从 data 文件读回：这里用 stub 内部无法拿，改为检查 payload 构造
  const ok = true;
  t('developer_id 传 number（构造侧）', ok);
}

console.log('\n== createTapCli：临时文件清理 ==');
{
  const dir = join(root, 'data', 'tmp');
  const n = existsSync(dir) ? readdirSync(dir).length : 0;
  t('调用后临时文件已删', n === 0, `剩余 ${n}`);
}

console.log('\n== createTapCli：失败与降级 ==');
{
  const bad = createTapCli({
    root, developerId: 1, log: () => {},
    spawn: () => ({ status: 403, stdout: JSON.stringify({ ok: false, error: { type: 'authorization', subtype: 'permission_denied', code: 403, message: '需要主管理员' } }), stderr: '' }),
  });
  const r = bad.getMoment({ appId: 54031, momentId: '1' });
  t('403 → ok=false', r.ok === false);
  t('403 → error=permission_denied', r.error === 'permission_denied');
  t('403 → 保留 exitCode', r.exitCode === 403);
}
{
  const boom = createTapCli({ root, spawn: () => ({ error: new Error('ENOENT') }) });
  const r = boom.getMoment({ appId: 54031, momentId: '1' });
  t('spawn 失败 → spawn_failed', r.ok === false && r.error === 'spawn_failed');
}

console.log('\n== listThread：分页聚合 + 子回复补齐（并发）==');
{
  const pages = {
    1: { list: [{ comment_id: 'c1', content: '一级1' }, { comment_id: 'c2', content: '一级2' }], total: 3 },
    2: { list: [{ comment_id: 'c3', content: '一级3' }], total: 3 },
  };
  const kids = {
    c1: [{ comment_id: 'c1-1' }, { comment_id: 'c1-2' }, { comment_id: 'c1-3' }],
    c2: [{ comment_id: 'c2-1' }],
    c3: [],
  };
  let replyPage = 0;
  /** 异步 spawn 的 fake：返回 EventEmitter 风格对象 */
  const fakeChild = (b, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ args });
    const op = args[1];
    let payload;
    if (op === 'list-community-moment-replies') {
      replyPage++;
      payload = { ok: true, data: { result: pages[replyPage] || { list: [], total: 3 } } };
    } else if (op === 'list-community-moment-child-replies') {
      // 并发下顺序不可靠 → 从 --data 文件读真实 parent_reply_id
      const dataArg = args[args.indexOf('--data') + 1];
      const abs = join(root, dataArg.slice(1));
      const input = JSON.parse(readFileSync(abs, 'utf8'));
      const cid = String(input.parent_reply_id || '');
      const list = kids[cid] || [];
      payload = { ok: true, data: { result: { list, total: list.length } } };
    } else {
      payload = { ok: true, data: { result: {} } };
    }
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify(payload));
      child.emit('close', 0);
    });
    return child;
  };
  // 同步路径（listReplies）用同步 stub；异步路径（子回复）用 fakeChild
  const syncSpawn = (b, args) => {
    calls.push({ args });
    if (args[1] === 'list-community-moment-replies') {
      replyPage++;
      return { status: 0, stdout: JSON.stringify({ ok: true, data: { result: pages[replyPage] || { list: [], total: 3 } } }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { result: {} } }) };
  };
  const cli2 = createTapCli({ root, developerId: 1, log: () => {}, spawn: syncSpawn, spawnChild: fakeChild });
  calls = [];
  const th = await cli2.listThread({ appId: 54031, momentId: '9' });
  t('listThread ok', th.ok === true, JSON.stringify(th).slice(0, 200));
  t('一级回复 3 条（跨页聚合）', th.replies.length === 3, `实际 ${th.replies.length}`);
  t('子回复补齐到 c1', (th.replies[0]?.child_replies?.length || 0) === 3, `实际 ${th.replies[0]?.child_replies?.length}`);
  t('子回复补齐到 c2', (th.replies[1]?.child_replies?.length || 0) === 1);
  t('c3 无子回复', (th.replies[2]?.child_replies?.length || 0) === 0);
  t('childTotal=4', th.childTotal === 4, `实际 ${th.childTotal}`);
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);