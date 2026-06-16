# Verification Checklist: webui-memory-page

> 生成时间: 2026-06-16 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

<!--
每个 scenario → 1 个 S 条目。
验证方式推断规则:
  - 含 /api/ HTTP/curl/请求 → curl
  - 含 点击/页面/UI/表单/按钮 → chrome-devtools
  - 含 hash/加密/存储 → 代码审查
  - 含 npm test/pytest/cargo test → 单元测试
  - 无法自动验证 → 手动标记
-->

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 列出全部活跃 atom：DB 12 条 archived=0 → `GET /api/memory` 返回 12 条 | scenarios.md:L5-9 | curl | `curl -s http://127.0.0.1:<port>/api/memory \| jq 'length'` | `12` | [ ] |
| S2 | 打开 atom 详情：`GET /api/memory/:id` 返回完整 atom + content 从 .md 读 | scenarios.md:L11-15 | curl | `curl -s http://127.0.0.1:<port>/api/memory/<id> \| jq .content` | 非空字符串 | [ ] |
| S3 | 编辑 metadata 字段：title 改 + 3s 后 PATCH | scenarios.md:L17-21 | chrome-devtools | 打开 /memory, 点 atom, 改 title input, 停 3s | header `saving → saved`, list 同步刷新 | [ ] |
| S4 | metadata 改动不破坏 body：5KB body, 只改 title → body 字节级保持 | scenarios.md:L23-29 | code-review | `git diff` 看 `.md` 文件;运行 R3.2 单测 | 单测: read file body bytes == old body bytes | [ ] |
| S5 | 编辑 body 触发 .md 重写:hash 变, file_path 可能变, 旧文件 unlink | scenarios.md:L31-38 | curl | `curl -X PATCH .../api/memory/<id> -d '{"content":"new"}'` 后 `ls` 文件,`sqlite3 .../memory.db 'select content_hash,file_path,version from memory_index where id=<id>'` | hash 变, file_path 变, version+1, 旧 .md 不存在 | [ ] |
| S6 | body 编辑后 hash 不变（无操作）：hash 一致时文件不变 | scenarios.md:L40-44 | code-review | 写单测覆盖 `if (H2 === H1) 跳过文件写` 分支 | 单测绿（防御分支） | [ ] |
| S7 | 归档 atom: `POST /api/memory/:id/archive {archived:true}` → 列表移除 | scenarios.md:L46-50 | curl | `curl -X POST .../api/memory/<id>/archive -d '{"archived":true}'` + 列表 GET | HTTP 200, atom.archived=true, list 不含此 id | [ ] |
| S8 | 召回测试真实 pipeline:keywords / target_types / fts+cos+hybrid 分数 | scenarios.md:L52-60 | curl | `curl -X POST .../api/memory/search -d '{"query":"test"}'` | JSON 含 `rewritten.keywords[]`, `embedding_available`, `results[].{atom, fts_score, cosine_score, hybrid_score}` | [ ] |
| S9 | 路由切换强制 flush: 3s 内改 title + 切路由 → 离开前 PATCH 完成 | scenarios.md:L62-68 | chrome-devtools | /memory 改 title 0.5s 后点 sidebar Chat,等 200ms | 离开前 status=saved, 切回 /memory 看到新 title | [ ] |
| S10 | DB 文件不存在:全新机器 `GET /api/memory` 返回 `[]` | scenarios.md:L72-77 | curl | 临时 `HOME=/tmp/empty` 启 server, `curl .../api/memory` | HTTP 200, `[]`, DB 文件被创建 | [ ] |
| S11 | .md 文件丢失但 DB 行存在:`GET /api/memory/:id` 返回 `content:""` | scenarios.md:L79-83 | curl | 手动 `rm ~/.pi/agent/data/memory/atoms/.../*.md`, `curl .../api/memory/<id>` | HTTP 200, `content: ""` | [ ] |
| S12 | hash mismatch 防御:外部编辑 .md → `content:""` | scenarios.md:L85-89 | curl | 手动改 .md 后 `curl .../api/memory/<id>` | HTTP 200, `content: ""`, 不抛 | [ ] |
| S13 | PATCH 写失败:fetch reject → 回滚 + 红色 toast + 1 次重试 | scenarios.md:L91-96 | chrome-devtools | mock 500 PATCH,改 title | header 红色 `Save failed`, toast `Retry`, 3s 后第 2 次 PATCH, 仍失败则停 | [ ] |
| S14 | rewriteQuery LLM 失败 → 降级 `simpleKeywordExtraction` | scenarios.md:L98-103 | curl | mock `deps.callLlm` 抛错, `curl .../api/memory/search` | HTTP 200, `rewritten.keywords` 来自 `simpleKeyword` | [ ] |
| S15 | 本地 embedding 不可用 → 纯 FTS 分支 + `embedding_available:false` | scenarios.md:L105-109 | curl | 关闭 Ollama, `curl .../api/memory/search` | `embedding_available: false`, 每条 `cosine_score: 0` | [ ] |
| S16 | 编辑期间后台抽取并发写:SQLite 串行化 | scenarios.md:L111-116 | manual | TUI 跑 session 触发 extraction, webui 同时编辑不同 atom | 两条最终都在 list 出现, 无死锁 | [ ] |
| S17 | FTS 重建失败:主行写入,FTS 失败 toast warning | scenarios.md:L118-122 | manual | mock `memory_fts` DELETE/INSERT 抛错, PATCH | 主行写入, toast `FTS rebuild failed, will retry`, 下次 edit 自动重试 | [ ] |
| S18 | 0 atom 空态:DB 0 行 → "No memories yet" | scenarios.md:L126-129 | chrome-devtools | 空 DB 打开 /memory | 显示 "No memories yet" 占位 | [ ] |
| S19 | 1 atom 极简态:1 条 atom 正常显示 + filter 可用 | scenarios.md:L131-134 | chrome-devtools | 1 atom DB 打开 /memory, 切 type filter | 列表单卡, filter 仍可点 | [ ] |
| S20 | content 是空字符串:body 改 "" → 文件正常重写 | scenarios.md:L136-140 | curl | `curl -X PATCH .../api/memory/<id> -d '{"content":""}'` | HTTP 200, 文件 body 空, hash 变, version+1 | [ ] |
| S21 | tags 是空数组:`tags: []` 正常序列化 | scenarios.md:L142-145 | curl | `curl -X PATCH .../api/memory/<id> -d '{"tags":[]}'` | HTTP 200, DB tags JSON `"[]"`, .md frontmatter `tags: []` | [ ] |
| S22 | importance 改到边界值 0/1 | scenarios.md:L147-151 | curl | `curl -X PATCH .../api/memory/<id> -d '{"importance":0}'` 和 `1` | 都 HTTP 200, 后续 `runDecay` 用 λ=baseDecay(0)/λ=0(1) | [ ] |
| S23 | type 改成 constraint:`runDecay` 跳过 markArchived | scenarios.md:L153-157 | curl | `curl -X PATCH .../api/memory/<id> -d '{"type":"constraint"}'`, 调 `runDecay` | atom.type=constraint, 即使 strength 跌破阈值也不归档 | [ ] |
| S24 | 极长 body（50KB+）:编辑器 lazy mount | scenarios.md:L159-163 | chrome-devtools | 注入 50KB body atom, 打开 detail | textarea 60vh + 内部滚动, preview tab 渲染完整 markdown | [ ] |
| S25 | 多个 client 同时编辑同一 atom:last writer wins | scenarios.md:L165-169 | chrome-devtools | 2 个 webui tab 同 atom 都改 title | 后写者覆盖前写者, 3s 轮询同步 | [ ] |
| S26 | 路由快速切换闪入闪出:无 pending save 不阻塞 | scenarios.md:L171-175 | chrome-devtools | 进 /memory 0.1s 后立刻点 Chat | 路由立即切换, 无 await 阻塞 | [ ] |
| S27 | 两个 atom 同 title 触发 slug 冲突 | scenarios.md:L177-184 | curl | 注入 A 和 B 同 title, `curl .../api/memory/A` | A 的 content: ""(因 hash 错位), UI 标 memory-error | [ ] |

