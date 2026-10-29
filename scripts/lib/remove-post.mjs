// 移除帖子（版主操作）：帖子详情页右上角「管理」→「移除」
//
// ⚠️ 不可逆操作 —— 但它**不是删帖**：TapTap 的「论坛管理 → 移除」只是把内容从版块里移走，
//    帖子还在（可查、可恢复），「删除」才是真删。用户 2026-10-29 特别强调：「移除 ≠ 删帖」。
//
// 页面结构（2026-10-29 实测，帖子详情页）：
//   右上角三个图标：盾(反馈) / 剪刀(管理) / ⋯(更多)
//   `button[aria-label="管理"]` 就是剪刀那个 → 点开是弹出菜单：论坛管理/移除、论坛置顶、加精、沉底、移动子版块
//
// 流程：
//   1. 打开帖子详情页
//   2. 点「管理」→ 弹出菜单
//   3. 点「移除」
//   4. 可能弹二次确认框（有就点「确定/确认」）
//   5. 核验：页面出现「已移除/已被移除」之类提示，或帖子标题不见了 → 算成功

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开 eval 结果里的字符串（opencli 会把结果包成 JSON 字符串） */
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

/**
 * 移除一个帖子
 *
 * @param {object} o
 * @param {object} o.runner  opencli runner（必须 available）
 * @param {string} o.url     帖子链接
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, stage:string, detail?:any}>}
 */
