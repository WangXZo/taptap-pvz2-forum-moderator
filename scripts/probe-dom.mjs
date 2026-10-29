#!/usr/bin/env node
// TapTap 页面结构探针（DOM 逆向/排障工具）
//
// 什么时候用：TapTap 前端改版导致「找不到回复框 / 表情插不上 / 楼中楼点不开」时，
// 用它把当前页面结构 dump 出来，对照 references/selectors.md 校准选择器。
//
// 用法：node scripts/probe-dom.mjs <子命令> [参数]
//   comment <momentId> [commentId]   打开帖子 → 展开楼中楼 → dump 编辑器/按钮/工具栏结构
//   editor                          dump 帖子顶层评论框结构（输入框/工具栏/发送按钮）
//   emoji                           dump 表情面板（分组 + 全部表情 id/alt）
//   watch <momentId> [秒数]          装点击记录器并轮询 —— 用户手动操作时抓 DOM 变化
//   eval <js文件>                    跑一段 JS（stdout 干净，不会被 stderr 污染）
//
// 注意：
//   * 只读探测，**不会发送任何内容**（comment 子命令只点开输入框，不填字）
//   * 需要 opencli 扩展已连接（opencli doctor）
//   * 沙盒里跑会被 EPERM 拦（node 抓子进程管道），需要提权

import { readFileSync } from 'node:fs';
import { makeRunner } from './lib/replier.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runner = makeRunner({ session: 'tap' });
if (!runner.available) {
  console.error(runner.reason);
  process.exit(1);
}
const S = runner.session;

// ⚠️ 只取 stdout：oc().text 会把 stderr（opencli 升级提示、node 警告）混进来，
//    导致 Number() 得 NaN、JSON.parse 失败
const call = (args, timeout = 60000) => runner.oc(args, { timeout });
const ev = (js, timeout = 30000) => {
  const r = call(['browser', S, 'eval', js], timeout);
  const o = String(r.out || '').trim();
  if (!o) return '';
  try {
    const j = JSON.parse(o);
    return typeof j === 'string' ? j : o;
  } catch {
    return o;
  }
};

const openPost = async (momentId) => {
  const r = call(['browser', S, 'open', `https://www.taptap.cn/moment/${momentId}`], 90000);
  if (r.code !== 0) console.error('[open] 失败：', String(r.out || r.err).slice(0, 200));
  await sleep(5200);
  ev('(()=>{window.scrollTo(0,document.body.scrollHeight);return 1})()');
  await sleep(2400);
};

async function cmdComment(momentId, commentId) {
  await openPost(momentId);
  const item = commentId ? `[data-comment-id="${commentId}"]` : '[data-comment-id]';
  const firstId = commentId || null;

  console.log('== 页面上有哪些评论 ==');
  console.log(
    ev(`(()=>JSON.stringify([...document.querySelectorAll('[data-comment-id]')].map(e=>({
      id:e.getAttribute('data-comment-id'), cls:String(e.className).slice(0,40),
      text:(e.innerText||'').replace(/\\n+/g,' / ').slice(0,60)
    })),null,1))()`)
  );

  if (!firstId) {
    console.log('\n（没给 commentId，只列出评论。加一个 commentId 可以继续展开楼中楼）');
    return;
  }

  const ITEM = `[data-comment-id="${firstId}"]`;
  const boxReady = () =>
    ev(`(()=>{const it=document.querySelector('${ITEM}');if(!it)return 'NO';const b=[...it.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='发送');return b?'YES':'NO'})()`) === 'YES';

  if (!boxReady()) {
    console.log('\n== 展开楼中楼（点 .moment-post__tool-reply 里的 svg/path）==');
    ev(`(()=>{const it=document.querySelector('${ITEM}');const icon=it&&it.querySelector('.moment-post__tool-reply');if(!icon)return 0;const t=icon.querySelector('path')||icon.querySelector('svg')||icon;t.scrollIntoView({block:'center'});['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));return 1})()`);
    for (let i = 0; i < 12 && !boxReady(); i++) await sleep(800);
  }
  console.log('楼中楼已展开：', boxReady());

  console.log('\n== 条内结构 ==');
  console.log(
    ev(`(()=>{
  const it=document.querySelector('${ITEM}');
  if(!it) return 'NO_ITEM';
  const eds=[...it.querySelectorAll('[contenteditable=true]')].map((e,i)=>{
    const chain=[]; let n=e;
    for(let k=0;k<6&&n;k++){ chain.push(n.tagName+'.'+String(n.getAttribute('class')||'').split(/\\s+/).slice(0,2).join('.')); n=n.parentElement; }
    return {i, h:e.getBoundingClientRect().height, chain};
  });
  const btns=[...it.querySelectorAll('button')].map(b=>({cls:String(b.getAttribute('class')||'').slice(0,42),txt:(b.textContent||'').trim(),aria:b.getAttribute('aria-label')}));
  const wraps=[...it.querySelectorAll('.tap-editor-toolbar-item__wrap')].map((w,i)=>({
    i, visible:w.getBoundingClientRect().width>0,
    trigger:!!w.querySelector('.tap-popover__trigger-wrap'),
    emojiPanel:!!w.querySelector('.tap-editor-emoji-lists'),
    svgPath:(w.querySelector('svg path')?.getAttribute('d')||'').slice(0,26)
  }));
  return JSON.stringify({eds, btns, toolbars:wraps},null,1);
})()`)
  );

  console.log('\n== 表情面板（页面级 portal）==');
  console.log(
    ev(`(()=>{
  const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  const pop=[...document.querySelectorAll('.tap-editor-emoji__popover')].filter(ok);
  const imgs=[...document.querySelectorAll('img[data-tap-editor-emoji-id]')].filter(ok);
  return JSON.stringify({
    visiblePopovers: pop.length,
    visibleEmojiImgs: imgs.length,
    sample: imgs.slice(0,6).map(e=>({alt:e.getAttribute('alt'), id:e.getAttribute('data-tap-editor-emoji-id')}))
  },null,1);
})()`)
  );
}

