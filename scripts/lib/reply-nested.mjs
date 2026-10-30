// 楼中楼回复执行器：在**某条评论下面**回复（用于「夸答题玩家」）
//
// 与 replier.mjs 的 replyOne 区别：
//   replyOne        → 帖子底部顶层评论框
//   replyToComment  → 某条评论的楼中楼（条内的第二个 TapEditor 实例）
//
// ===== 实测结论（2026-10-27，改之前先读，全是踩过的坑）=====
// 1) 「回复」入口是评论 footer 里的图标 `.moment-post__tool-reply`，页面上**没有文字**，只能按 class 找。
// 2) 它是 **toggle**：已经展开时再点一次会关掉。必须先查「条内有没有可见编辑器」，
//    已开就别点；否则会出现点了打不开（其实是关掉）的假象。
// 3) 真实鼠标点击该图标无效（坐标被 SVG 遮住），必须 JS `.click()`。
//    而「是否展开」也不能看 `.moment-post__reply` 高度 —— 新组件关着也有 32px 高。
//    ✅ 唯一可靠信号：条内存在 offsetHeight/getBoundingClientRect 高度 > 0 的 contenteditable。
// 4) 表情面板 `.tap-editor-emoji__popover` 是**页面级 portal，不在评论项内**。
//    → 可见性、表情图片查找都必须全页找，不能 scope 到评论项（否则永远 false）。
// 5) 表情按钮的触发元素是 `span.tap-popover__trigger-wrap`（不是 label！）。
//    Vue 的 popover 监听 mousedown，必须派发 mousedown→mouseup→click 序列，纯 `.click()` 不开。
// 6) 这三个工具栏按钮里哪个是表情按钮**不能靠下标猜**（新旧组件顺序不同），
//    只能逐个试：派发点击后看页面级面板是否出现。
// 7) `fill` 对**多行文本**（含 \n\n）在这个编辑器上会失败（内容变空）。单行正常。
//    → 夸奖文案保持单行。

import { parseEmojiSegments } from './emoji.mjs';
import { getTapApi, momentIdFromUrl, stripEmojiMarks } from './taptap-api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const itemSel = (commentId) => `.moment-post-item[data-comment-id="${commentId}"]`;
const edSel = (commentId) => `${itemSel(commentId)} .tap-editor-compact__content`;

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

/** 页面级表情面板 / 表情图片的可见性快照 */
const PANEL_PROBE = `(()=>{
  const ok = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  return JSON.stringify({
    pop: [...document.querySelectorAll('.tap-editor-emoji__popover')].filter(ok).length,
    imgs: [...document.querySelectorAll('img[data-tap-editor-emoji-id]')].filter(ok).length
  });
})()`;

/**
 * 在某条评论下回复（含 1 个句尾表情）
 * @returns {{ok:boolean, stage:string, detail?:any}}
 */
