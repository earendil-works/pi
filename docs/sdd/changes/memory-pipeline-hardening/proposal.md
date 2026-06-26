# 变更提案: memory-pipeline-hardening

## 动机

Memory 管线当前存在 5 个真实痛点(基于对源码的逐条核验):

1. **写入冲突无防护**: `MemoryDetail.tsx:80-89` 的 `useAutoSave` 3 秒 debounce 后直接 PATCH,但 PATCH 路由 `memory.ts:216-288` 不校验 `expected_version`。3 秒内服务端可能已被 SSE 推送/其他客户端更新,本地乐观更新会无声覆盖远端数据。
2. **webui 路径绕过 supersede**: `MemoryEditor.tsx:158-167` 的 `empty body` 警告暴露了根因 —— webui 直接 PATCH 走 `memory.ts:216`,**不经过** `extraction.ts:122-162` 的 cosine > 0.92 supersede 门。同标题的新写入会覆盖原 atom 的 `.md` 文件。
3. **3 秒轮询浪费**: `MemoryDetail.tsx:73` 无论是否变化都打一次 `GET /api/memory/:id`,空载率 > 99%。无版本变化时 SSE 是零冗余替代。
4. **tag 无规范化**: `MemoryEditor.tsx:64` 只有 split+trim+filter,同概念的 `代码规范 / code-style / coding-rule` 三种写法产生孤立检索噪声。
5. **检索打分公式缺两维度**: `search.ts:506-508` 的 `score = cosine × (1 + 0.3strength + 0.2importance)` 不含 `tag_overlap` 和 `freshness_decay`。语义命中但 tag 错的 atom 排在语义差但 tag 命中的 atom 前。

## 影响范围

- 新增 Capability:
  - `memory-write-conflict-detection`(CAS via If-Match 头)
  - `memory-detail-stream`(SSE 单 atom 推送)
  - `memory-tag-normalization`(写入路径自动归一)
  - `memory-search-scoring`(score 公式加 tag_overlap + freshness_decay)
- 修改 Capability:
  - `memory-write-path`(webui PATCH 接入 cosine supersede)
  - `memory-recall`(打分公式扩展)
- 删除 Capability: 无

## 非目标

- 不实现"弹出 LLM 判断 合并/补充/矛盾"对话框(用户已选 静默自动 supersede)
- 不替换 List/Stats 的轮询(SSE 范围仅 Detail)
- 不引入新依赖(express 自带 SSE 能力足够)
- 不做 tag alias 的 LLM 自动提议(MVP 仅手工维护 JSON)
- 不重构 `computePatch` 的客户端深比较逻辑(被 SSE 推送+server-side CAS 替代后影响小;留 follow-up)

## 验收标准

1. **CAS**: 客户端用旧 version 发 PATCH,服务端返回 409 + 当前 atom,UI 展示合并选项或重载。
2. **supersede**: webui PATCH 时,新内容与现有 active atom 的 cosine > 0.92,自动调用 `markSupersededTx`,新 atom 继承旧 atom 的 strength/access_count。
3. **SSE**: `GET /api/memory/:id/stream` 返回 `text/event-stream`,PATCH 命中该 id 时推送 `{version, atom}` 事件。客户端 `MemoryDetail` 用 `EventSource` 替代 `setInterval(..., 3000)`。
4. **tag 规范化**: 写入时经 `normalizeTags(input)` 走 `settings.memory.tagAliases` 映射,空 tag/重复 tag 被合并。UI 输入也即时归一化。
5. **scoring**: 新公式
   ```
   score = cosine × (1 + 0.3strength + 0.2importance)
         + 0.10 × tag_overlap(query, atom.tags)
         + 0.05 × freshness_decay(updated_at)
   ```
   保留 `cosine/score` 字段含义(back-compat),新增 `tagOverlap/freshness` 字段便于 debug。