// WAF 自动解锁（用户 2026-11-06 要求）
//
// 原话：「如果 WAF 拦住了，2 分钟后-5 分钟随机时间后，你可以通过浏览器模拟人类鼠标操作
//        （https://www.taptap.cn/app/54031/topic），尝试滑动解锁 WAF。最多重试 5 次。」
//
// 做法（**模拟人**，不是硬绕）：
//   ① 等 2~5 分钟**随机**（避免像脚本一样准点重试）
//   ② opencli 打开论坛版块页（真人会开的页面）
//   ③ 先探一下：页面有没有验证容器 / 有没有正常内容
//   ④ 有滑动验证 → 按人类轨迹拖：分段 + 抖动 + 随机步长/停顿
//   ⑤ 等 2s 再探：出现正常帖子内容 = 解锁成功 → 清熔断标记
//   ⑥ 最多 5 次；5 次都不行就放弃并留提示（不自作主张继续撞）
//
// ⚠️ 这是「恢复自己账号的正常访问」，不是绕过安全策略去抓数据：
//    页面是版主日常要开的版块页，动作是正常的滑动验证交互。

import { makeRunner } from './replier.mjs';
import { getTapApi } from './taptap-api.mjs';
import { readWafFlag, clearWafFlag } from './http.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

function unwrap(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    return typeof j === 'string' ? j : t;
  } catch {
    return t.replace(/^"|"$/g, '');
  }
}

/** 页面状态探针：有没有验证容器、有没有正常内容 */
const PROBE = `(()=>{
  const vis = e => { const r=e.getBoundingClientRect(); return r.width>2 && r.height>2; };
  const cls = e => ((e.className||'') + ' ' + (e.id||'')).toString();
  let hasVerify = false;
  for (const e of document.querySelectorAll('iframe,div,span')) {
    if (!vis(e)) continue;
    if (/nc-container|nc_iconfont|aliyunCaptcha|btn_slide|slide-verify|captcha/i.test(cls(e))) { hasVerify = true; break; }
  }
  const txt = document.body ? (document.body.innerText||'').slice(0, 800) : '';
  const feedCount = document.querySelectorAll('a[href*="/moment/"]').length;
  return JSON.stringify({
    hasVerify,
    feedCount,
    blockedText: /滑动|拖动|验证|安全验证|访问异常|人机/.test(txt)
  });
})()`;

/** 找滑块并按下（记录起点） */
const DRAG_START = `(()=>{
  const vis = e => { const r=e.getBoundingClientRect(); return r.width>2 && r.height>2; };
  const cls = e => ((e.className||'') + ' ' + (e.id||'')).toString();
  const list = [...document.querySelectorAll('span,div,a')].filter(e => vis(e) && /btn_slide|slide/i.test(cls(e)));
  const el = list.find(e => /btn_slide/i.test(cls(e))) || list[0];
  if (!el) return 'NO_SLIDER';
  const r = el.getBoundingClientRect();
  const x = r.left + r.width/2, y = r.top + r.height/2;
  window.__wafDrag = { x, y, dx: 0, w: r.width };
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true, clientX:x, clientY:y, view:window }));
  return JSON.stringify({ x: Math.round(x), y: Math.round(y), w: Math.round(r.width) });
})()`;

const dragMove = (step, jitter) => `(()=>{
  if (!window.__wafDrag) return 'NO_INIT';
  const d = window.__wafDrag;
  d.dx += ${Math.round(step)};
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, cancelable:true,
    clientX: d.x + d.dx, clientY: d.y + ${Math.round(jitter)}, view: window }));
  return String(Math.round(d.dx));
})()`;

const DRAG_END = `(()=>{
  if (!window.__wafDrag) return 'NO_INIT';
  const d = window.__wafDrag;
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, cancelable:true,
    clientX: d.x + d.dx, clientY: d.y, view: window }));
  return 'UP';
})()`;

/**
 * 尝试解锁一次（不含等待）
 *
 * @param {object} o
 * @param {object} o.config
 * @param {Function} [o.log]
 * @param {string} [o.url] 要打开的页面（默认论坛版块页）
 * @returns {Promise<{ok:boolean, stage:string, detail?:any}>}
 */
