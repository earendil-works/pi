# 使用场景: agent-driven-memory-save

## 正常流程

### 场景: agent 主动新增 atom (无 id, 无相似)
- **GIVEN** 当前 DB 内无 cosine ≥ 0.65 的相似 atom;agent 决定"记住:用户偏好用 bun 而不是 npm"
- **WHEN** agent 调用 `memory_save({type:"rule", title:"...", content:"...", tags:["preference"], importance:0.7})`
- **THEN** tool 返回 `{ok:true, id:"<新 uuid>", action:"created"}`;`writeAtomToFile` 写 `.md`;`MemoryIndex.insertAtom` 入 DB;embedding 成功后 `upsertVector`;recall 路径可命中该 atom

### 场景: agent overwrite 已有 atom (id 复用)
- **GIVEN** DB 存在 atom `a-123`(recall 看到 summary);agent 决定更新它的内容
- **WHEN** agent 调用 `memory_save({id:"a-123", type:"rule", title:"...", content:"new content", tags:[...], importance:0.7})`
- **THEN** tool 找到 `a-123` → `deleteVector(a-123)` → 删旧 `.md` 文件 → `insertAtom` 用相同 id 写入新 row(version+1, is_latest=1)→ `writeAtomToFile` 写新 `.md` → `upsertVector` 新 embedding;返回 `{ok:true, id:"a-123", action:"overwritten"}`

### 场景: 冲突检测后 agent 决定 overwrite-with-id
- **GIVEN** DB 存在 atom `a-456`(cosine 与新内容 ≥ 0.65);agent 第一次调用无 id 的 save
- **WHEN** `memory_save({type:"fact", title, content, tags, importance})`
- **THEN** tool 返回 `{conflict:{id:"a-456", score:0.78, title:"..."}}`,不写入;agent 看到 conflict 后调 `memory_save({id:"a-456", type:"fact", content:"new content", ...})` 走 overwrite 路径,旧 atom `a-456` 的 file/row/vector 全清,新 atom 复用 id `a-456` 入库,返回 `{ok:true, id:"a-456", action:"overwritten"}`

### 场景: safety net 在 0 save 时触发
- **GIVEN** 当前 session segment 内 agent 未调用 `memory_save` 任何一次;compact 被触发
- **WHEN** `session_before_compact` hook 跑
- **THEN** 跳过条件:`agentSaveCount == 0` 不满足 → 直接 `return undefined`,compact 继续,不跑抽取

### 场景: safety net 实际跑抽取
- **GIVEN** segment 内 `agentSaveCount == 0`;`session_before_compact` 触发
- **WHEN** hook 进入 safety net 路径
- **THEN** 读最近 `tool_call` log(空);执行 `extractMemoriesWithCallLlm`;产物写入 `~/.pi/agent/memory/inbox/YYYY-MM-DD-<session>-<n>.md`(不进 atoms 主库);`ctx.ui.notify("memory: <N> candidates → inbox")`;compact 继续

## 异常流程

### 场景: agent 提供 id 但 DB 不存在
- **GIVEN** agent 调 `memory_save({id:"a-ghost", ...})`,DB 无 `a-ghost`
- **WHEN** tool 执行
- **THEN** 返回 `{ok:false, error:"id_not_found", id:"a-ghost"}`,不写入任何文件或 DB 行;agent 收到 error,可选择去掉 id 重试(走 create 路径)

### 场景: embedding 服务不可达 (15s 超时)
- **GIVEN** ollama / bge-m3 服务 down 或 ECONNREFUSED
- **WHEN** tool 调 `embedText(content, {timeoutMs: 15000})`
- **THEN** `embedText` 返回 `null`;tool 跳过 cosine dedup,直接走 `insertAtom` + `writeAtomToFile`;返回 `{ok:true, id:"<new>", action:"created", embedding:"skipped"}`;`memory_vectors` 缺该 atom 行,后续 recall 走 sparse channel 兜底

### 场景: agent 用 `write` 工具直接落盘 atom 文件
- **GIVEN** agent 调 `write({path:"~/.pi/agent/memory/atoms/process/foo.md", content:"..."})`
- **WHEN** `tool_call` hook 命中路径解析
- **THEN** hook 返回 `{block:true, reason:"memory atoms must be written via memory_save tool, not direct file write"}`;`write` 工具不执行;agent 收到 error

### 场景: agent 用 `bash` heredoc 写 atom 文件
- **GIVEN** agent 调 `bash({command:"cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF\n...\nEOF"})`
- **WHEN** `tool_call` hook 解析命令,匹配 `>` / `>>` / `tee ` + 命中 `atoms/**` 路径
- **THEN** hook 返回 block error,bash 不执行

