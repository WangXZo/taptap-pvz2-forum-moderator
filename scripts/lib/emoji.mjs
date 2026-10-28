// TapTap 表情支持（实测结论，改之前先读）
//
// 【不能做的】
//  - 直接输入 `[表情_开心]` → 只会变成纯文本，编辑器不认。
//  - ClipboardEvent paste 注入 HTML → ProseMirror 忽略，无效。
//  - opencli 的 type → 对编辑器是「整体替换」，不能追加文字。
//
// 【能做的】= 三段组合
//  1) fill 一次性填入完整纯文字（表情标记剥掉，占位不写）
//  2) 用 eval 把光标定位到目标字符位置（只改 selection，不改内容）
//  3) 点工具栏表情按钮 → 在面板里点具体表情 → 表情插入到光标处
//  多个表情必须「从后往前」插，否则前面的插入会让后面的位置偏移。
//
// 编辑器生成的节点：
//   <span data-type="tapEmoji" data-emoji-id="71" data-identifier="[表情_开心]"
//         data-url="..." class="tap-emoji" contenteditable="false">
//     <img class="tap-emoji-img" alt="[表情_开心]">
//   </span>
// 服务端落库：{"type":"tap_emoji","children":[{"text":"[表情_开心]"}],"info":{"id":71,...}}

const MARK_RE = /\[(?:表情_([^\]]+)|TapTap×[^\]_]+_([^\]]+))\]/g;

/**
 * 拆分文案：文字 + 表情位置
 * "前段[表情_开心]后段[表情_耶]" → { plainText:"前段后段", marks:[{name:'开心',at:2},{name:'耶',at:4}] }
 * at = 表情应插在纯文本的第几个字符之后
 */
export function parseEmojiSegments(text) {
  const raw = String(text || '');
  const marks = [];
  let plain = '';
  let last = 0;
  let m;
  MARK_RE.lastIndex = 0;
  while ((m = MARK_RE.exec(raw)) !== null) {
    plain += raw.slice(last, m.index);
    marks.push({ name: (m[1] || m[2]).trim(), at: plain.length });
    last = m.index + m[0].length;
  }
  plain += raw.slice(last);
  return { plainText: plain, marks };
}



/** 定位光标到纯文本第 index 个字符之后（只改 selection） */
export function setCaret(oc, session, index) {
  const js = `(()=>{
  const ed=document.querySelector('.tap-editor-compact__content');
  if(!ed) return 'NO_EDITOR';
  ed.focus();
  const N=${Number(index)};
  if(N<=0){
    const r0=document.createRange(); r0.setStart(ed,0); r0.collapse(true);
    const s0=window.getSelection(); s0.removeAllRanges(); s0.addRange(r0);
    return 'CARET_OK:0';
  }
  const walker=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT);
  let node,count=0;
  while((node=walker.nextNode())){
    const len=node.nodeValue?node.nodeValue.length:0;
    if(count+len>=N){
      const r=document.createRange();
      r.setStart(node,Math.max(0,N-count)); r.collapse(true);
      const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return 'CARET_OK';
    }
    count+=len;
  }
  const r2=document.createRange(); r2.selectNodeContents(ed); r2.collapse(false);
  const s2=window.getSelection(); s2.removeAllRanges(); s2.addRange(r2);
  return 'CARET_CLAMPED_END';
})()`;
  const r = oc(['browser', session, 'eval', js], { timeout: 30000 });
  return { ok: /CARET_OK|CARET_CLAMPED_END/.test(r.text), detail: r.text.trim().slice(0, 80) };
}


/** 打开表情面板（工具栏第 2 个按钮） */
export function openEmojiPanel(oc, session) {
  const btn = oc(['browser', session, 'find', '--css', '.tap-editor-toolbar-item__wrap']);
  const wraps = (btn.json?.entries || []).filter((e) => e.visible !== false);
  if (wraps.length < 2) return { ok: false, reason: 'toolbar_not_found' };
  oc(['browser', session, 'click', String(wraps[1].ref)], { timeout: 30000 });
  return { ok: true };
}

/** 关掉表情面板（点回输入框） */
export function closeEmojiPanel(oc, session, editorRef) {
  oc(['browser', session, 'click', String(editorRef)], { timeout: 30000 });
  return true;
}

/** 面板是否已展开 */
export function isPanelOpen(oc, session) {
  const r = oc(['browser', session, 'find', '--css', '.tap-editor-emoji__popover']);
  return (r.json?.entries || []).some((e) => e.visible !== false);
}

/**
 * 确保面板处于展开状态。
 * 表情按钮是 toggle，盲目点击可能反而关掉，所以先查状态再点。
 */
export async function ensurePanelOpen(oc, session, { sleep = async () => {} } = {}) {
  if (isPanelOpen(oc, session)) return true;
  openEmojiPanel(oc, session);
  await sleep(2200);
  if (isPanelOpen(oc, session)) return true;
  // 再试一次
  openEmojiPanel(oc, session);
  await sleep(2200);
  return isPanelOpen(oc, session);
}

/**
 * 读出编辑器里当前所有表情的 identifier（用于点击后校验）
 * 注意：identifier 形如 [表情_开心]，自身带方括号，
 *      所以不能用 JSON 数组 + 括号正则解析（会被 ] 截断），
 *      改成用 '|' 分隔的自定义标记。
 */
