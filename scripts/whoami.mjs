#!/usr/bin/env node
// 读取当前 Chrome 里 TapTap 登录态的 user_id，用于判断「我是否已回复过」
// 只读同源 cookie，不上传任何东西
//
// 用法：node scripts/whoami.mjs

import { loadConfig, sleep } from './lib/paths.mjs';
import { makeRunner } from './lib/replier.mjs';

const config = await loadConfig();
const runner = makeRunner({
  opencliMain: config.reply.opencliMain,
  session: config.reply.session || 'tap',
});
if (!runner.available) {
  console.error('[whoami]', runner.reason);
  process.exit(1);
}

console.log('[whoami] 打开 TapTap…');
runner.oc(['browser', runner.session, 'open', 'https://www.taptap.cn/'], { timeout: 90000 });
await sleep(3500);

const js =
  "(()=>{const g=k=>{const m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));return m?decodeURIComponent(m[1]):null};" +
  "return JSON.stringify({userId:g('user_id'),accountsUserId:g('ACCOUNTS_USER_ID'),loggedIn:!!g('user_id')})})()";

const out = runner.oc(['browser', runner.session, 'eval', js], { timeout: 60000 }).text;
const m = out.match(/\{[\s\S]*?\}/);
if (!m) {
  console.error('[whoami] 解析失败，原始输出：\n' + out.slice(0, 400));
  process.exit(1);
}
const info = JSON.parse(m[0]);
console.log('[whoami]', info);

if (!info.loggedIn) {
  console.error('\n[whoami] 当前浏览器未登录 TapTap。请先在这个 Chrome 里登录 www.taptap.cn，再重跑。');
  process.exit(2);
}

console.log('\n把下面这行填进 scripts/config.json：');
console.log(`  "myUserId": "${info.userId}",`);

runner.oc(['browser', runner.session, 'close']);
