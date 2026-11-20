// C2 自治治理（P0-M4，2026-11-17）：去重/冲突/时效/置信自校准。人工仅必要兜底。
// 保守阈值；过期/冲突标记不删（可恢复）；归档可回滚。
import { listFacts, setFactStatus, calibratedConfidence, initFacts } from './facts.mjs';

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

export function governFacts(db, { log = () => {} } = {}) {
  initFacts(db); // 补齐可能缺失的表（旧库升级）
  const report = { expired: 0, conflict: 0, dedup: 0, calibrated: 0 };
  const now = Date.now();
  let facts = listFacts(db);

  // 时效：validUntil 过期 → expired（降权/归档，不删）
  for (const f of facts) {
    if (f.validUntil && f.validUntil < now && f.status === 'active') {
      setFactStatus(db, f.id, 'expired');
      report.expired++;
    }
  }

  // 去重：同归一化 name 多条 → 留高置信，其余 archived
  const byName = new Map();
  for (const f of listFacts(db, { status: 'active' })) {
    // 真重复=同名且同 attrs；同名不同 attrs 留给冲突判定，不在此合并
    const k = norm(f.name) + '|' + JSON.stringify(f.attrs || {});
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(f);
  }
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    group.sort((a, b) => calibratedConfidence(db, b) - calibratedConfidence(db, a));
    for (const f of group.slice(1)) { setFactStatus(db, f.id, 'archived'); report.dedup++; }
  }

  // 冲突：同 name 同 type 但 attrs 不同 → conflict（回复时口语说矛盾）
  const active = listFacts(db, { status: 'active' });
  const seen = new Map();
  for (const f of active) {
    const k = norm(f.name) + '|' + f.type;
    const sig = JSON.stringify(f.attrs || {});
    if (seen.has(k) && seen.get(k) !== sig) { setFactStatus(db, f.id, 'conflict'); report.conflict++; }
    else seen.set(k, sig);
  }

  // 置信自校准回写 provenance.confidence
  for (const f of listFacts(db)) {
    const c = calibratedConfidence(db, f);
    if ((f.provenance?.confidence ?? null) !== c) {
      db.prepare('UPDATE facts SET provenance=?, updatedAt=? WHERE id=?')
        .run(JSON.stringify({ ...f.provenance, confidence: c }), Date.now(), f.id);
      report.calibrated++;
    }
  }
  log(`  [治理] 过期${report.expired} 冲突${report.conflict} 去重${report.dedup} 校准${report.calibrated}`);
  return report;
}