export function readEditorEmojis(oc, session) {
  const js = `(()=>{const d=document.querySelector('.tap-editor-compact__content');
if(!d)return 'EMOJIS::';
const a=[...d.querySelectorAll('[data-type=tapEmoji]')].map(e=>e.getAttribute('data-identifier')||'?');
return 'EMOJIS::'+a.join('|')})()`;
  const r = oc(['browser', session, 'eval', js], { timeout: 30000 });
  const m = r.text.match(/EMOJIS::([^\r\n]*)/);
  if (!m) return [];
  return m[1].split('|').map((s) => s.trim()).filter(Boolean);
}


/**
 * 在面板里点选一个表情（面板需已打开，且停留在第 1 组「标准表情」）。
 *
 * 安全策略（重要）：
 *  - 只在当前面板可见表情里找，**不做跨组遍历**（跨组时 ref 会错位，实测会插错表情）
 *  - 点击后立刻校验新节点的 data-identifier 必须等于 `[表情_<name>]`
 *  - 校验不过 → 不撤销、不重试，直接判失败（由调用方转「需人工处理」，绝不发错内容）
 *
 * 想用其它分组的表情，请先在 config.reply.emoji 里配置好，并确认组名——默认只用标准组。
 */
export async function clickEmoji(oc, session, name, { sleep = async () => {}, log } = {}) {
  const want = `[表情_${name}]`;
  const before = readEditorEmojis(oc, session);

  const findInPanel = () => {
    const r = oc([
      'browser',
      session,
      'find',
      '--css',
      `img[data-tap-editor-emoji-id][alt="${name}"]`,
    ]);
    let hit = (r.json?.entries || []).find((e) => e.visible !== false);
    if (!hit) {
      const all = oc(['browser', session, 'find', '--css', 'img[data-tap-editor-emoji-id]']);
      const list = (all.json?.entries || []).filter((e) => e.visible !== false);
      hit = list.find((e) => (e.attrs?.alt || '') === name);
    }
    return hit || null;
  };

  const hit = findInPanel();
  if (!hit) return { ok: false, reason: 'emoji_not_found', name, expectedIdentifier: want };

  const c = oc(['browser', session, 'click', String(hit.ref)], { timeout: 30000 });
  if (c.code !== 0) return { ok: false, reason: 'click_failed', name };
  await sleep(900);

  const now = readEditorEmojis(oc, session);
  const hasWant = now.filter((x) => x === want).length > before.filter((x) => x === want).length;
  const added = now.length > before.length ? now : null;

  if (hasWant) return { ok: true, name, identifier: want };

  if (log) {
    log(`      ⚠️ 表情校验失败：期望 ${want}，实际 ${JSON.stringify(added)}`);
  }
  return { ok: false, reason: 'verify_mismatch', name, expected: want, actual: added };
}


// ============================================================
// 作用域版本：楼中楼回复用
//
// 楼中楼（.moment-post__reply）里有**第二个** TapEditor 实例，页面上同时存在两个
// `.tap-editor-compact__content`。上面的函数都写死 querySelector 第一个编辑器
// → 会插到顶层的评论框里。所以这里所有查找都必须带 scope。
//
// 另外：表情面板（.tap-editor-emoji-lists）渲染在**工具栏项内部**，不是 body 级 portal
// （实测 dump），所以 scope 内查找能同时框住「表情按钮」和「表情面板」。
// ============================================================

const inScope = (scope, sel) => (scope ? `${scope} ${sel}` : sel);
const edSelIn = (scope) => inScope(scope, '.tap-editor-compact__content');







/**
 * 按位置把表情逐个插进编辑器（从后往前，避免偏移）
 * @param {{plainText:string, marks:Array<{name:string,at:number}>}} parsed
 */
export async function applyEmojis(oc, session, editorRef, marks, { sleep = async () => {} } = {}) {
  if (!marks.length) return { ok: true, done: [], missed: [] };

  const done = [];
  const missed = [];
  // 从后往前
  const ordered = [...marks].sort((a, b) => b.at - a.at);

  for (const mk of ordered) {
    // 1) 点回输入框（关面板 + 聚焦）
    closeEmojiPanel(oc, session, editorRef);
    await sleep(600);

    // 2) 定位光标
    const c = setCaret(oc, session, mk.at);
    if (!c.ok) {
      missed.push({ name: mk.name, reason: 'caret_failed', detail: c.detail });
      continue;
    }
    await sleep(500);

    // 3) 确保面板展开（按钮是 toggle，盲点可能反而关掉），再点选
    const opened = await ensurePanelOpen(oc, session, { sleep });
    if (!opened) {
      missed.push({ name: mk.name, reason: 'panel_open_failed' });
      continue;
    }
    await sleep(600);

    const click = await clickEmoji(oc, session, mk.name, { sleep });
    if (!click.ok) missed.push({ name: mk.name, reason: click.reason });
    else done.push(mk.name);

    await sleep(900);
  }

  // 收尾：关面板
  closeEmojiPanel(oc, session, editorRef);
  return { ok: missed.length === 0, done, missed };
}