### 场景: agent `read` 已有 atom 文件 (合法路径)
- **GIVEN** agent 调 `read({path:"~/.pi/agent/memory/atoms/process/a-123.md"})`
- **WHEN** hook 检查是读操作 (无 `>` / `>>` / `tee`)
- **THEN** hook 不拦截,read 正常返回 atom 内容

### 场景: writer 自洽 (写自己的 .md 文件不触发 hook)
- **GIVEN** `memory_save` tool 内部调 `writeAtomToFile` → `fs.writeFile(<atoms path>)`
- **WHEN** 这一调用是 module-level 函数,非 agent tool_call
- **THEN** tool_call hook 不触发(fs.writeFile 是 Node API,不经 tool_call);writer 不被自阻断

### 场景: safety net 抽取失败
- **GIVEN** `personalAssistant.memory.extraction.{provider,model}` 未配置 / auth 失败 / LLM 调用报错
- **WHEN** safety net 跑抽取
- **THEN** catch 内吞 error,`ctx.ui.notify("memory: safety net skipped, <reason>")`,return `undefined`,compact 继续

### 场景: 抽取 LLM 返回 0 candidates
- **GIVEN** safety net 跑抽取,LLM 返回 `items: []`
- **WHEN** `executePlan` 处理空列表
- **THEN** 写入 `~/.pi/agent/memory/inbox/empty-<ts>.md`(空文件作为"已检查"标记)或直接 return;inbox 不堆积垃圾

## 边界条件

### 场景: importance 边界值 0 与 10
- **GIVEN** agent 调 `memory_save({importance:0, ...})` 或 `importance:10, ...`
- **WHEN** tool schema 校验
- **THEN** 通过(MemoryAtom.importance 是 number 类型,无 schema 上下界约束);atom 落库,importance 字段原样存;decay 计算时 importance=0 的 atom 自然衰减最快

### 场景: title 长度 200 边界
- **GIVEN** `writeAtomToFile.isSafeFilename` 限制 id 长度 ≤ 200;title 无硬限制
- **WHEN** title 极长
- **THEN** 写入成功,但 frontmatter `title: "..."` 行可能过长;若 DB schema 对 title 有长度限制则截断(由 `atomToRow` 决定)

### 场景: content 空字符串
- **GIVEN** agent 调 `memory_save({content:"", ...})`
- **WHEN** tool 校验
- **THEN** schema 拒绝(MemoryAtom.content 语义上必填非空);返回 `{ok:false, error:"content_required"}`

### 场景: tags 数组为空 vs 字段缺失
- **GIVEN** agent 调 `memory_save({tags:[], ...})` vs `memory_save({...})`(无 tags)
- **WHEN** tool 处理
- **THEN** 两种等价:落库时 `tags = []`,`normalizeTags` 后仍 `[]`;embeddable text 不含 tags 段

### 场景: type 不在白名单
- **GIVEN** agent 调 `memory_save({type:"opinion", ...})`
- **WHEN** schema 校验
- **THEN** 拒绝,返回 `{ok:false, error:"invalid_type", allowed:["rule","fact","process"]}`

### 场景: safety net 触发条件 = 1
- **GIVEN** segment 内 agent 调过 1 次 `memory_save`(即使该 save 被 conflict 拒)
- **WHEN** `session_before_compact` 触发
- **THEN** `agentSaveCount >= 1` → safety net 跳过;说明:count 计入"调用",不计入"成功"

### 场景: agent 调 save 后立刻在同一 turn 被 recall 命中
- **GIVEN** agent save 新 atom;同一 turn 内 system prompt 重新构建,recall path 跑
- **WHEN** recall 查 `memory_vectors`
- **THEN** 若 embedding 成功 → 命中新 atom;若 embedding 失败 → sparse channel 可能命中(取决于 BM25 是否已索引);不命中是合法行为(graceful degradation)

### 场景: safety net 产物 inbox 文件堆积
- **GIVEN** safety net 跑过 N 次,每次写一个 inbox 文件
- **WHEN** 后台无清扫
- **THEN** inbox 目录文件数线性增长;**本变更不在 scope 内解决**(后续独立 change 可加 cron 清理);inbox 不参与 recall,不影响主路径

### 场景: tool_call hook 高频调用性能
- **GIVEN** agent 每 turn 调 5-10 个 tool,每个 tool_call 走 hook
- **WHEN** hook 检查路径
- **THEN** 单次 hook 路径 resolve + 正则匹配 < 1ms;非 memory 路径快速返回 undefined,无显著开销