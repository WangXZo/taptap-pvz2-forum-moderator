// TapTap 写接口直连（替代「点 UI」）
//
// 为什么不落盘任何凭据：
//   写接口要登录 Cookie，其中 TAPTAP_SESSION 是 HttpOnly，JS 读不到、Node 也拿不到。
//   做法是**在已登录的页面上下文里发 fetch** —— 浏览器自动带上全部 Cookie（含 HttpOnly），
//   我们只需要从 document.cookie 里补一个 XSRF-TOKEN 到请求头。
//   好处：零凭据落盘、零凭据进 git、和真人操作走同一条通道（WAF 友好）。
//
// 已实测可用（2026-10，与浏览器 cURL 对照）：
//   发回复  POST /webapiv2/moment-comment/v1/create      form: moment_id, contents
//   移除    POST /webapiv2/moment/v3/unlink-group        form: id, group_id
//   两者都是 multipart/form-data + x-xsrf-token 头 + X-UA query 参数。
//
// ⚠️ 「移除」= 从板块解除关联（unlink-group），不是删帖：帖子详情页仍可访问。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://www.taptap.cn';

// 表情名 → {id,url}（由 scripts/emoji-map.mjs 采集；没有表就自动退化成纯文本）
const EMOJI_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/emoji-map.json');
let emojiCache = null;
export function loadEmojiMap() {
  if (emojiCache) return emojiCache;
  try {
    emojiCache = JSON.parse(readFileSync(EMOJI_FILE, 'utf8'));
  } catch {
    emojiCache = {};
  }
  return emojiCache;
}

// X-UA 里的固定段（VID/UID 是动态的，从 Cookie 取）
const XUA_HEAD = 'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android';
const XUA_TAIL = 'OS=Windows&OSV=10&DT=PC';

/** 把 eval 的原始输出解析成 JSON（opencli 会混进别的行） */
function pickJson(out) {
  const s = String(out || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {}
  const m = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

/**
 * 文案 → TapTap 富文本 contents 数组的 JSON 字符串
 * ⚠️ 换行不会自动生效：一个 paragraph 节点里的 \n 在时间线上不会断行。
 *    所以按行拆成多个 paragraph 节点（正文一行、空行由前端间距表现、签名一行）。
 */
export function buildContents(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]);
  return JSON.stringify(lines.map((t) => ({ type: 'paragraph', children: [{ text: t }] })));
}

/** 带表情节点的 contents（name→{id,url} 由 scripts/emoji-map.mjs 采集；表里没有的表情直接丢掉） */
export function buildContentsWithEmoji(text, emojiMap = {}) {
  const re = /\[表情_([^\]]+)\]/g;
  let hit = 0;

  // 一行一段（与 buildContents 一致），行内再做表情节点替换
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const nodes = lines.map((line) => {
    const children = [];
    let last = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(last, m.index);
      if (before) children.push({ text: before });
      const name = m[1].trim();
      const info = emojiMap[name];
      if (info && info.id) {
        children.push({
          type: 'tap_emoji',
          children: [{ text: `[表情_${name}]` }],
          info: { id: Number(info.id), url: info.url || undefined },
        });
        hit++;
      }
      // 表里没有的表情：直接丢掉（绝不能把 [表情_xx] 当字面文本发出去）
      last = m.index + m[0].length;
    }
    const tail = line.slice(last);
    if (tail) children.push({ text: tail });
    if (!children.length) children.push({ text: '' });
    return { type: 'paragraph', children };
  });

  if (!nodes.length) nodes.push({ type: 'paragraph', children: [{ text: '' }] });
  return { json: JSON.stringify(nodes), emojiHit: hit };
}

