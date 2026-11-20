# P2（2026-11-17）：C6 结构化上下文组装 + C7 自治验证泛化

> 配套 `lib/assemble.mjs` / `lib/verify.mjs` / `lib/embed.mjs`；collect v2 接线；compose-reply `material` 参数。
> 上游设计：output/PVZ2资料库升级实施方案报告-20261117.md（C6/C7）。

## C6 结构化上下文组装（替换抽取式 top2 句）
- `assembleMaterial({entry, candidates, db, config, query})` → 参考资料块：
  - **facts 块**：attrs **全保留**（数值/条件/例外不丢）+ provenance（来源/官方/人工核实）+ 置信度档；
    同 name 另有 active/conflict 事实 → 「另有说法（未定论）」双方都呈现（systemPrompt 矛盾条款口语说出）。
  - **问答块**：top≤3 相关候选（score≥minScore）多候选合成；`summarizeAnswer` 结构化摘要：
    条件/例外/数值句（但/例外/如果/仅/除非/需要/条件/期间/活动/\d）**全留** + 话题最相关 2 句；
    超 cap 按**句界**裁剪先丢非条件句（不硬截 140 字）。
  - **预算**：`config.retrieve.maxMaterialChars`(默认1000)；高相关优先，facts 必保。
- compose-reply：`material` 参数给了就用（v2），不给走 `condenseMaterial`（v1 不变）。
- retrieve：candidates 带 entry（多候选组装用）；fact entry 带 attrs/provenance/status。

## C7 自治验证泛化
- `verifyCandidate`：检索后 **top1** 一次 LLM judge 拆两 aspect：
  `relevance`(是否真在问这条) + `faithfulness`(候选答是否被资料支持)；JSON 输出，兼容旧 yes/no。
  **缓存** `data/verify-cache.json`（key=hash(帖上下文|entryId|answer)，TTL `config.verify.cacheTtlHours` 默认24h）→ 控费。
- 分档 `tierOf` 不变：高≥70 准话 / 中≥50 降档口语 / 低<50 或 judge 不达标 → 弃答。
- **生成后忠实度自检** `checkFaithfulness(answer, material)`（扩展现泄露自检）：
  回复事实性内容（数值/规则/结论）须被资料支持；口语陪衬/情绪/话头不算。
  no 或 LLM 不可用 → 弃答转人工（reason=faithfulness_fail）；无资料跳过。`config.verify.postCheck` 开关。
- 置信自校准在 facts/govern（C2）：官方/verifiedAt/provenance.source 官方=95（P2 检查修：source 也认）。

## 验证
- test-assemble / test-embed / test-verify(拆分+缓存+自检) / test-retrieve / test-hybrid(dense) / test-rerank(onnx) 全绿。
- 自治原则：不确定即弃答/降档，人工仅必要兜底。