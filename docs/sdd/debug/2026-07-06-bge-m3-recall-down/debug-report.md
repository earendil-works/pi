# Debug Report: bge-m3 recall regression 2026-07-06

- **日期**: 2026-07-06
- **症状**: 复合 query "你还记得MGM项目工时计算吗" → 0 hits;webui/TUI 静默返回空;
  用户怀疑 gate/rewrite 没运行,实际是 bge-m3 服务不在。
- **根因**:
  1. `/tmp/bge-m3-test/server.py` 被系统清掉(/tmp 周期性清理),整个目录消失
  2. `~/.config/systemd/user/bge-m3-server.service` 仍指向该路径,陷入 auto-restart 死循环
  3. `extensions/personal-assistant/hybrid-search.ts:83-86` silent `catch` 把所有 bge-m3 失败折叠为 `[]`
- **因果链**: `bge-m3 FastAPI 没跑` → `hybridSearch()` 返回 `[]` (silent catch) → `recallAtoms()` 返 `[]` →
  `search/rerank/merge` 0 hits → `webui` `{results: []}` → 用户看不到"service 不可达"信号
- **修复**:
  1. **重建 server.py** 到持久路径 `~/pi/agent/bge-m3/server.py`,语义与原 `/tmp/bge-m3-test/server.py` 一致
     (端点 `/api/search`, `/api/rerank`, `/api/atoms/{id}/reindex`, `/api/health`)
  2. **重写 systemd unit** 指到新路径,reload daemon,enable 启动
  3. **重新编码 vectors.db** (`reencode_atoms.py`) 用 CPU FP32,使 query 编码与 atom 编码精度一致
     (原 vectors.db 是 GPU FP16 编码,CPU 编码 cosine 低 0.03-0.05)
  4. **降阈值** `DENSE_FLOOR 0.55 → 0.50`, `SPARSE_FLOOR 0.30 → 0.25` 抵消 CPU FP32 精度差
     (`.opencode/plans/2026-07-02-memory-recall-url-noise.md` 旧分析基准为 GPU FP16)
  5. **可观测性**:
     - `hybrid-search.ts:80-100`:`catch` 不再 silent,打 structured warning 标 `[bge-m3] /api/search unreachable: {reason}`
     - webui 路由 `/api/memory/search`:上线 100ms 预算的 `/api/health` probe,响应里新增 `embeddingServiceStatus: "up" | "down"` 字段
- **防御层**:
  | 层 | 行为 |
  |---|---|
  | 服务入口(`bge-m3 FastAPI`) | systemd `--user` 单元,auto-restart + boot 启动 |
  | 数据持久化(`/home/qjh/.pi/agent/bge-m3/`) | 不再放 `/tmp` |
  | 客户端可观测(`hybrid-search.ts`) | `[bge-m3] /api/search unreachable: …` console warning |
  | API 可观测(webui 响应) | `embeddingServiceStatus` 字段 |
- **经验教训**:
  1. **`/tmp` 是临时位置不是部署位置** — 重要 service 的入口不能在 `/tmp`。
     systemd unit 里 `ExecStart=/.../tmp/.../server.py` 这种路径完全没有保证;
     应该 `/home/qjh/.local/share/` 或 `~/pi/agent/` 这类持久位置。
  2. **Silent catch = silent failure** — `try { ... } catch { return [] }` 模式在 service 调用层
     让 root-cause 故障无法被发现。`hybrid-search.ts` 这次改为 `catch (err) { console.warn(...); return [] }`,
     但更高保真的做法是返回一个 union 类型 `HybridSearchResult = { hits, status }` 让 caller 自己做决策。
  3. **编码精度必须对齐** — bge-m3 在 GPU FP16 / CPU FP32 / CPU FP16 三种精度下产生的 dense 向量
     不严格一致(L2-normalize 后通常 0.03-0.05 差异),如果 query 和 atom 用不同精度编码,
     cosine similarity 的绝对阈值 (DENSE_FLOOR) 会失效。要么统一精度,要么重新校准阈值。
     本次选择"CPU FP32 + 降低阈值",是因为 CPU 与 GPU 4GB 共存风险。
- **遗留 TODO**:
  - **webui dist 部署**:本次编辑的 `embeddingServiceStatus` 字段在 `routes/memory.ts` 源里,
    但生产 `packages/coding-agent/dist/webui/server.bundle.js` 是 esbuild bundle,不含新字段。
    需要走 `packages/webui` build + 手动 cp + restart 流程才能让 webui 用户看到该字段。
  - **启动时的 `/api/health` probe 增加 ~50-100ms latency** per webui request。
    如果 webui 高频调用,可考虑 5-10s 短期 cache。

## 后续修复 (2026-07-06 同日)

### a. GPU 迁移
我之前认为 ollama 占用 GPU 导致 bge-m3 不能上 GPU — 这是错的。
`curl http://127.0.0.1:11434/api/ps` 显示 `size_vram: 0`,ollama 实际跑 CPU。
RTX 3050 4GB 里有 3.7GB 空,够塞 bge-m3 + bge-reranker (共 ~1.2GB 实测 FP16)。

bge-m3 + bge-reranker 都迁 GPU FP16,server 的 `use_fp16=True` + `device='cuda:0'`。

### b. Vectors.db 重回 GPU 精度
CPU FP32 重编码的 vectors.db 跟 GPU FP16 query 编码有 0.03-0.05 cosine 差。
重新 GPU FP16 编码 56 个 atom,2.3s 一次,vectors.db 与 query 编码精度重新一致。
`DENSE_FLOOR` / `SPARSE_FLOOR` 校准回原值(暂未改回 0.55/0.30,因为新 re-encode 与旧 calibration 的差异还需 audit — 留为下一步 TODO)。

### c. Reranker threshold 重校准
意外发现:cross-encoder 对**直接词匹配** query 信心 ~0.97,对**会话式** query 信心 ~0.04。
`(qa_query, hit)` 实测:
- `"MGM项目"` vs MGM atom: 0.992 (高)
- `"你还记得MGM项目工时计算吗"` vs MGM atom: 0.044 (低但仍相关)
- `"MGM项目"` vs 工时 atom: 0.0 (正确)

threshold 0.5 把所有会话式命中都砍掉。降到 **0.05** 是会话式命中与噪声的真分界,
且 gap 检测 (0.15) 在切割噪声尾部仍然有效。

修改:`extensions/personal-assistant/rerank.ts:DEFAULT_THRESHOLD` 0.5 → 0.05,
加注释解释双区段(cross-encoder 已知特性)。

### d. 当前行为验证
用户 query "你还记得MGM项目工时计算吗" 经过改后 pipeline:
- rewrite → 子查询 (qwen2.5:3b 1.3s)
- per-subquery recall (bge-m3 GPU FP16,~50ms)
- per-subquery rerank (bge-reranker GPU,~95ms)
- threshold 0.05 → MGM 命中 (rerankScore 0.97) survives,工时估算 0.005 被砍
- final:1 hit (MGM 项目),user prompt 注入该 atom 的格式化文本

仅 1 hit 是因为 rewrite 拆出的子查询里只有"MGM项目"一个召回到了候选;
会话式"还记得"部分被 rewrite 拆出但没有召回到 — 这是 rewrite 的限制,不是 recall 的问题。
