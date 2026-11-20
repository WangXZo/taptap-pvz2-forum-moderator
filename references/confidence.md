# 动态置信度与知识分层（2026-11-17）

> 配套 `lib/facts.mjs` / `lib/confidence.mjs` / `lib/govern.mjs` / `lib/verify.mjs` / `lib/feedback.mjs` / `lib/retrieve.mjs`。
> 管线开关 `config.pipeline`：v1=旧稳定链路；**v2=事实层优先检索+分档验证+动态置信+负反馈闭环（已上线）**。

## 1. 知识分层（C1）
- **事实层 facts**（SQLite 表）：结构化实体（plant/item/level/event/rule），`name/aliases/attrs/provenance/validUntil/status` + `fact_sources`(渠道) + `fact_feedback`(玩家确认/反对)。
- **问答层**：`qa/答疑库.md` 保留（话术/攻略/庆祝指引）。
- 迁移：`work/migrate-qa.mjs`(dry-run 并发抽取) → `migrate-pass2.mjs`(重分类+重试) → `migrate-apply.mjs`(备份+落库)。154 条 → facts 6 / 问答层 149。

## 2. 动态置信档位（用户规格，自治校准）
| 证据 | 置信 | 回复口气 |
|---|---|---|
| 官方资料 / 人工核实(verifiedAt) | 95 | 准话 |
| >3 渠道 且 ≥3 玩家统一 | 80 | 准话 |
| ≥2 渠道一致 | 70 | 准话 |
| 单一社区 | 50 | 降档口语（我印象里/听说） |
| 玩家负反馈(未解决) | 30 | **弃答** + needs_reverify |

- 分档验证 `verify.tierOf`：高≥70 答 / 中≥50 降档 / 低<50 或 judge 不达标 → 弃答。
- 校准 `facts.calibratedConfidence`（单一实现），`confidence.calibrate` 委托。

## 3. 负反馈闭环（动态自调整）
1. 我们已答的帖，玩家回复**反对结论** → `feedback.detectOpposition`(LLM yes/no) 命中。
2. `confidence.recordNegative` → 置信先降 30 + status=needs_reverify。
3. `confidence.reverify` → LLM 核实是否**过时/更新**：confirmed→清负反馈+按证据重置置信；outdated→expired；uncertain→保持降档。
4. 判断依据：官方资料 / 多渠道核实 / 多玩家确认 / 玩家负反馈。

## 4. 自治治理（C2，人工仅必要兜底）
`govern.governFacts`：去重(同名同attrs合并留高置信) / 冲突(同名不同attrs→conflict) / 时效(validUntil过期→expired) / 置信自校准回写。归档可恢复。

## 5. 检索（P0 最小，P1 升级接口已留）
`retrieve.retrieve`：facts name/alias 精确 lookup 优先 → 问答层 matchPost 兜底；返回 {source, entry, score, candidates}。P1 换 hybrid+RRF+rerank 不动调用方。