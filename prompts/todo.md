---
description: 查看和管理待办事项
argument-hint: "[add|list|done]"
---

使用 todo_write 工具管理待办事项：
- 查看所有待办：todo_write({todos: [{action: "list"}]})
- 添加待办：todo_write({todos: [{action: "add", content: "...", priority: "high|medium|low"}]})
- 完成待办：todo_write({todos: [{action: "done", id: "..."}]})