## 需求验证 (Requirements)

<!--
每个 ADDED/MODIFIED requirement → 1 个 R 条目。
REMOVED/RENAMED 不需要验证。
-->

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Webui Server List Memory Atoms（GET /api/memory + 过滤） | spec.md ADDED #1 | code-review + unit-test | `packages/webui/server/routes/memory.ts:list` 调 `getAllAtoms(idx)` + 4 步过滤;`packages/webui/server/test/memory-routes.test.ts` 5 个测试 (S1/archived=active/archived=all/type+tag+q/empty) 全绿 | [ ] |
| R2 | Webui Server Get Memory Atom Detail（GET /api/memory/:id + .md 读） | spec.md ADDED #2 | code-review + unit-test | `memory.ts:detail` 调 `readAtomFromFile` try/catch 设 `content: ""`;4 个测试 (S2/S3 exists/S4 file missing/S5 hash mismatch) 全绿 | [ ] |
| R3 | Webui Server Patch Memory Atom（PATCH /api/memory/:id） | spec.md ADDED #3 | code-review + unit-test | `memory.ts:patch` 复用 `writeAtomToFile(merged, deps.atomsDir)` + `unlinkSync` + `upsertAtom` + `invalidateEmbedding`;8 个测试 (S3 metadata/S4 preserve body/S5 body rewrite/S6 hash noop/S20 empty content/S21 empty tags/S22 importance 0/1/S23 type change) 全绿 | [ ] |
| R4 | Webui Server Archive Memory Atom（POST /api/memory/:id/archive） | spec.md ADDED #4 | code-review + unit-test | `memory.ts:archive` 调 `markArchived` 或 `upsertAtom({archived:false,version++})`;2 个测试 (archive active/restore) 全绿 | [ ] |
| R5 | Webui Server Memory Search（POST /api/memory/search） | spec.md ADDED #5 | code-review + unit-test | `memory.ts:search` 调 `rewriteQueryWithCallLlm` + `searchAtomsWithScores`;4 个测试 (正常/LLM 失败降级/embedding 不可用/0 atom) 全绿 | [ ] |
| R6 | Webui Server Memory Stats（GET /api/memory/stats） | spec.md ADDED #6 | code-review + unit-test | `memory.ts:stats` 调 `getAllAtoms` 聚合 byType + archivedCount;2 个测试 (空 DB/3 type 混合) 全绿 | [ ] |
| R7 | Personal-Assistant Public MemoryIndex API（export） | spec.md ADDED #7 | code-review + npm-run-check | `extensions/personal-assistant/index.ts` 含 7 个 value export + 2 个 type export;`npx tsgo --noEmit -p packages/webui/tsconfig.json` 0 错;`grep -E "^export" extensions/personal-assistant/index.ts` ≥8 行 | [ ] |
| R8 | Personal-Assistant Server-Friendly Memory Helpers（getAllAtoms/rewriteQueryWithCallLlm/searchAtomsWithScores） | spec.md ADDED #8 | unit-test | `extensions/personal-assistant/test/memory-exports.test.ts` 5 个测试 (getAllAtoms/rewriteQueryWithCallLlm 正常/失败降级/searchAtomsWithScores 有/无 embedding) 全绿 | [ ] |
| R9 | MemoryIndex invalidateEmbedding Method | spec.md ADDED #9 | unit-test | `memory-exports.test.ts` 1 个测试 (DELETE row) 全绿;`memory.ts:MemoryIndex` 有 `invalidateEmbedding(id: string): void` 公开方法 | [ ] |
| R10 | Webui Client Auto-Save with Flush on Route Change | spec.md ADDED #10 | unit-test + chrome-devtools | `packages/webui/web/src/lib/useAutoSave.test.ts` 4 个测试 (debounce 触发/route change flush/快速切换不阻塞/失败 1 次重试) 全绿 | [ ] |
| R11 | Webui Client Memory Page（/memory 路由 + 3-pane + sidebar icon） | spec.md ADDED #11 | chrome-devtools + code-review | `packages/webui/web/src/pages/MemoryPage.tsx` 渲染 3-pane;`AppShell.tsx` 加 Memory icon + 高亮;`App.tsx/main.tsx` 路由 `/memory`;空态/列表/stats badge 4 个 chrome-devtools 验证步骤通过 | [ ] |
| R12 | Webui Client Memory Detail and Editor（detail + editor） | spec.md ADDED #12 | chrome-devtools + unit-test | `MemoryDetail.tsx` 调 `api.memory.get` + `useAutoSave`;`MemoryEditor.tsx` 渲染 6 个字段控件;4 个 chrome-devtools 步骤 (打开 detail/改 title auto-save/改 body auto-save/50KB body 渲染) 通过 | [ ] |
| R13 | Webui Client Memory Search Tester Panel | spec.md ADDED #13 | chrome-devtools + code-review | `MemorySearchTester.tsx` 渲染 keywords/target_types chips + score tooltip + embedding unavailable 标签;4 个 chrome-devtools 步骤 (提交/分数 tooltip/embedding 不可用/LLM 降级 notice) 通过 | [ ] |
| R14 | Personal-Assistant Slugify Collision Known Bug (Documented) | spec.md ADDED #14 | code-review + curl | `design.md` Risks 表含 "slugify known bug" 行;`memory.ts:writeAtomToFile` 用 `join(dir, ${slug}.md)` 无 id 兜底;S27 单测/curl 验证同 title 行为 | [ ] |
| R15 | mountMemoryRoutes 接入 createApp（mount 顺序约束） | spec.md ADDED #1-6 隐含 | code-review | `packages/webui/server/index.ts:createApp` 调 `mountMemoryRoutes(app, {dbPath: MEMORY_DB_PATH, atomsDir: ATOMS_DIR, settings, callLlm})` 在 `mountSessionsRoutes` 之后、`mountStatic` 之前;`packages/webui/server/test/index.test.ts` 仍绿 | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S27) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R15) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
