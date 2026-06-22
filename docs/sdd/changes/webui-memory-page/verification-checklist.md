# Verification Checklist: webui-memory-page

> 生成时间: 2026-06-22 | 审查者必须逐项验证并附可追溯证据
> 状态: [ ] 待验证 | [x] 通过 | [!] 失败（必须修复或记录偏差）

## 场景验证 (Scenarios)

| # | 场景 | 来源 | 验证方式 | 验证命令/步骤 | 期望结果 | 状态 |
|---|------|------|----------|--------------|---------|------|
| S1 | 列出全部活跃 atom | scenarios.md:L4 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/pages/MemoryPage.test.tsx` | MemoryPage.test.tsx 测 mount 调 GET /api/memory?archived=active + 列表渲染 12 张卡片 | [ ] |
| S2 | 打开 atom 详情 | scenarios.md:L10 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryDetail.test.tsx` | MemoryDetail.test.tsx 测装入 atom 后调 GET /api/memory/:id + 渲染 metadata + body | [ ] |
| S3 | 编辑 metadata 字段 | scenarios.md:L16 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryEditor.test.tsx` | MemoryEditor.test.tsx 测改 title + 3s 后 PATCH /api/memory/:id body {title} | [ ] |
| S4 | metadata 改动不破坏 body | scenarios.md:L22 | code-review | 查 `packages/webui/server/routes/memory.ts:215-260` PATCH handler 读 currentBody 兜底 | PATCH 不传 content 时 body 字节级保持, 仅 frontmatter updated_at 变 | [ ] |
| S5 | 编辑 body 触发 .md 重写 | scenarios.md:L29 | code-review | 查 `packages/webui/server/routes/memory.ts:215-260` PATCH handler 调 writeAtomToFile | server 重算 hash, 写同 path (atom.id 命名), updateAtom(content_hash), deleteVector | [ ] |
| S6 | body 编辑后 hash 不变 | scenarios.md:L37 | unit-test | MemoryEditor.test.tsx 测改回原值 + 3s + 不触发 PATCH | onPatch 不被调 (diff 为空) | [ ] |
| S7 | 归档 atom 不 debounce | scenarios.md:L43 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemoryDetail.test.tsx` | MemoryDetail.test.tsx 测点 Archive 立即调 POST /api/memory/:id/archive, 不经 3s | [ ] |
| S8 | 召回测试 v2 真实 pipeline | scenarios.md:L50 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/components/memory/MemorySearchTester.test.tsx` | MemorySearchTester.test.tsx 测输入 query + 点 Search 调 POST /api/memory/search, mock 返 results 后表格渲染 | [ ] |
| S9 | 召回空结果 ollama 不可用 | scenarios.md:L57 | unit-test | MemorySearchTester.test.tsx 测 mock 返 {results: []} | UI 标 "No results (embedding service unavailable)" | [ ] |
| S10 | 路由切换强制 flush | scenarios.md:L62 | unit-test | `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run src/lib/useAutoSave.test.ts` | useAutoSave.test.ts 测 unmount cleanup 立即调 save 但 await 不超 200ms | [ ] |
| S11 | DB 文件不存在 | scenarios.md:L70 | manual | 删 `~/.pi/agent/memory.db` + 启 webui + 访问 /memory | UI 显示 "No memories yet" 而非 500 | [ ] |
| S12 | .md 文件丢失但 DB 行存在 | scenarios.md:L76 | manual | `unlink <file_path>` 然后 GET /api/memory/:id | 返 atom + content: "" + UI 标 `<memory-error>` | [ ] |
| S13 | hash mismatch 防御 | scenarios.md:L83 | manual | 手动改 .md 文件 + GET /api/memory/:id | 抛 Error, UI 标 `<memory-error>` | [ ] |
| S14 | PATCH 写失败 | scenarios.md:L88 | unit-test | MemoryEditor.test.tsx 测 onPatch reject | 状态条 "Save failed" 红色 + Retry 按钮 | [ ] |
| S15 | 编辑期间后台抽取 | scenarios.md:L95 | manual | 起 extraction + 同时改另一条 atom | 写入不阻塞, list 刷新同时看到两条 | [ ] |
| S16 | 0 atom 空态 | scenarios.md:L106 | unit-test | MemoryList.test.tsx 测空 atoms 数组 | 渲染 "No memories yet" | [ ] |
| S17 | 1 atom 极简态 | scenarios.md:L111 | unit-test | MemoryList.test.tsx 测 1 atom | 渲染 1 张卡, filter 仍可用 | [ ] |
| S18 | content 空字符串 | scenarios.md:L115 | manual | body 改空字符串 + 保存 | frontmatter 正常 + body 空, hash 变 | [ ] |
| S19 | tags 空数组 | scenarios.md:L121 | unit-test | MemoryEditor.test.tsx 测 tags=[] 保存 | chip input 显示 "Add tag…", 正常序列化 | [ ] |
| S20 | importance 边界值 | scenarios.md:L126 | unit-test | MemoryEditor.test.tsx 测 importance=0 / 1 | slider 接受, PATCH 200 | [ ] |
| S21 | type 改成 rule | scenarios.md:L132 | unit-test | MemoryEditor.test.tsx 测 type 改 rule + 保存 | .md 写到 atoms/rule/<id>.md, runDecay 跳过 archive | [ ] |
| S22 | 极长 body 50KB+ | scenarios.md:L139 | manual | 注入 50KB body + 打开详情 | preview tab 渲染 markdown, edit tab textarea 60vh 高 | [ ] |
| S23 | 多个 client 同时编辑 | scenarios.md:L146 | manual | 两个 webui tab 改同一 atom title | 后写者覆盖, refetch 后看到同一最终值 | [ ] |
| S24 | 路由快速切换闪入闪出 | scenarios.md:L151 | unit-test | MemoryPage.test.tsx 测 mount + 0.1s 后 unmount | cleanup 正确, 无 in-flight PATCH 时无 await | [ ] |
| S25 | 召回空结果 (v2 删 rewriteQuery) | scenarios.md:L156 | unit-test | MemorySearchTester.test.tsx 测 mock 返 {results: []} | UI 标 "embedding service unavailable" | [ ] |

## 需求验证 (Requirements)

| # | 需求 | 来源 | 验证方式 | 期望证据 | 状态 |
|---|------|------|----------|---------|------|
| R1 | Webui /memory 页面 (浏览/编辑/归档/召回) | spec.md ADDED #1 | unit-test | MemoryPage.test.tsx 存在, 测 mount + 列表 + 详情 + 归档 + 召回 | [ ] |
| R2 | 客户端 API 命名空间 (api.memory.*) | spec.md ADDED #2 | unit-test | `packages/webui/web/src/lib/api.test.ts` 6 个 memory tests pass | [ ] |
| R3 | useAutoSave hook (3s debounce + unmount flush) | spec.md ADDED #3 | unit-test | `useAutoSave.test.ts` 6 tests pass (idle / dirty / saving→saved / error / unmount / flush) | [ ] |
| R4 | MemoryTypeBadge 组件 (3 行组件) | spec.md ADDED #4 | unit-test | `MemoryTypeBadge.test.tsx` 3 tests pass (rule/fact/process 颜色+label) | [ ] |
| R5 | MemoryList 组件 (filter + 卡片列表) | spec.md ADDED #5 | unit-test | `MemoryList.test.tsx` 5 tests pass (default/archived/type/q/empty) | [ ] |
| R6 | MemoryEditor 组件 (useAutoSave 集成) | spec.md ADDED #6 | unit-test | `MemoryEditor.test.tsx` 4 tests pass (改→3s/PATCH/失败回滚/不变不触发) | [ ] |
| R7 | MemoryEditorStatus 组件 (状态条) | spec.md ADDED #7 | unit-test | `MemoryEditorStatus.test.tsx` 4 tests pass (idle/dirty/saving/error) | [ ] |
| R8 | MemoryDetail 组件 (atom 装入 + 归档 toggle) | spec.md ADDED #8 | unit-test | `MemoryDetail.test.tsx` 3 tests pass (null/Archive/Restore) | [ ] |
| R9 | MemorySearchTester 组件 (query + results table) | spec.md ADDED #9 | unit-test | `MemorySearchTester.test.tsx` 3 tests pass (POST/表格/空 unavailable) | [ ] |
| R10 | MemoryPage 顶层装配 | spec.md ADDED #10 | unit-test | `MemoryPage.test.tsx` 3 tests pass (mount 拉 list/click 拉 detail/PATCH refetch) | [ ] |
| R11 | Sidebar IconRow 加 Memory icon | spec.md ADDED #11 | chrome-devtools | 启 dev server, 浏览器 DevTools, 访问 /memory → Memory icon `className` 含 `bg-blue-100` | [ ] |
| R12 | App.tsx 加 /memory 路由 | spec.md ADDED #12 | chrome-devtools | 浏览器访问 /memory → React Router 渲染 MemoryPage in Outlet | [ ] |
| R13 | (后端 0 改动) | principles.md | code-review | `git diff main..HEAD -- extensions/personal-assistant packages/webui/server` 0 lines 改动 | [ ] |
| R14 | (3s 轮询 list) | design.md Decision 6 | unit-test | MemoryPage.test.tsx 测 `vi.useFakeTimers()` 3s → refetch | [ ] |

## 通过标准

- [ ] 所有场景 (S1-S25) 状态为 [x]，每项有可追溯证据
- [ ] 所有需求 (R1-R14) 状态为 [x]，每项有源码行号
- [ ] 证据格式: R 类 → 源码文件:行号，S 类 → curl 输出/screenshot/测试结果
- [ ] 后端 0 改动验证: `git diff main..HEAD -- extensions/personal-assistant packages/webui/server` 输出为空
- [ ] 全量测试 pass:
  - [ ] webui web 端: `cd packages/webui/web && node ../../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (6+1+1+1+1+1+1+1+1+1+1+1 = 17+ new tests + 6 existing pass)
  - [ ] webui server 端: `cd packages/webui && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (264 tests pass, 0 改动)
  - [ ] personal-assistant: `cd extensions/personal-assistant && node ../../node_modules/vitest/dist/cli.js --run --no-file-parallelism 2>&1 | tail -3` (355 tests pass, 0 改动)
- [ ] Lint: `cd /home/qjh/workspace/personal/pi && npm run check 2>&1 | tail -5` 0 error
- [ ] Manual e2e: 启 dev server + 浏览器访问 /memory → 列表 + 详情 + 编辑 + 召回全流程
