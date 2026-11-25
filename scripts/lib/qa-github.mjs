// GitHub 远端适配器（2026-11-25 多协作改造 P4.5）
//
// ## 为什么要有这层
//
// ① **每个人的 GitHub 渠道不一样** —— 账号、仓库、网络通路、代理都不同。
//    本机实测：git/curl 到 github.com 的 TLS 握手被重置（Connection was reset），
//    但 `gh` CLI 能通。所以访问方式必须可插拔，不能写死。
//
// ② **远端读写不能只靠 git** —— 合并要同时读 main、contrib/* 多个分支，
//    用 GitHub API 按分支读更直接；写回时 contents API 的 sha 就是乐观锁，
//    天然防「两人同时写同一个文件」。
//
// ## 三种访问方式
//
//   gh-cli    → 调 `gh api`（本机可用；不需要自己管 token，gh 从 keyring 取）
//   api-token → 直连 api.github.com，token 从环境变量读（适合装了 gh 但想绕开它的）
//   git       → 常规 fetch/push（网络通畅的机器）
//
// ## 统一接口
//
//   listEntries(ref, opts)              → [{path, sha, size}]
//   readEntry(path, ref)                → {content, sha}
//   writeEntry(path, text, opts)        → {ok, sha}（sha 不匹配 → 409 → skipped）
//   listBranches(prefixFilter)          → ['contrib/a', ...]
//   createBranch(name, commitSha)       → {ok}
//   getRefSha(ref)                      → sha
//
// ## 测试友好
//
// fetch 与 gh 调用都可注入（opts.fetch / opts.runner），所以能离线测。

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

/** 读环境变量（tokenEnv） */
function readToken(env) {
  const name = env?.tokenEnv || 'GH_TOKEN';
  return process.env[name] || process.env.GITHUB_TOKEN || '';
}

/** 调 gh api，返回 JSON（注入 runner 便于测试） */
function ghApi(args, { runner = null, input = null } = {}) {
  const run =
    runner ||
    ((a, opts) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(opts || {}) }));
  const out = run(['api', ...args], input ? { input } : {});
  return JSON.parse(String(out).trim());
}

/**
 * 建一个 GitHub 远端
 * @param {object} cfg {owner, repo, access, tokenEnv, defaultBranch, name}
 * @param {object} [opts] {fetch, runner, env}
 */
export function createGithubRemote(cfg = {}, opts = {}) {
  const owner = cfg.owner || '';
  const repo = cfg.repo || '';
  const access = cfg.access || 'gh-cli';
  const mainBranch = cfg.defaultBranch || 'main';
  const name = cfg.name || `github:${owner}/${repo}`;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const runner = opts.runner || null;
  const env = opts.env || process.env;
  const token = readToken({ ...cfg, ...env });

  if (!owner || !repo) {
    return {
      name,
      available: false,
      reason: 'remote.owner / remote.repo 没配',
      listEntries: async () => [],
      readEntry: async () => null,
      writeEntry: async () => ({ ok: false, error: 'remote not configured' }),
      listBranches: async () => [],
      createBranch: async () => ({ ok: false, error: 'remote not configured' }),
      getRefSha: async () => null,
    };
  }

  const apiPath = (p) => `repos/${owner}/${repo}/${p}`;

  // ── HTTP 通路（api-token） ──
  async function httpApi(method, path, body = null) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-qa-collab',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetchImpl(`${API}/${apiPath(path)}`, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const rawBody = await r.text();
    let json = null;
    try {
      json = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      /* 非 JSON */
    }
    if (!r.ok) {
      const err = new Error(json?.message || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // ── gh CLI 通路 ──
  function ghCall(method, path, body = null) {
    const args = [method === 'GET' ? `GET ${path}` : `--method ${method} ${path}`];
    if (body) args.push('--input -');
    return ghApi(args, { runner, input: body ? JSON.stringify(body) : null });
  }

  const useHttp = access === 'api-token';
  const call = useHttp
    ? (method, path, body) => httpApi(method, path, body)
    : (method, path, body) => ghCall(method, path, body);

  return {
    name,
    access,
    owner,
    repo,
    defaultBranch: mainBranch,
    available: true,

    /** 列某分支下的条目文件（qa/entries/*.md） */
    async listEntries(ref = '', opts = {}) {
      const { prefix: dirPrefix = 'qa/entries/' } = opts || {};
      const target = ref || this.defaultBranch;
      try {
        const sha = await this.getRefSha(target);
        if (!sha) return [];
        const tree = await call('GET', `git/trees/${sha}?recursive=1`);
        return (tree.tree || [])
          .filter((t) => t.type === 'blob' && t.path.startsWith(dirPrefix) && t.path.endsWith('.md'))
          .map((t) => ({ path: t.path, sha: t.sha, size: t.size }));
      } catch {
        return [];
      }
    },

    /** 读某分支的某个文件 */
    async readEntry(path, ref = '') {
      const target = ref || this.defaultBranch;
      try {
        const j = await call('GET', `contents/${encodeURI(path)}?ref=${encodeURIComponent(target)}`);
        const content = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : '';
        return { content, sha: j.sha, path: j.path };
      } catch {
        return null;
      }
    },

    /**
     * 写条目（新增或更新）
     * sha 不匹配 → GitHub 返回 409 → 返回 {ok:false, conflict:true}（调用方跳过，不覆盖）
     * @param {string} text 条目正文
     */
    async writeEntry(path, text, opts = {}) {
      const { branch: target = this.defaultBranch, sha: prevSha = null, message = 'chore: update qa entry' } = opts || {};
      const body = {
        message,
        content: Buffer.from(String(text || ''), 'utf8').toString('base64'),
        branch: target,
      };
      if (prevSha) body.sha = prevSha;
      try {
        const j = await call('PUT', `contents/${encodeURI(path)}`, body);
        return { ok: true, sha: j?.content?.sha || null, path: j?.content?.path || path };
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          return { ok: false, conflict: true, error: e.message, status: e.status };
        }
        return { ok: false, error: e.message, status: e.status };
      }
    },

    /** 列分支（按前缀过滤） */
    async listBranches(prefixFilter = '') {
      try {
        const j = await call('GET', 'branches?per_page=100');
        return (j || []).map((b) => b.name).filter((n) => !prefixFilter || n.startsWith(prefixFilter));
      } catch {
        return [];
      }
    },

    /** 取分支当前 sha */
    async getRefSha(ref = '') {
      const target = ref || this.defaultBranch;
      try {
        const j = await call('GET', `git/ref/heads/${encodeURIComponent(target)}`);
        return j?.object?.sha || null;
      } catch {
        return null;
      }
    },

    /** 建分支（从给定 sha 拉出） */
    async createBranch(branchName, commitSha) {
      try {
        await call('POST', 'git/refs', { ref: `refs/heads/${branchName}`, sha: commitSha });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}

/**
 * 按配置建一组远端（可多个）
 * @param {object} collab config.collab
 * @param {object} [opts]
 */
export function createRemotes(collab = {}, opts = {}) {
  const list = [];
  const r = collab.remote || {};
  if (r.owner && r.repo) {
    list.push(createGithubRemote({ ...r, name: r.name || `github:${r.owner}/${r.repo}` }, opts));
  }
  return list;
}
