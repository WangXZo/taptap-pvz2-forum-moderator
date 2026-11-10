#!/usr/bin/env node
// WAF 熔断管理 CLI（用户 2026-11-06：「WAF 拦截，无时间限制，需要人工验证解除」）
//
// TapTap 的阿里云 WAF 封禁**没有自动解封时间** —— 必须人工到浏览器完成人机验证。
// 所以守护进程的做法是：一被拦就熔断（只留走页面上下文的通知源），等你处理完再放行。
//
// 用法：
//   node scripts/waf.mjs status    # 看当前是否处于熔断（默认命令）
//   node scripts/waf.mjs test      # 试探一次 feed 接口（匿名通道；被拦会失败）
//   node scripts/waf.mjs page      # 试探**页面通道**（带登录 Cookie，通常才是通的）
//   node scripts/waf.mjs unlock    # 用浏览器模拟人类滑动去解锁（2~5 分钟随机后试，最多 5 次）
//   node scripts/waf.mjs clear     # 人工验证通过后，解除熔断
//
// 流程：
//   ① 守护进程日志出现「被 WAF 拦截」→ 自动写 data/waf-blocked.json（并且**不再重试**）
//   ② 你到 Chrome 打开 https://www.taptap.cn/app/54031/topic ，完成人机验证
//   ③ node scripts/waf.mjs page  → 确认页面通道通
//   ④ node scripts/waf.mjs clear → 解除熔断，守护进程下一轮自动恢复
//
// ⚠️ 匿名通道（test）和页面通道（page）是两条路：
//    匿名 fetch 固定 UA 且不带 Cookie，即使人已解锁也可能继续被拦；
//    页面通道走已登录浏览器，不受这个限制 —— 拉数据已优先走页面通道。

import { loadConfig } from './lib/paths.mjs';
import { listFeed, readWafFlag, clearWafFlag, wafFlagPath } from './lib/http.mjs';
import { unlockWafWithWait } from './lib/waf-unlock.mjs';

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'status').toLowerCase();

function fmt(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return String(iso || '');
  }
}

if (cmd === 'status') {
  const flag = readWafFlag();
  if (!flag) {
    console.log('✓ 当前**没有** WAF 熔断标记 —— 可以正常拉取论坛接口');
    process.exit(0);
  }
  console.log('✗ 当前处于 WAF 熔断状态');
  console.log(`  首次拦截：${fmt(flag.at)}`);
  console.log(`  最近拦截：${fmt(flag.lastAt)}  路径：${flag.path || '(未知)'}`);
  console.log(`  标记文件：${wafFlagPath()}`);
  console.log('');
  console.log('  ⚠️ WAF 拦截**没有自动解封时间**，必须人工验证：');
  console.log('     ① 到 Chrome 打开 https://www.taptap.cn ，完成人机验证，能正常刷出帖子');
  console.log('     ② node scripts/waf.mjs test    → 确认接口通了');
  console.log('     ③ node scripts/waf.mjs clear   → 解除熔断，守护进程下一轮自动恢复');
  process.exit(0);
}

if (cmd === 'clear') {
  const ok = clearWafFlag();
  console.log(ok ? '✓ 已解除熔断标记 —— 守护进程下一轮检查会恢复拉取 feed' : '（没有熔断标记，无需解除）');
  process.exit(0);
}

if (cmd === 'page') {
  // 页面通道（带登录 Cookie）—— 拉数据实际走的就是这条
  const config = await loadConfig();
  const { createPageFetcher } = await import('./lib/page-fetch.mjs');
  const { setPageFetcher } = await import('./lib/http.mjs');
  const pf = createPageFetcher({ config, log: (m) => console.log(m) });
  if (!pf) {
    console.log('✗ 页面通道不可用（Chrome 没开 / opencli 扩展没连）');
    process.exit(1);
  }
  setPageFetcher(pf);
  try {
    const d = await listFeed({ groupId: config.groupId, from: 0, limit: 3, sort: 'created', type: 'feed' });
    const n = (d.list || []).length;
    console.log(`✓ 页面通道正常，拿到 ${n} 条`);
    if (readWafFlag()) console.log('  提示：还有熔断标记，确认无误后运行：node scripts/waf.mjs clear');
    process.exit(0);
  } catch (e) {
    console.log(`✗ 页面通道也不通：${e.message}`);
    process.exit(1);
  }
}

if (cmd === 'unlock') {
  // 手动解锁：2~5 分钟随机等 → 打开论坛页 → 模拟人类滑动 → 最多 5 次
  const config = await loadConfig();
  const maxAttempts = Number(process.argv[3] || config.waf?.maxAttempts || 5);
  console.log(`开始尝试解锁（最多 ${maxAttempts} 次；每次先随机等 2~5 分钟）…`);
  for (let i = 1; i <= maxAttempts; i++) {
    const r = await unlockWafWithWait({ config, attempt: i, log: console.log });
    if (r.ok) {
      clearWafFlag();
      console.log('✓ 解锁成功，熔断已解除');
      process.exit(0);
    }
  }
  console.log('✗ 5 次都没成功 —— 建议人工在浏览器里完成验证，别继续撞');
  process.exit(1);
}

if (cmd === 'test') {
  const config = await loadConfig();
  try {
    const d = await listFeed({ groupId: config.groupId, from: 0, limit: 3, sort: 'created', type: 'feed' });
    const n = (d.list || []).length;
    console.log(`✓ feed 接口正常，拿到 ${n} 条`);
    if (readWafFlag()) {
      console.log('  提示：还有熔断标记，确认无误后运行：node scripts/waf.mjs clear');
    }
    process.exit(0);
  } catch (e) {
    console.log(`✗ feed 接口仍不可用：${e.message}`);
    console.log('  → 继续到浏览器完成人机验证，别反复试（会加重封禁）');
    process.exit(1);
  }
}

console.error('用法：node scripts/waf.mjs status|test|clear');
process.exit(1);