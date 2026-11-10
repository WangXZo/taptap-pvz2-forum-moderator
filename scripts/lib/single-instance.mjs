// 单实例锁（2026-11-09 重写：改用**端口锁**）
//
// 为什么废弃原来的 pid 文件锁：
//   读 pid → 判断活着没 → 写 pid 这**三步不是原子的**。
//   两个进程几乎同时启动时，都会读到「旧 pid 已死」→ 都接管 → **双实例**。
//   实测过两次：双 watch 同时处理同一队列 → 会重复回复玩家，必须根治。
//
// 端口锁为什么可靠：
//   操作系统保证同一端口只能被一个进程 listen 成功 —— 这是**原子**的。
//   第二份启动时 listen 失败 → 立刻退出。
//
// 端口分配（config.daemon.ports 可覆盖）：
//   watch     → 45871
//   mod-watch → 45872

import { createServer } from 'node:net';

/** 拿到的 server 必须**保持引用**，否则被 GC 回收后端口就释放了 */
const _held = new Map();

export const DEFAULT_PORTS = { watch: 45871, 'mod-watch': 45872 };

/**
 * 尝试占住端口
 * @param {{port:number, name?:string}} o
 * @returns {Promise<{ok:boolean, port:number, close:Function}>}
 */
export function acquireInstanceLock({ port, name = '' } = {}) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return Promise.resolve({ ok: true, port: 0, close() {} });

  return new Promise((resolve) => {
    const srv = createServer();
    const done = (ok) => {
      if (ok) {
        _held.set(p, srv);
        const close = () => {
          try {
            srv.close();
          } catch {}
          _held.delete(p);
        };
        resolve({ ok: true, port: p, close, name });
      } else {
        try {
          srv.close();
        } catch {}
        resolve({ ok: false, port: p, close() {}, name });
      }
    };
    srv.once('error', () => done(false));
    srv.listen(p, '127.0.0.1', () => done(true));
  });
}

/**
 * 守护进程用这个：拿不到锁就打印原因并退出
 *
 * @param {{port:number, name?:string, log?:Function}} o
 */
export async function ensureSingleInstance({ port, name = 'daemon', log = console.log } = {}) {
  const lock = await acquireInstanceLock({ port, name });
  if (!lock.ok) {
    log(`  [退出] 已有 ${name} 实例在运行（端口 ${port} 被占用）→ 避免重复处理，本次不启动`);
    process.exit(0);
  }
  process.on('exit', () => lock.close());
  process.on('SIGINT', () => {
    lock.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    lock.close();
    process.exit(0);
  });
  return lock;
}

/** 进程是否还活着（保留给别处用；守护不再靠它判重） */
export function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}