export function makeTapApi({ runner, log = () => {}, intervalMs = 1000 } = {}) {
  const S = runner.session;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let authCache = null;
  let lastCallAt = 0;

  const oc = (args, timeout = 60000) => runner.oc(args, { timeout });
  const ev = (js, timeout = 45000) => {
    const r = oc(['browser', S, 'eval', js], timeout);
    return { raw: `${r.out || ''}`, json: pickJson(r.out), code: r.code, err: r.err };
  };

  /** 保证当前标签页在 taptap 站内（页面内 fetch 才带得上 Cookie） */
  function ensureOrigin(url = `${ORIGIN}/`) {
    const st = oc(['browser', S, 'state'], 30000);
    const host = String(st.out || '').match(/URL:\s*(\S+)/)?.[1] || '';
    if (host.includes('taptap.cn')) return { ok: true, navigated: false, url: host };
    const o = oc(['browser', S, 'open', url], 90000);
    return { ok: o.code === 0, navigated: true, url };
  }

  /** 读页面凭据，拼 X-UA */
  function auth(refresh = false) {
    if (authCache && !refresh) return authCache;
    const js = `(()=>{
      const pick=(k)=>{const m=(document.cookie||'').match(new RegExp('(?:^|;\\\\s*)'+k+'=([^;]*)'));return m?decodeURIComponent(m[1]):'';};
      return JSON.stringify({
        xsrf: pick('XSRF-TOKEN'),
        uid: pick('ACCOUNTS_USER_ID')||pick('user_id'),
        uuid: pick('web_app_uuid'),
        href: location.href
      });
    })()`;
    const r = ev(js, 30000);
    const v = r.json || {};
    const xua = [XUA_HEAD, `UID=${v.uuid || ''}`, XUA_TAIL, `VID=${v.uid || ''}`].join('&');
    authCache = { ...v, xua, ok: Boolean(v.xsrf && v.uid) };
    if (!authCache.ok) log('  ! 页面凭据不全（xsrf/uid 缺失），请确认浏览器已登录 TapTap');
    return authCache;
  }

  /** 节流：保证接口之间至少 intervalMs（默认 1s） */
  async function throttle() {
    const wait = lastCallAt + intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  }

  /** 页面内 POST（multipart/form-data，自动带 Cookie） */
  async function post(path, form, { referer } = {}) {
    await throttle();
    const a = auth();
    if (!a.ok) return { ok: false, stage: 'no_auth', status: 0, body: '' };
    const js = `(async()=>{
      try{
        const FORM=${JSON.stringify(form)};
        const XUA=${JSON.stringify(a.xua)};
        const p=${JSON.stringify(path)};
        const u=p+(p.includes('?')?'&':'?')+'X-UA='+encodeURIComponent(XUA);
        const fd=new FormData();
        for(const k of Object.keys(FORM)) fd.append(k, FORM[k]);
        const r=await fetch(u,{method:'POST',credentials:'include',
          headers:{'x-xsrf-token':${JSON.stringify(a.xsrf)},'x-requested-with':'XMLHttpRequest',
                   'x-tap-webapp-next-runtime-env':'release-gray'},
          body:fd});
        const t=await r.text();
        return JSON.stringify({status:r.status, ct:(r.headers.get('content-type')||''), body:t.slice(0,1500)});
      }catch(e){ return JSON.stringify({status:0, err:String(e&&e.message||e)}); }
    })()`;
    const r = ev(js, 60000);
    const v = r.json || {};
    const body = v.body || '';
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    // 阿里云 WAF：200 + HTML
    const waf = /aliyun_waf_aa/.test(body);
    const success = Boolean(json && (json.success === true || json.data));
    return {
      ok: Boolean(v.status >= 200 && v.status < 300) && !waf && (success || !json),
      status: v.status || 0,
      waf,
      json,
      body,
      error: json?.errors?.[0]?.msg || json?.error || (waf ? 'WAF_BLOCKED' : ''),
    };
  }

  /** 页面内 GET（返回已解析 JSON） */
  async function get(path, params = {}) {
    await throttle();
    const a = auth();
    if (!a.ok) return { ok: false, stage: 'no_auth' };
    const qs = Object.entries({ ...params, 'X-UA': a.xua })
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const js = `(async()=>{
      try{
        const r=await fetch(${JSON.stringify(path)} + '?${qs}',{credentials:'include',headers:{'x-requested-with':'XMLHttpRequest'}});
        const t=await r.text();
        return JSON.stringify({status:r.status, body:t.slice(0,400000)});
      }catch(e){ return JSON.stringify({status:0, err:String(e&&e.message||e)}); }
    })()`;
    const r = ev(js, 60000);
    const v = r.json || {};
    let json = null;
    try {
      json = JSON.parse(v.body || '');
    } catch {}
    return { ok: Boolean(v.status >= 200 && v.status < 300 && json), status: v.status, json };
  }

  // ---------- 具体动作 ----------

  /**
   * 发一级回复
   * @param emoji 默认 true：文案里的 [表情_xx] 转成 tap_emoji 节点发出去；
   *              表里找不到的表情会被丢掉；带表情失败会自动退回纯文本再发一次。
   */
  async function reply({ momentId, text, contents, emoji = true }) {
    let payload = contents;
    let emojiHit = 0;
    if (!payload) {
      if (emoji) {
        const b = buildContentsWithEmoji(text, loadEmojiMap());
        payload = b.json;
        emojiHit = b.emojiHit;
      } else {
        payload = buildContents(stripEmojiMarks(text));
      }
    }
    const res = await post('/webapiv2/moment-comment/v1/create', {
      moment_id: String(momentId),
      contents: payload,
    });
    if (!res.ok && emojiHit) {
      const plain = await post('/webapiv2/moment-comment/v1/create', {
        moment_id: String(momentId),
        contents: buildContents(stripEmojiMarks(text)),
      });
      plain.emojiFallback = true;
      return plain;
    }
    res.emojiHit = emojiHit;
    return res;
  }

  /** 发楼中楼（夸奖/喊话用）：parentId 是被回复的一级评论 id */
  async function childComment({ momentId, parentId, text, contents, emoji = true }) {
    let payload = contents;
    let emojiHit = 0;
    if (!payload) {
      if (emoji) {
        const b = buildContentsWithEmoji(text, loadEmojiMap());
        payload = b.json;
        emojiHit = b.emojiHit;
      } else {
        payload = buildContents(stripEmojiMarks(text));
      }
    }
    const res = await post('/webapiv2/moment-comment/v1/create-child', {
      moment_id: String(momentId),
      parent_post_id: String(parentId),
      contents: payload,
    });
    if (!res.ok && emojiHit) {
      const plain = await post('/webapiv2/moment-comment/v1/create-child', {
        moment_id: String(momentId),
        parent_post_id: String(parentId),
        contents: buildContents(stripEmojiMarks(text)),
      });
      plain.emojiFallback = true;
      return plain;
    }
    res.emojiHit = emojiHit;
    return res;
  }

  /** 移除（= 从板块 unlink，不删帖） */
  async function remove({ momentId, groupId }) {
    if (!groupId) return { ok: false, stage: 'no_group_id', body: '' };
    return post('/webapiv2/moment/v3/unlink-group', {
      id: String(momentId),
      group_id: String(groupId),
    });
  }

  /** 读评论（校验回复是否落库） */
  async function comments({ momentId, limit = 30, from = 0 }) {
    const r = await get('/webapiv2/moment-comment/v1/by-moment', {
      moment_id: String(momentId),
      limit,
      from,
    });
    return { ok: r.ok, list: r.json?.data?.list || [], json: r.json };
  }

  /**
   * 板块列表里是否还有这条帖子（校验「移除」是否生效）
   * @param untilTs 目标帖的发布时间（秒）。翻到比它更早的帖子就能确定「不在列表里」，
   *                否则像 17 小时前的旧帖，翻前几页根本翻不到，会误判成「已移除」。
   */
  async function feedHas({ groupId, momentId, type = 'feed', maxPages = 8, untilTs = 0 }) {
    for (let page = 0; page < maxPages; page++) {
      const r = await get('/webapiv2/feed/v7/by-group', {
        group_id: String(groupId),
        from: page * 10,
        limit: 10,
        sort: 'created',
        status: 0,
        type,
        with_hot_comment: 'true',
      });
      const list = r.json?.data?.list || [];
      if (!list.length) return { has: false, scanned: page * 10, end: true, conclusive: true };
      if (list.some((it) => String(it?.moment?.id_str || it?.moment?.id) === String(momentId))) {
        return { has: true, scanned: (page + 1) * 10, conclusive: true };
      }
      const oldest = Number(list[list.length - 1]?.moment?.publish_time || 0);
      // 已经翻过目标帖的发布时间 → 它确实不在列表里（确定）
      if (untilTs && oldest && oldest < untilTs) {
        return { has: false, scanned: (page + 1) * 10, conclusive: true };
      }
    }
    return { has: false, scanned: maxPages * 10, conclusive: false };
  }

  /** 校验某条回复文本是否已出现在帖子里（按纯文本包含匹配） */
  async function hasReplyText({ momentId, text, probe = 12 }) {
    const needle = String(text || '').replace(/\s+/g, '').slice(0, probe);
    if (!needle) return { found: false };
    const r = await comments({ momentId, limit: 30 });
    const flat = (c) => {
      const raw = c?.contents?.json ?? c?.contents ?? '';
      if (Array.isArray(raw)) {
        let s = '';
        const walk = (n) => {
          if (!n || typeof n !== 'object') return;
          if (typeof n.text === 'string') s += n.text;
          for (const k of ['children', 'content']) if (Array.isArray(n[k])) n[k].forEach(walk);
        };
        raw.forEach(walk);
        return s;
      }
      return String(raw || '');
    };
    for (const c of r.list) {
      if (flat(c).replace(/\s+/g, '').includes(needle)) return { found: true, id: c.id_str || c.id };
      for (const ch of c.child_posts || []) {
        if (flat(ch).replace(/\s+/g, '').includes(needle)) return { found: true, id: ch.id_str || ch.id };
      }
    }
    return { found: false, total: r.json?.data?.total };
  }

  /** 探测页面表情 name→{id,url}（只在需要发带表情的接口回复时调） */
  function emojiMap() {
    const js = `(()=>{
      const out={};
      for(const img of document.querySelectorAll('img[data-tap-editor-emoji-id]')){
        const n=(img.getAttribute('alt')||'').trim();
        const id=img.getAttribute('data-tap-editor-emoji-id');
        if(n&&id&&!out[n]) out[n]={id, url:img.getAttribute('src')||''};
      }
      return JSON.stringify(out);
    })()`;
    return ev(js, 20000).json || {};
  }

  return {
    session: S,
    ensureOrigin,
    auth,
    post,
    get,
    reply,
    childComment,
    remove,
    comments,
    feedHas,
    hasReplyText,
    emojiMap,
    sleep,
  };
}

/** 从帖子链接里取 momentId */
export function momentIdFromUrl(url) {
  const m = String(url || '').match(/\/moment\/(\d+)/);
  return m ? m[1] : '';
}

/** 去掉文案里的 [表情_xx] 标记（接口纯文本回复用；表情节点格式另说） */
export function stripEmojiMarks(text) {
  return String(text ?? '').replace(/\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\]/g, '');
}

// 每个 session 复用一个实例：鉴权信息、节流时间戳都跟着它，不必每次重建
const apiPool = new Map();
export function getTapApi({ runner, log = () => {}, intervalMs = 1000 } = {}) {
  const key = runner?.session || '__default__';
  let api = apiPool.get(key);
  if (!api) {
    api = makeTapApi({ runner, log, intervalMs });
    apiPool.set(key, api);
  }
  return api;
}
