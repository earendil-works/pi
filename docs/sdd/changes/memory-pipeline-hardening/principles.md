# 本变更原则

- 写入路径优先走"已有 supersede 机制",webui PATCH 不绕过 extraction 的 cosine 去重门。
- 客户端乐观更新必须带 `If-Match` 版本号,服务端用 409 终止冲突而非无声覆盖。
- 单 atom 状态推送优先走 SSE(零冗余),仅在 SSE 不可用时回退轮询。
- tag 写入是归一化操作(merge alias + 去重),不是字符串透传。
- 检索打分公式扩展维度时,既有 `cosine × (1 + 0.3s + 0.2i)` 主项保持向后兼容。