export async function removePost({ runner, url, log = () => {} }) {
  if (!runner?.available) return { ok: false, stage: 'opencli_missing', detail: runner?.reason };

  const S = runner.session;
  const oc = (args, timeout = 60000) => runner.oc(args, { timeout });
  const ev = (js, timeout = 30000) => unwrap(oc(['browser', S, 'eval', js], timeout).out);

  // ---------- 1. 打开帖子 ----------
  const open = oc(['browser', S, 'open', url], 90000);
  if (open.code !== 0) return { ok: false, stage: 'open', detail: String(open.out || open.err || '').slice(0, 160) };
  await sleep(5200);

  // ---------- 2. 点「管理」 ----------
  const manage = ev(`(()=>{
    const b=document.querySelector('button[aria-label="管理"]');
    if(!b) return 'NO_MANAGE_BTN';
    const t=b.querySelector('[class*=trigger]')||b.querySelector('svg')||b;
    t.scrollIntoView({block:'center'});
    ['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
    return 'CLICKED';
  })()`);
  if (!/CLICKED/.test(manage)) {
    return { ok: false, stage: 'no_manage_btn', detail: manage };
  }
  await sleep(1800);

  // ---------- 3. 点「移除」 ----------
  const removed = ev(`(()=>{
    const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
    const leaves=[...document.querySelectorAll('*')].filter(e=>ok(e) && (e.innerText||'').trim()==='移除' && e.children.length<=2);
    if(!leaves.length) return 'NO_REMOVE_ITEM';
    const leaf=leaves[leaves.length-1];
    const target=leaf.closest('[class*=menu-item],[class*=option],li,button,a')||leaf;
    ['mousedown','mouseup','click'].forEach(ty=>target.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
    return 'CLICKED';
  })()`);
  if (!/CLICKED/.test(removed)) {
    // 菜单没出来：多半是「管理」没点开（可能弹层被遮挡），重试一次
    log('      「移除」没出现，重试点一次「管理」');
    await sleep(800);
    ev(`(()=>{const b=document.querySelector('button[aria-label="管理"]');if(!b)return 0;const t=b.querySelector('[class*=trigger]')||b.querySelector('svg')||b;['mousedown','mouseup','click'].forEach(ty=>t.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));return 1})()`);
    await sleep(1600);
    const retry = ev(`(()=>{
      const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
      const leaves=[...document.querySelectorAll('*')].filter(e=>ok(e) && (e.innerText||'').trim()==='移除' && e.children.length<=2);
      if(!leaves.length) return 'NO_REMOVE_ITEM';
      const leaf=leaves[leaves.length-1];
      const target=leaf.closest('[class*=menu-item],[class*=option],li,button,a')||leaf;
      ['mousedown','mouseup','click'].forEach(ty=>target.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
      return 'CLICKED';
    })()`);
    if (!/CLICKED/.test(retry)) return { ok: false, stage: 'no_remove_item', detail: removed };
  }
  await sleep(1800);

  // ---------- 4. 二次确认框（TapTap 移除会弹确认，必须自动点掉）----------
  const dialog = ev(`(()=>{
    const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
    const dlgs=[...document.querySelectorAll('[role=dialog],[class*=dialog],[class*=modal],[class*=confirm]')].filter(ok);
    return JSON.stringify(dlgs.slice(0,3).map(d=>({cls:String(d.className).slice(0,60), txt:(d.innerText||'').replace(/\\n+/g,'|').slice(0,120)})));
  })()`);
  if (dialog && dialog !== '[]') log(`      弹窗：${dialog}`);

  const confirm = ev(`(()=>{
    const ok=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
    // ⚠️ 实测：TapTap 的确认弹窗是 .tap-media-modal，
    //    文案「是否确认将内容从论坛移除？」，按钮是「取消」/「移除」——
    //    确认按钮就叫「移除」，不是「确定」；而且不能去全页找「移除」，
    //    否则会点到刚才那个下拉菜单项 → 必须在弹窗范围内找。
    const RE=/^(确定|确认|确定移除|确认移除|移除|好的|知道了)$/;
    const scopes=[...document.querySelectorAll('[role=dialog],[class*=modal],[class*=dialog],[class*=confirm]')].filter(ok);
    for(const sc of scopes){
      const btns=[...sc.querySelectorAll('button,[role=button],[class*=btn],[class*=item]')]
        .filter(ok)
        .filter(b=>RE.test((b.innerText||b.textContent||'').trim()))
        .filter(b=>!/^取消$/.test((b.innerText||b.textContent||'').trim()));
      if(btns.length){
        const b=btns[btns.length-1];
        const label=(b.innerText||b.textContent||'').trim();
        ['mousedown','mouseup','click'].forEach(ty=>b.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})));
        return 'CONFIRMED:'+label;
      }
    }
    return 'NO_DIALOG';
  })()`);
  if (/CONFIRMED/.test(confirm)) log(`      二次确认已点：${confirm.replace('CONFIRMED:', '')}`);
  else log('      没找到确认框（可能直接生效）');
  await sleep(2600);

  // ---------- 5. 核验 ----------
  // ⚠️ 实测（2026-10-29）：移除成功后**帖子详情页还能打开**，标题也还在，
  //    只有「从版块列表里消失」才是移除生效的标志；
  //    所以这里判据是「点到了确认按钮」+「页面出现成功提示」，不拿标题做依据。
  const ver = ev(`(()=>{
    const t=document.body.innerText||'';
    const toast=[...document.querySelectorAll('[class*=toast],[class*=message],[class*=notice],[class*=notification]')]
      .map(e=>(e.innerText||'').trim()).filter(Boolean).slice(0,3);
    return JSON.stringify({
      toast,
      success:/移除成功|操作成功|已移除|已被移除/.test(t) || toast.some(s=>/移除成功|操作成功/.test(s)),
      dialogGone: !document.querySelector('.tap-media-modal')
    });
  })()`);
  let parsed = {};
  try {
    parsed = JSON.parse(ver);
  } catch {}

  oc(['browser', S, 'close']);
  // 点到了确认按钮就算成功；万一没点成功，下一轮它还在版块里，会自动重试
  const ok = !!parsed.success || /CONFIRMED/.test(confirm);
  log(
    `      ${ok ? '已移除' : '移除未确认'}` +
      (parsed.toast?.length ? `（提示：${parsed.toast.join(' / ').slice(0, 60)}）` : '')
  );
  return { ok, stage: ok ? 'removed' : 'verify_unclear', detail: { confirm, ...parsed } };
}