async function cmdEditor() {
  console.log('== 顶层评论框 ==');
  console.log(
    ev(`(()=>{
  const eds=[...document.querySelectorAll('[contenteditable=true]')].map((e,i)=>{
    const chain=[]; let n=e;
    for(let k=0;k<5&&n;k++){ chain.push(n.tagName+'.'+String(n.getAttribute('class')||'').split(/\\s+/).slice(0,2).join('.')); n=n.parentElement; }
    return {i, h:e.getBoundingClientRect().height, visible:e.offsetParent!==null, chain};
  });
  const btns=[...document.querySelectorAll('button')].filter(b=>(b.textContent||'').trim()==='发送').map(b=>({cls:String(b.getAttribute('class')||'').slice(0,40)}));
  const wraps=[...document.querySelectorAll('.tap-editor-toolbar-item__wrap')].map((w,i)=>({i, visible:w.getBoundingClientRect().width>0, trigger:!!w.querySelector('.tap-popover__trigger-wrap')}));
  return JSON.stringify({eds, sendButtons:btns, toolbars:wraps},null,1);
})()`)
  );
}

async function cmdEmoji() {
  const all = ev(`(()=>{
  const imgs=[...document.querySelectorAll('img[data-tap-editor-emoji-id]')];
  return JSON.stringify(imgs.map(e=>({id:e.getAttribute('data-tap-editor-emoji-id'), alt:e.getAttribute('alt')})),null,0);
})()`);
  let list = [];
  try {
    list = JSON.parse(all || '[]');
  } catch {}
  console.log(`表情面板共 ${list.length} 个（未展开时面板里的图也可能已在 DOM 中）`);
  for (const e of list.slice(0, 80)) console.log(`  ${String(e.id).padStart(4)}  ${e.alt}`);
  if (list.length > 80) console.log(`  … 还有 ${list.length - 80} 个`);
}

async function cmdWatch(momentId, seconds) {
  const dur = Number(seconds || 180);
  await openPost(momentId);
  ev(`(()=>{
  if(window.__recInstalled) return 'already';
  window.__recInstalled = true; window.__oc_clicks = [];
  const describe = (el) => {
    const path=[]; let n=el;
    for(let i=0;i<5&&n;i++){ path.push(n.tagName+'.'+String(n.getAttribute('class')||'').split(/\\s+/).slice(0,2).join('.')); n=n.parentElement; }
    return { tag:el.tagName, cls:String(el.getAttribute('class')||''), txt:(el.textContent||'').trim().slice(0,20),
             aria:el.getAttribute('aria-label'), path };
  };
  ['click','mousedown'].forEach(type=>{
    document.addEventListener(type,(e)=>{
      const t=e.target;
      window.__oc_clicks.push({type, at:Date.now(), el:describe(t), parent:t.parentElement?describe(t.parentElement):null});
      if(window.__oc_clicks.length>80) window.__oc_clicks.shift();
    }, true);
  });
  return 'installed';
})()`);

  console.log(`开始监控 ${dur} 秒 —— 现在可以在浏览器里手动操作，我记录你点了什么。\n`);
  let seen = 0;
  let prevPanel = '';
  const t0 = Date.now();
  while (Date.now() - t0 < dur * 1000) {
    const clicks = ev('(()=>JSON.stringify(window.__oc_clicks||[]))()');
    let arr = [];
    try {
      arr = JSON.parse(clicks || '[]');
    } catch {}
    if (arr.length > seen) {
      for (const c of arr.slice(seen)) console.log(JSON.stringify(c));
      seen = arr.length;
    }
    const panel = ev(`(()=>{
  const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  return JSON.stringify({
    pop:[...document.querySelectorAll('.tap-editor-emoji__popover')].filter(ok).length,
    imgs:[...document.querySelectorAll('img[data-tap-editor-emoji-id]')].filter(ok).length
  });
})()`);
    if (panel && panel !== prevPanel) {
      console.log(`[面板状态] ${panel}`);
      prevPanel = panel;
    }
    await sleep(1200);
  }
  console.log('\n监控结束');
}

