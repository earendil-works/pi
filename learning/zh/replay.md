# 离线复现第一章

下面是本次运行的完整实验。它借用仓库的 suite 装配，临时目录、模型注册和会话均由它清理。第一次 provider 回调定义模型的调用选择，第二次只能从收到的结果计算答案。真实读文件发生在两个回调之间。

在已按仓库要求安装依赖、补齐模型目录的工作区，从仓库根目录运行以下命令。命令从本页提取唯一一段 TypeScript 到 suite 下的临时文件，并在退出时清理。

```sh
(
  cd packages/coding-agent || exit 1
  demo=$(mktemp test/suite/learning-trace-XXXXXXXX) || exit 1
  mv "$demo" "$demo.test.ts" || exit 1
  trap 'rm -f "$demo.test.ts"' EXIT
  awk '/^```typescript$/{p=1;next} p && /^```$/{exit} p' ../../learning/zh/replay.md > "$demo.test.ts"
  node ../../node_modules/vitest/dist/cli.js --run "$demo.test.ts" --silent=false
)
```

首次准备可用 `npm ci --ignore-scripts` 安装依赖；模型数据按仓库 `nix/package.nix` 的固定目录版本获取并用 `packages/ai/scripts/hydrate-model-catalog.ts` 展开。测试使用源码别名，无须真实模型账户。

```typescript
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";

it("compares two real files in one run", async () => {
  const h = await createHarness({ initialActiveToolNames: ["read"] });
  try {
    writeFileSync(join(h.tempDir, "A.json"), '{"timeoutSeconds":30}');
    writeFileSync(join(h.tempDir, "B.json"), '{"timeoutSeconds":60}');
    const requests: string[][] = [];
    h.setResponses([
      ({ messages }) => {
        requests.push(messages.map(m => m.role));
        expect(getCurrentTools(messages).map(t => t.name)).toEqual(["read"]);
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "A.json" }, { id: "A" }),
          fauxToolCall("read", { path: "B.json" }, { id: "B" }),
        ], { stopReason: "toolUse" });
      },
      ({ messages }) => {
        requests.push(messages.map(m => m.role));
        const results = messages.filter(m => m.role === "toolResult");
        expect(results.map(m => m.toolCallId)).toEqual(["A", "B"]);
        const seconds = results.map(m => JSON.parse(getMessageText(m)).timeoutSeconds);
        return fauxAssistantMessage(`B 比 A 多 ${seconds[1] - seconds[0]} 秒。`);
      },
    ]);
    await h.session.prompt("比较 A.json 和 B.json 的超时值");
    console.log(requests, getMessageText(h.session.messages.at(-1)));
    expect(requests).toEqual([["system", "user"], ["system", "user", "assistant", "toolResult", "toolResult"]]);
    expect(getMessageText(h.session.messages.at(-1))).toBe("B 比 A 多 30 秒。");
  } finally {
    h.cleanup();
  }
});
```

本次实测：1 个用例通过。provider 入口第一次收到 `[system, user]`，第二次收到 `[system, user, assistant, toolResult, toolResult]`。最终消息为「B 比 A 多 30 秒。」

