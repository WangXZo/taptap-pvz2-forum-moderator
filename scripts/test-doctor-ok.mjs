#!/usr/bin/env node
// 回归测试：doctorOk —— opencli doctor 输出格式兼容（2026-11-12）
//
// 事故：DSH 升到 0.2.2-rc.2（opencli 2.0.3）后，doctor 输出从**纯文本**改成 **JSON**：
//   旧：`... Extension: connected ...`
//   新：`{"ok":true,"data":{"extensionConnected":true,"issues":[]}}`
// doctorOk 只认旧正则 → 永远判「不可用」→ **所有浏览器通道操作被静默跳过**
//   （回复 / 夸码 / 撮合 / 版主任务全废，日志只有一行 `[FAIL] opencli 不可用`）。
//
// 这里把两种格式都锁住，防止下次升级再踩。
import { doctorOk, toOpencliArgs, detectSessionStyle, resolveOpencliMain } from './lib/replier.mjs';

const OPENCLI_MAIN = resolveOpencliMain();

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 造一个假 runner，只回固定文本 */
const fake = (text) => ({ available: true, oc: () => ({ code: 0, out: text, err: '', text, json: null }) });

console.log('=== ① 新版 JSON 格式（opencli 2.0.3）===');
{
  const NEW = JSON.stringify({
    ok: true,
    data: {
      cliVersion: '2.0.3',
      daemonRunning: true,
      extensionConnected: true,
      extensionVersion: '1.0.27',
      profiles: [{ contextId: '89ysg8ca', extensionConnected: true }],
      issues: [],
    },
  });
  const r = doctorOk(fake(NEW));
  check('新版 JSON → 判为可用', r.ok === true, JSON.stringify(r).slice(0, 200));
}

console.log('\n=== ② 旧版文本格式（老 opencli）===');
{
  const OLD = 'opencli 2.0.0\nDaemon: running\nExtension: connected (v1.0.20)\n';
  const r = doctorOk(fake(OLD));
  check('旧版文本 → 判为可用', r.ok === true, r.text?.slice(0, 120));
}

console.log('\n=== ③ 真的不通 → 必须判不可用 ===');
{
  const BAD_JSON = JSON.stringify({
    ok: true,
    data: { daemonRunning: true, extensionConnected: false, profiles: [], issues: ['extension not connected'] },
  });
  check('新版 JSON：扩展未连接 → 不可用', doctorOk(fake(BAD_JSON)).ok === false);

  const BAD_TEXT = 'opencli 2.0.0\nDaemon: running\nExtension: NOT connected\n';
  check('旧版文本：未连接 → 不可用', doctorOk(fake(BAD_TEXT)).ok === false);

  check('runner 不可用 → 不可用', doctorOk({ available: false, reason: '没装 opencli' }).ok === false);
}

console.log('\n=== ④ profiles 里有人连着也算通 ===');
{
  const P = JSON.stringify({
    ok: true,
    data: { daemonRunning: true, extensionConnected: false, profiles: [{ extensionConnected: true }], issues: [] },
  });
  check('顶层 false 但 profiles 有连着的 → 可用', doctorOk(fake(P)).ok === true);
}

console.log('\n=== ⑤ 坏了的输出不能崩 ===');
{
  check('空输出 → 不可用（不抛）', doctorOk(fake('')).ok === false);
  check('乱码 → 不可用（不抛）', doctorOk(fake('not json at all')).ok === false);
  check('半截 JSON → 不可用（不抛）', doctorOk(fake('{"ok":true,"data":{')).ok === false);
}

console.log('\n=== ⑥ opencli 2.x 参数语法转换（同一轮升级踩的第二个坑）===');
{
  // 事故：opencli 2.0.3 把 browser 子命令的 session 从位置参数改成 --session 旗标。
  //   旧 `opencli browser tap state` → 报 unknown command 'tap'
  //   → 41 处浏览器调用全废，日志只显示 `[FAIL] 失败（open）`，极易误判成「扩展没连」。
  const OLD = ['browser', 'tap', 'state'];
  const NEW = toOpencliArgs(OLD, 'flag');
  check(
    'flag 模式：session 变 --session',
    NEW.join(' ') === 'browser --session tap state',
    NEW.join(' ')
  );
  check('flag 模式：其余参数保序', toOpencliArgs(['browser', 'tap', 'open', 'https://x'], 'flag').join(' ') ===
    'browser --session tap open https://x');
  check('positional 模式：原样不动', toOpencliArgs(OLD, 'positional').join(' ') === 'browser tap state');
  check('已带 --session 的写法不被二次改写',
    toOpencliArgs(['browser', '--session', 'tap', 'state'], 'flag').join(' ') === 'browser --session tap state');
  check('非 browser 命令不受影响', toOpencliArgs(['doctor'], 'flag').join(' ') === 'doctor');
  check('两段式 browser <cmd> 不误插 session', toOpencliArgs(['browser', 'state'], 'flag').join(' ') === 'browser state');
  check('空/异常输入不崩', toOpencliArgs(null, 'flag') === null && toOpencliArgs([], 'flag').length === 0);
  // X1（2026-11-18）：注入 spawn 的确定断言 —— 不再依赖真实环境（沙盒 piped spawn 会 EPERM）
  const stub = (out) => () => ({ stdout: out, stderr: '' });
  check('stub: 2.0.3 → flag', detectSessionStyle('x', { spawnImpl: stub('2.0.3'), useCache: false }) === 'flag');
  check('stub: 1.9.1 → positional', detectSessionStyle('x', { spawnImpl: stub('1.9.1'), useCache: false }) === 'positional');
  check('stub: 输出乱码 → positional', detectSessionStyle('x', { spawnImpl: stub('no version'), useCache: false }) === 'positional');
  check('stub: 抛错（沙盒 EPERM）→ positional 不崩', detectSessionStyle('x', { spawnImpl: () => { throw new Error('EPERM'); }, useCache: false }) === 'positional');
  // 真环境断言降为可选：只有 --env 才跑（避免沙盒下必红）
  if (process.argv.includes('--env')) {
    check('真实 2.x 版本被识别为 flag 模式', detectSessionStyle(OPENCLI_MAIN || '', { useCache: false }) === 'flag' || !OPENCLI_MAIN,
      `style=${OPENCLI_MAIN ? detectSessionStyle(OPENCLI_MAIN, { useCache: false }) : 'n/a(无 opencli)'}`);
  } else {
    console.log('  (真环境断言已跳过：加 --env 才跑)');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
