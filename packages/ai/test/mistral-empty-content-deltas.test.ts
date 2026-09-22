import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { FetchFunction } from "../src/types.ts";

const model = getModel("mistral", "devstral-medium-latest");
const context = normalizeContext({
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const createFetch = (): FetchFunction => async () =>
  new Response(
    [
      JSON.stringify({
        id: "mistral-response-id",
        model: model.id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                  index: 0,
                },
              ],
              content: "",
            },
          },
        ],
      }),
      JSON.stringify({
        id: "mistral-response-id",
        model: model.id,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: { index: 0, content: "" },
          },
        ],
      }),
      "[DONE]",
    ]
      .map((line) => `data: ${line}`)
      .join("\n\n") + "\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

describe("Mistral empty content deltas", () => {
  it("does not open empty text blocks around tool calls", async () => {
    const message = await streamMistral(model, context, {
      apiKey: "test",
      fetch: createFetch(),
    }).result();

    expect(message.stopReason).toBe("toolUse");
    expect(
      message.content.filter((block) => block.type === "text"),
    ).toHaveLength(0);
    expect(
      message.content.filter((block) => block.type === "toolCall"),
    ).toHaveLength(1);
  });
});