export async function replyToComment({
  runner,
  url,
  commentId,
  text,
  dryRun = false,
  via = 'ui',
  log = () => {},
}) {
  const { plainText, marks } = parseEmojiSegments(text);
  const emojiName = marks.length ? marks[marks.length - 1].name : null;

  if (dryRun) {
    return { ok: true, stage: 'dry_run', detail: { url, commentId, body: plainText, emoji: emojiName } };
  }
  if (!runner?.available) return { ok: false, stage: 'opencli_missing', detail: runner?.reason };
  if (!commentId) return { ok: false, stage: 'no_comment_id' };

  // ---- 楼中楼接口（默认不开，见下方说明）----
  // ⚠️ create-child 的 body 参数名**还没实测确认**（猜的 parent_post_id）。
  //    风险不对称：万一服务端忽略未知参数，就会**在帖子里多出一条顶层评论**（玩家可见、还能被回复），
  //    比「多花 15 秒点 UI」严重得多。所以默认 via='ui'，等拿到真实 cURL 再切。
  //    要试接口：reply.nestedVia = "api" 或调用时传 via:'api'。
  if (String(via).toLowerCase() === 'api') {
    const api = getTapApi({ runner, log });
    const momentId = momentIdFromUrl(url);
    if (momentId && api.ensureOrigin().ok) {
      const ar = await api.childComment({ momentId, parentId: String(commentId), text });
      if (ar.ok) {
        log(`      [接口] 楼中楼已发送（表情 ${ar.emojiHit || 0} 个）`);
        return {
          ok: true,
          stage: 'api_sent',
          detail: { emoji: emojiName, emojiHit: ar.emojiHit, verified: false, body: stripEmojiMarks(text).trim() },
        };
      }
      log(`      [接口] 楼中楼发送失败（${ar.status}${ar.error ? ' ' + ar.error : ''}）→ 退回 UI 流程`);
    }
  }
  if (/\n/.test(plainText.trim())) {
    return { ok: false, stage: 'multiline_unsupported', detail: '楼中楼 fill 不支持多行，请用单行文案' };
  }

  const S = runner.session;
  const oc = runner.oc;
  // 只取 stdout：oc().text 混着 opencli「Update available」和 node 警告，会污染 Number()/JSON.parse()
  const ev = (js, timeout = 30000) => unwrap(oc(['browser', S, 'eval', js], { timeout }).out);

  const ITEM = JSON.stringify(itemSel(commentId));
  const ED = JSON.stringify(edSel(commentId));

  const editorText = () => ev(`(()=>{const d=document.querySelector(${ED});return d?d.innerText:''})()`);
  const editorEmojis = () =>
    ev(`(()=>{const d=document.querySelector(${ED});if(!d)return '[]';return JSON.stringify([...d.querySelectorAll('[data-type=tapEmoji]')].map(e=>e.getAttribute('data-identifier')||'?'))})()`);
  // 「楼中楼是否已展开」的唯一可靠信号 = 条内有没有「发送」按钮。
  // ⚠️ 不能用「条内有没有高度>0 的 contenteditable」—— 编辑器为空时 contenteditable 高度是 0
  //    （有高度的是占位符 P），会把「已展开但空」误判成「没展开」，
  //    然后再点一次「回复」反而把它关掉（toggle），于是永远打不开。
  const boxReady = () =>
    ev(`(()=>{
      const it=document.querySelector(${ITEM});
      if(!it) return 'NO';
      const b=[...it.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='发送');
      return b?'YES':'NO';
    })()`) === 'YES';

  // ---- 1. 打开帖子 ---
  const open = oc(['browser', S, 'open', url], { timeout: 90000 });
  if (open.code !== 0) return { ok: false, stage: 'open', detail: String(open.out || '').slice(0, 160) };
  await sleep(5200);
  ev('(()=>{window.scrollTo(0,document.body.scrollHeight);return 1})()');
  await sleep(2400);

  if (!/YES/.test(ev(`(()=>document.querySelector(${ITEM})?'YES':'NO')()`))) {
    return { ok: false, stage: 'comment_not_found', detail: commentId };
  }

  // ---- 2. 展开楼中楼（toggle 感知：已开就不点）----
  if (!boxReady()) {
    // 用户真实操作点是图标里的 svg/path（实测点外层 div 无效），所以按 path→svg→div 逐级尝试
    const clickReplyIcon = (target) =>
      ev(`(()=>{
      const it=document.querySelector(${ITEM});
      const icon=it&&it.querySelector('.moment-post__tool-reply, [class*="tool-reply"]');
      if(!icon) return 'NO_ICON';
      const t=${target};
      if(!t) return 'NO_TARGET';
      t.scrollIntoView({block:'center'});
      ['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
      return 'ok';
    })()`);

    for (const target of [
      `icon.querySelector('path')||icon.querySelector('svg')||icon`,
      `icon`,
    ]) {
      clickReplyIcon(target);
      for (let i = 0; i < 8 && !boxReady(); i++) await sleep(700);
      if (boxReady()) break;
    }
  }
  if (!boxReady()) return { ok: false, stage: 'no_reply_box', detail: '楼中楼输入框未展开' };

  // ---- 3. 填入文案（单行；这个编辑器多行 fill 会变空）----
  const f = oc(['browser', S, 'find', '--css', `${itemSel(commentId)} [contenteditable=true]`]);
  const eds = f.json?.entries || [];
  // 空编辑器时 opencli 可能把 visible 标成 false，所以不按 visible 过滤，取第一个即可（条内只有楼中楼这一个）
  const ed = eds.find((e) => e.visible !== false) || eds[0];
  if (!ed) return { ok: false, stage: 'no_input', detail: '楼中楼里找不到编辑器' };

  oc(['browser', S, 'fill', String(ed.ref), plainText], { timeout: 60000 });
  await sleep(900);

  const norm = (s) => String(s || '').replace(/\s+/g, '');
  let got = editorText();
  if (!norm(got).includes(norm(plainText))) {
    // 兜底：fill 失效时再填一次
    oc(['browser', S, 'fill', String(ed.ref), plainText], { timeout: 60000 });
    await sleep(900);
    got = editorText();
  }
  if (!norm(got).includes(norm(plainText))) {
    return { ok: false, stage: 'fill', detail: { expect: plainText, actual: got.slice(0, 200) } };
  }

  // ---- 4. 句尾插 1 个表情 ----
  if (emojiName) {
    // 4a. 光标移到末尾
    const caret = ev(`(()=>{
      const ed=document.querySelector(${ED});
      if(!ed) return 'NO_EDITOR';
      ed.focus();
      const r=document.createRange(); r.selectNodeContents(ed); r.collapse(false);
      const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return 'CARET_END';
    })()`);
    if (!/CARET_END/.test(caret)) {
      return { ok: false, stage: 'caret', detail: caret.slice(0, 80) };
    }
    await sleep(450);

    // 4b. 定位并打开表情面板
    //    楼中楼工具栏 3 个按钮 = @ 提及 / 表情 / 图片（实测 SVG path 特征）
    //    ⚠️ **绝不点 @ 按钮** —— 会弹出提及框，可能在文案里插入 @，用户明确要求不出现 @
    //    表情按钮的特征：唯一带 `.tap-popover__trigger-wrap` 的那一个
    const wrapInfo = JSON.parse(
      ev(`(()=>{
      const it=document.querySelector(${ITEM});
      const wraps=[...it.querySelectorAll('.tap-editor-toolbar-item__wrap')].filter(w=>w.getBoundingClientRect().width>0);
      return JSON.stringify(wraps.map((w,i)=>({
        i,
        hasTrigger: !!w.querySelector('.tap-popover__trigger-wrap'),
        isAt: /M7\\.771 2\\.499/.test((w.querySelector('svg path')?.getAttribute('d')||'')),
        isImg: /M8 6\\.1a1\\.9/.test((w.querySelector('svg path')?.getAttribute('d')||''))
      })));
    })()`) || '[]'
    );
    const order = [
      ...wrapInfo.filter((w) => w.hasTrigger && !w.isAt), // 表情按钮优先
      ...wrapInfo.filter((w) => !w.hasTrigger && !w.isAt && !w.isImg),
    ].map((w) => w.i);
    log(`      工具栏候选（已排除 @ / 图片按钮）：${order.join(',') || '无'}`);

    const clickTrigger = (idx) =>
      ev(`(()=>{
      const it=document.querySelector(${ITEM});
      const wraps=[...it.querySelectorAll('.tap-editor-toolbar-item__wrap')].filter(w=>w.getBoundingClientRect().width>0);
      const w=wraps[${idx}]; if(!w) return 'NO_WRAP';
      const t=w.querySelector('.tap-popover__trigger-wrap')||w.querySelector('label')||w;
      ['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
      return 'ok';
    })()`);
    const panelState = () => {
      try {
        return JSON.parse(ev(PANEL_PROBE) || '{}');
      } catch {
        return {};
      }
    };

    let opened = false;
    let winner = -1;
    for (const idx of order) {
      clickTrigger(idx);
      await sleep(1700);
      const st = panelState();
      if (st.imgs > 0) {
        opened = true;
        winner = idx;
        break;
      }
    }
    if (!opened) return { ok: false, stage: 'emoji_panel', detail: '楼中楼表情面板打不开' };
    log(`      表情面板已打开（工具栏项 #${winner}）`);

    // 4c. 点选表情（页面级查找 + 真实点击，失败再兜底 JS 点击）
    const beforeCount = JSON.parse(editorEmojis() || '[]').length;
    let clicked = false;
    for (const useParent of [false, true]) {
      const findRes = oc(['browser', S, 'find', '--css', 'img[data-tap-editor-emoji-id]']);
      const hit = (findRes.json?.entries || []).find(
        (e) => e.visible !== false && String(e.attrs?.alt || '').trim() === emojiName
      );
      if (hit) {
        oc(['browser', S, 'click', String(hit.ref)], { timeout: 30000 });
      } else {
        ev(`(()=>{
          const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
          const imgs=[...document.querySelectorAll('img[data-tap-editor-emoji-id]')].filter(ok);
          const hit=imgs.find(e=>(e.getAttribute('alt')||'')===${JSON.stringify(emojiName)});
          if(!hit) return 'NOT_FOUND';
          const t=${useParent ? '(hit.parentElement||hit)' : 'hit'};
          t.click(); return 'CLICKED';
        })()`);
      }
      await sleep(1000);
      const cnt = JSON.parse(editorEmojis() || '[]').length;
      if (cnt > beforeCount) {
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      return { ok: false, stage: 'emoji_insert', detail: { want: emojiName, actual: JSON.parse(editorEmojis() || '[]') } };
    }

    // 4d. 关面板（点回编辑器）并终检
    ev(`(()=>{const d=document.querySelector(${ED});if(d)d.click();return 1})()`);
    await sleep(600);

    const emo = JSON.parse(editorEmojis() || '[]');
    if (emo.length !== 1 || emo[0] !== `[表情_${emojiName}]`) {
      return { ok: false, stage: 'verify_emoji', detail: { emojis: emo, want: `[表情_${emojiName}]` } };
    }
    const txt = editorText();
    if (!norm(txt).includes(norm(plainText))) {
      return { ok: false, stage: 'verify_text', detail: { actual: txt.slice(0, 200) } };
    }
    log(`      表情已插入并校验通过：${emo[0]}`);
  }

  // ---- 5. 点楼中楼里的「发送」----
  const findBtn = oc(['browser', S, 'find', '--css', `${itemSel(commentId)} button`]);
  const sendBtn = (findBtn.json?.entries || [])
    .filter((e) => e.visible !== false)
    .find((e) => (e.text || '').trim() === '发送');
  if (!sendBtn) return { ok: false, stage: 'no_send_button', detail: '楼中楼找不到发送按钮，已中止' };

  // 草稿是否还在编辑器里（还在 = 没发出去）
  const draftLeft = () => {
    const t = editorText();
    return !!t && norm(t).includes(norm(plainText));
  };

  oc(['browser', S, 'click', String(sendBtn.ref)], { timeout: 30000 });
  await sleep(3200);

  // 兜底：ref 点击没生效时，按用户真实操作方式派发事件到按钮上
  if (draftLeft()) {
    ev(`(()=>{
      const it=document.querySelector(${ITEM});
      const b=[...(it?it.querySelectorAll('button'):[])].find(x=>(x.textContent||'').trim()==='发送');
      if(!b) return 'NO_BTN';
      ['mousedown','mouseup','click'].forEach(ty=>b.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
      return 'CLICKED';
    })()`);
    await sleep(3200);
  }

  if (draftLeft()) {
    return { ok: false, stage: 'send_failed', detail: '点击发送后草稿仍在输入框里，未发出' };
  }

  // ---- 6. 校验 ----
  // ⚠️ 两条重要教训：
  //  a) 不能拿整条评论的 innerText 当证据 —— 里面包含输入框的草稿，会造成「假核验」
  //     （实测：没发出去却报「已核验内容」）。
  //  b) 楼中楼对话默认是折叠的（「展开剩余 N 条回复」），新发的回复可能藏在折叠区，
  //     所以要先展开再查文字。
  ev(`(()=>{
    const bs=[...document.querySelectorAll('button')].filter(b=>/展开剩余/.test(b.textContent||''));
    let n=0; bs.slice(0,3).forEach(b=>{ try{ b.click(); n++; }catch{} });
    return n;
  })()`);
  await sleep(1800);

  const after = ev(`(()=>{
    const it=document.querySelector(${ITEM});
    const closed = !it || ![...it.querySelectorAll('button')].some(x=>(x.textContent||'').trim()==='发送');
    return JSON.stringify({ closed, txt: it?it.innerText.slice(0,1200):'' });
  })()`);
  let parsed = {};
  try {
    parsed = JSON.parse(after);
  } catch {}
  const probe = norm(plainText).slice(0, 6);
  const verified = parsed.txt ? norm(parsed.txt).includes(probe) : false;

  oc(['browser', S, 'close']);
  return {
    ok: true,
    stage: 'sent',
    detail: { commentId, verified, closed: parsed.closed, emoji: emojiName },
  };
}