export async function unlockWafOnce({ config = {}, log = () => {}, url = '' } = {}) {
  const topicUrl = url || config.waf?.topicUrl || 'https://www.taptap.cn/app/54031/topic';
  const runner = makeRunner({
    opencliMain: config.reply?.opencliMain,
    session: config.reply?.session,
  });
  if (!runner.available) return { ok: false, stage: 'opencli_missing', detail: runner.reason };

  const S = runner.session;
  const oc = runner.oc;
  const ev = (js, timeout = 30000) => unwrap(oc(['browser', S, 'eval', js], { timeout }).out);

  // ① 打开论坛页（真人也会开这个页面）
  log(`  [解锁] 打开 ${topicUrl}`);
  const open = oc(['browser', S, 'open', topicUrl], { timeout: 90000 });
  if (open.code !== 0) return { ok: false, stage: 'open', detail: String(open.out || '').slice(0, 120) };
  await sleep(randInt(2500, 4500)); // 像人一样等一下页面加载

  // ② 先探一次：没有验证容器就是已解锁
  let probe = {};
  try {
    probe = JSON.parse(ev(PROBE) || '{}');
  } catch {}
  if (!probe.hasVerify && !probe.blockedText && Number(probe.feedCount || 0) > 0) {
    return { ok: true, stage: 'already_ok', detail: probe };
  }
  if (!probe.hasVerify) {
    // 没验证容器也没内容 → 可能是加载慢，再等一次
    await sleep(randInt(1500, 3000));
    try {
      probe = JSON.parse(ev(PROBE) || '{}');
    } catch {}
    if (!probe.hasVerify && Number(probe.feedCount || 0) > 0) return { ok: true, stage: 'loaded', detail: probe };
  }

  // ③ 滑动解锁（人类轨迹：分段 + 抖动 + 随机停顿）
  const started = ev(DRAG_START);
  if (!started || started === 'NO_SLIDER') {
    // 没有滑块也不算失败 —— 可能页面没验证，只是内容没渲染出来
    return { ok: false, stage: 'no_slider', detail: probe };
  }
  let info = {};
  try {
    info = JSON.parse(started);
  } catch {}

  const trackW = Number(info.w || 300);
  const total = Math.max(180, Math.min(420, trackW * 1.15)); // 略微超过轨道宽度（真人常拖过头）
  const steps = randInt(18, 28);
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    // 前段快、后段慢、带随机抖动 —— 机械等速是最容易被判定为脚本的特征
    const progress = i / steps;
    const base = (total / steps) * (progress < 0.6 ? rand(1.1, 1.6) : rand(0.6, 1.0));
    const step = Math.max(3, Math.round(base));
    const jitter = Math.round(rand(-2, 2));
    ev(dragMove(step, jitter));
    moved += step;
    await sleep(randInt(12, 38));
    if (moved > total * 1.3) break;
  }
  // 收尾：小幅回拉（真人手抖）
  ev(dragMove(-randInt(1, 3), 0));
  await sleep(randInt(120, 320));
  ev(DRAG_END);

  // ④ 等结果，再探
  await sleep(randInt(1800, 3200));
  let after = {};
  try {
    after = JSON.parse(ev(PROBE) || '{}');
  } catch {}
  const ok = !after.hasVerify && Number(after.feedCount || 0) > 0;
  if (ok) clearWafFlag();
  return { ok, stage: ok ? 'slid_ok' : 'still_blocked', detail: after };
}

/**
 * 带次数与随机等待的解锁循环（守护进程里调用）
 *
 * 规则（用户要求）：2~5 分钟**随机**后再试，最多 5 次。
 *
 * @param {object} o
 * @param {object} o.config
 * @param {number} o.attempt  已是第几次（从 1 开始）
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, stage:string, nextDelayMs?:number}>}
 */
export async function unlockWafWithWait({ config = {}, attempt = 1, log = () => {} } = {}) {
  const minS = Number(config.waf?.minDelaySeconds ?? 120);
  const maxS = Number(config.waf?.maxDelaySeconds ?? 300);
  const delayMs = Math.round(rand(minS, maxS) * 1000);
  log(`  [解锁] 第 ${attempt} 次：先随机等 ${Math.round(delayMs / 1000)}s（模拟人不会准点重试）`);
  await sleep(delayMs);

  const r = await unlockWafOnce({ config, log });
  if (r.ok) log('  [解锁] ✓ 已通过验证，恢复拉取');
  else log(`  [解锁] ✗ 未通过（${r.stage}）`);
  return { ...r, nextDelayMs: delayMs };
}