function cmdEval(file) {
  const js = readFileSync(file, 'utf8');
  console.log(ev(js, 60000));
}

/**
 * 扫最新 N 条帖子的评论，找出「玩家在喊我们」的（只读，不发送任何东西）
 *
 * 用法：node scripts/probe-dom.mjs summon [条数]
 * 用途：验证签名识别/喊话判定在真实数据上是否命中（改判定规则后跑一次）
 */
async function cmdSummon(count = 10) {
  const { loadConfig } = await import('./lib/paths.mjs');
  const { listFeed, listComments } = await import('./lib/http.mjs');
  const { isSummonText, isOurComment, commentText, teamUserIdsOf } = await import('./lib/signature.mjs');

  const config = await loadConfig();
  const teamIds = teamUserIdsOf(config);
  const data = await listFeed({
    groupId: config.groupId,
    from: 0,
    limit: Math.min(10, Number(count) || 10),
    sort: config.collect.sort || 'created',
    type: config.collect.type,
  });

  let scanned = 0;
  for (const item of data.list || []) {
    const m = item.moment || {};
    const id = String(m.id_str || '');
    const n = Number(item.comment_count ?? m.stat?.comments ?? 0);
    if (!id || !n) continue;
    let cs;
    try {
      cs = await listComments({ momentId: id, from: 0, limit: 30 });
    } catch (e) {
      console.log(`  ! 读评论失败 ${id}: ${e.message}`);
      continue;
    }
    scanned++;
    const flat = [];
    for (const c of cs.list || []) {
      flat.push(c);
      for (const ch of c.child_posts || []) flat.push(ch);
    }
    for (const c of flat) {
      const t = commentText(c);
      if (!t) continue;
      const hit = isSummonText(t, config);
      const ours = isOurComment(c, { config, teamIds });
      if (hit.summon || ours) {
        console.log(
          `  ${hit.summon ? '【喊话】' : '【我们自己】'} ${c.author?.name || '?'}：${t.slice(0, 60)}` +
            `  (${hit.why || 'signature-tail'})`
        );
      }
    }
  }
  console.log(`\n已扫 ${scanned} 个有评论的帖子。`);
}

/**
 * 展开帖子详情页右上角「管理」菜单，dump 里面有哪些项（只读，不点任何项）
 *
 * 用法：node scripts/probe-dom.mjs manage <momentId>
 * 用途：TapTap 改版后确认「移除」入口还在不在
 */
async function cmdManage(momentId) {
  await openPost(momentId);
  const clicked = ev(`(()=>{
    const b=document.querySelector('button[aria-label="管理"]');
    if(!b) return 'NO_MANAGE_BTN';
    const t=b.querySelector('[class*=trigger]')||b.querySelector('svg')||b;
    t.scrollIntoView({block:'center'});
    ['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
    return 'CLICKED';
  })()`);
  console.log('点「管理」：' + clicked);
  await sleep(1800);
  console.log(
    ev(`(()=>{
      const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
      const items=[...document.querySelectorAll('*')].filter(e=>ok(e) && e.children.length===0)
        .map(e=>(e.textContent||'').trim())
        .filter(t=>/移除|置顶|加精|沉底|移动|管理|删除/.test(t));
      return JSON.stringify([...new Set(items)].slice(0,15),null,1);
    })()`)
  );
}

const CMDS = {
  comment: (a) => cmdComment(a[0], a[1]),
  editor: () => cmdEditor(),
  emoji: () => cmdEmoji(),
  watch: (a) => cmdWatch(a[0], a[1]),
  eval: (a) => cmdEval(a[0]),
  summon: (a) => cmdSummon(a[0]),
  manage: (a) => cmdManage(a[0]),
};

if (!cmd || !CMDS[cmd]) {
  console.log('DOM 探针：node scripts/probe-dom.mjs <子命令>');
  console.log('  comment <momentId> [commentId]  展开楼中楼并 dump 结构');
  console.log('  editor                         dump 顶层评论框');
  console.log('  emoji                          dump 表情面板');
  console.log('  watch <momentId> [秒]          记录用户手动点击');
  console.log('  eval <js文件>                  跑一段 JS');
  console.log('  summon [条数]                  扫最新帖子，找「玩家喊我们」的评论（只读）');
  console.log('  manage <momentId>              展开「管理」菜单并列出有哪些项（只读，不点）');
  console.log('  详细说明见 references/admin.md');
  process.exit(cmd ? 1 : 0);
}

await CMDS[cmd](argv.slice(1));
