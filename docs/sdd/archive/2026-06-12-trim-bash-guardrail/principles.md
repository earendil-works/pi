# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- **门控只对有真实替代路径的工具生效**:引导 model 走 sub-tool 时,sub-tool 必须存在且比 bash 提供额外价值(原子 / 截断 / tracking);read/write/edit 满足,list/find/grep 不满足
- **门控建议的 sub-tool 名必须能在客户端解析**:不允许文案写 `tool="list"` 但实际工具叫 `ls`,或 `tool="ls"` 但工具未在 active 集合
- **权限分层由工具集决定,不重复在门控里**:local pi 用 `--tools read,grep,find,ls` 实现 read-only 模式,不在 bash hook 里二次过滤
- **Sub-tool 与 bash 的关系是 optional,不是强制**:sub-tool 存在时 model 可选用,不存在时 model 回退 bash;删除 sub-tool 不应导致 dead end
