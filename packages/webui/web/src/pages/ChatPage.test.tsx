/// <reference types="vitest/globals" />
import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

Element.prototype.scrollIntoView = vi.fn();

let capturedHandlers: Map<string, (msg: unknown) => void> = new Map();

function clearCapturedHandlers() {
  capturedHandlers.clear();
}

function createWsMock() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
      capturedHandlers.set(type, handler);
      return () => capturedHandlers.delete(type);
    }),
  };
}

function createApiMock(opts: {
  messages?: unknown[];
  models?: { providers: Array<{ name: string; models: Array<{ id: string; name: string }> }> };
  settings?: Record<string, unknown>;
} = {}) {
  return {
    api: {
      getMessages: vi.fn().mockResolvedValue(opts.messages ?? []),
      getSettings: vi.fn().mockResolvedValue(opts.settings ?? {}),
      getModels: vi.fn().mockResolvedValue(opts.models ?? { providers: [] }),
      setDefaultModel: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockResolvedValue({ id: "new-id" }),
      deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
    },
    ws: createWsMock(),
  };
}

async function renderChatPage(
  sessionId: string,
  apiOpts: Parameters<typeof createApiMock>[0] = {}
) {
  vi.resetModules();
  const mocks = createApiMock(apiOpts);
  vi.doMock("../lib/api", () => mocks);
  const { default: ChatPage } = await import("../pages/ChatPage");
  render(
    <MemoryRouter initialEntries={[`/session/${sessionId}`]}>
      <Routes>
        <Route path="/session/:id" element={<ChatPage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
  return mocks;
}

function lastWsSend(mock: ReturnType<typeof createWsMock>, type: string): any | undefined {
  for (let i = mock.send.mock.calls.length - 1; i >= 0; i--) {
    const call = mock.send.mock.calls[i];
    if (call && call[0] && (call[0] as any).type === type) return call[0];
  }
  return undefined;
}

describe("ChatPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCapturedHandlers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("WebSocket event filtering", () => {
    it("ignores session_event with wrong sessionId", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();
      act(() => {
        handler!({ sessionId: "wrong-id", event: { type: "message_end" } });
      });

      expect(screen.queryAllByRole("article")).toHaveLength(0);
    });

    it("processes session_event for matching sessionId", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello back!" }],
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Hello back!")).toBeInTheDocument();
      });
    });

    // Regression: if message_update arrives as the FIRST event of a turn
    // (no prior message_start, and pi RPC doesn't include message.id),
    // the event was dropped because both e.message.id and streamingMsgId.current
    // were null. The assistant's first streaming reply was invisible until
    // the next polling cycle or manual refresh.
    it("renders message_update when it arrives before message_start (no message.id)", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Simulate message_update as the FIRST event of the turn:
      // no prior message_start, no message.id on the event
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Streaming reply..." }],
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Streaming reply...")).toBeInTheDocument();
      });

      // Subsequent message_end for the same turn must hit the SAME bubble
      // (via streamingMsgId.current), not create a duplicate. The text
      // "Streaming reply..." was rendered by the first message_update; if
      // a duplicate bubble were created, the same text would appear twice.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Streaming reply..." }],
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("Streaming reply...")).toHaveLength(1);
      });
    });
  });

  describe("WebSocket subscription", () => {
    it("sends subscribe message with sessionId on WS open", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Find the open handler and trigger it to simulate WS connection
      const openHandler = capturedHandlers.get("open");
      expect(openHandler).toBeDefined();
      act(() => {
        openHandler!({ type: "open" });
      });

      await waitFor(() => {
        expect(mocks.ws.send).toHaveBeenCalledWith({
          type: "subscribe",
          sessionId: "test-session-1",
        });
      });
    });
  });

  describe("InputArea integration", () => {
    it("typing text updates textarea value", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello world" } });

      expect(textarea.value).toBe("hello world");
    });

    it("Enter key submits via ws.send with correct payload", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "test prompt" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      await waitFor(() => {
        expect(mocks.ws.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "prompt",
            text: "test prompt",
            sessionId: "test-session-1",
          })
        );
      });
    });

    it("Shift+Enter does not submit but preserves text", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "with newline" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // The page sends a `subscribe` on mount; the assertion is about
      // user-driven input, so check that no `prompt` was sent.
      expect(mocks.ws.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "prompt" })
      );
      expect(textarea.value).toBe("with newline");
    });
  });

  describe("Stop button (abort) integration", () => {
    function triggerStatus(running: boolean) {
      const handler = capturedHandlers.get("session_event");
      if (!handler) throw new Error("session_event handler not captured");
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: { type: "session_status_changed", status: running ? "running" : "idle" },
        });
      });
    }

    it("shows Send button (not Stop) when the session is idle", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    });

    it("swaps to Stop button when the session goes running", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      triggerStatus(true);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
      });
    });

    it("clicking Stop sends {type:'abort'} over the WebSocket", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      triggerStatus(true);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole("button", { name: /stop/i }));

      await waitFor(() => {
        expect(mocks.ws.send).toHaveBeenCalledWith({ type: "abort" });
      });
    });

    it("swaps back to Send when the session goes idle", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      triggerStatus(true);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
      });

      triggerStatus(false);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
      });
    });

    // Regression for the "Stop disappears once the model starts calling
    // tools" bug. message_update fires for toolCall parts the same as
    // text parts, and the old code flipped isThinking to false on the
    // first message_update — so the moment the model emitted its first
    // tool call, the Stop button vanished even though the agent was
    // still busy executing the tool. The fix drives the button from
    // sessionStatus, which only flips to "idle" on agent_end (after
    // all tool results have come back and the turn is fully done).
    it("Stop button stays visible after a tool-call message_update arrives (session still running)", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      triggerStatus(true);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
      });

      // Model emits a tool call (no text yet). message_update fires,
      // but the session is still "running" — Stop must stay put.
      const handler = capturedHandlers.get("session_event")!;
      act(() => {
        handler({
          sessionId: "test-session-1",
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "tc-1", name: "bash", args: { command: "ls" } },
              ],
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
      });
    });
  });

  describe("Card integration: extension_ui_request + tool_execution_end", () => {
    it("receives extension_ui_request and renders card in assistant message bubble", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Simulate the server sending extension_ui_request through the
      // session_event channel. After 3.2+3.3, ChatPage's handler will
      // create a card and render it in an assistant message bubble.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "abc",
            method: "select",
            question: "Your favorite color?",
            options: [{ label: "红色" }, { label: "蓝色" }],
            multiSelect: false,
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Your favorite color?")).toBeInTheDocument();
      });
    });

    it("receives tool_execution_end with ask_user_question disables the card", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Step 1: extension_ui_request arrives — card should appear
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "abc",
            method: "select",
            question: "Your favorite color?",
            options: [{ label: "红色" }, { label: "蓝色" }],
            multiSelect: false,
          },
        });
      });

      // Step 2: tool_execution_end with ask_user_question tool —
      // the matching card should be disabled and show the user's selection.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "tool_execution_end",
            toolCallId: "tc-1",
            toolName: "ask_user_question",
            result: "User selected: 红色",
            isError: false,
          },
        });
      });

      // The card should now be disabled and show the result text.
      // This fails (RED) until 3.2+3.3 implement the handlers.
      await waitFor(() => {
        expect(screen.getByText(/你的选择:\s*红色/)).toBeInTheDocument();
      });
    });

    // Regression: the real pi agent runtime returns the tool's return value
    // as the `result` field of `tool_execution_end`. ask_user_question returns
    // `{content: [{type:"text", text:"..."}], details: {...}}` — NOT a string.
    // The previous code did `e.result.includes(...)` directly, which threw
    // `TypeError: content.includes is not a function` and unmounted the whole
    // ChatPage (visible as the page going blank right after submit). The
    // page was effectively unrendered until a manual reload, which the user
    // perceived as "the page refreshes itself after click submit".
    it("tool_execution_end with object-shape result (real protocol) does not crash the page", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Step 1: real-protocol extension_ui_request (UUID id, no options in
      // event payload for method="input"). The card should render.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              id: "m-1", role: "assistant",
              content: [{
                type: "toolCall", id: "tc-real", name: "ask_user_question",
                arguments: {
                  question: "Fruits?",
                  options: ["Apple", "Banana", "Cherry"],
                  multiSelect: true,
                },
              }],
            },
          },
        });
      });
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "uuid-real",
            method: "input",
            title: "Fruits?",
            placeholder: "Apple | Banana | Cherry (comma-separated)",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Fruits?")).toBeInTheDocument();
      });

      // Step 2: real-protocol tool_execution_end with result as the
      // canonical `{content: [{type:"text", text:"..."}], details: ...}`
      // object. The OLD code crashed with
      // "content.includes is not a function" here.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "tool_execution_end",
            toolCallId: "tc-real",
            toolName: "ask_user_question",
            result: {
              content: [{ type: "text", text: "User selected: Apple, Cherry (multi-select)" }],
              details: { selected: ["Apple", "Cherry"], multiSelect: true },
            },
            isError: false,
          },
        });
      });

      // The page must still be rendered (the bug unmounted the whole ChatPage).
      // The card must show the result text — extracted from result.content[0].text.
      await waitFor(() => {
        expect(screen.getByText(/你的选择:.*Apple, Cherry/)).toBeInTheDocument();
      });
      // Sanity: the input box is gone (card is now disabled, not interactive).
      expect(screen.queryByPlaceholderText("输入选项编号,逗号分隔")).toBeNull();
    });

    it("receives tool_execution_end with different toolName keeps card active", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Step 1: extension_ui_request arrives — card should appear
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "abc",
            method: "select",
            question: "Your favorite color?",
            options: [{ label: "红色" }, { label: "蓝色" }],
            multiSelect: false,
          },
        });
      });

      // Verify card appears first (this assertion fails RED until 3.2+3.3,
      // preventing a false-positive pass where both handlers are missing).
      await waitFor(() => {
        expect(screen.getByText("Your favorite color?")).toBeInTheDocument();
      });

      // Step 2: tool_execution_end with a DIFFERENT toolName (bash) —
      // the card should stay active because only ask_user_question
      // triggers card state changes.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "tool_execution_end",
            toolCallId: "tc-2",
            toolName: "bash",
            result: { exitCode: 0, stdout: "done" },
            isError: false,
          },
        });
      });

      // Card must remain active — no disabled-state text visible.
      expect(screen.queryByText(/你的选择:/)).toBeNull();
    });

    // Regression: clicking a single-select option used to call
    //   ws.send(JSON.stringify({ type: "extension_ui_response", id, value }))
    // but WebSocketClient.send() also stringifies its argument, producing
    // a JSON-encoded string on the wire. The server's switch on msg.type
    // found undefined, dropped the message, and pi's ctx.ui.select() never
    // resolved — model blocked, user stuck.
    it("clicking a single-select option sends a plain object to ws.send (not a pre-stringified string)", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "tc-1",
            method: "select",
            question: "你最喜欢哪种水果?",
            options: [{ label: "苹果" }, { label: "香蕉" }],
            multiSelect: false,
          },
        });
      });

      // Wait for the card to render with clickable options
      await waitFor(() => {
        expect(screen.getByText("你最喜欢哪种水果?")).toBeInTheDocument();
      });

      const sendSpy = mocks.ws.send as ReturnType<typeof vi.fn>;
      sendSpy.mockClear();

      // Click the first option
      const optionButton = screen.getByRole("button", { name: /苹果/ });
      fireEvent.click(optionButton);

      // Verify ws.send received a plain object (NOT a pre-stringified string)
      expect(sendSpy).toHaveBeenCalled();
      const sentArg = sendSpy.mock.calls[0][0];
      // If pre-stringified, sentArg is a string. If correct, it's a plain object.
      expect(typeof sentArg).toBe("object");
      expect(sentArg).not.toBe(null);
      expect(sentArg.type).toBe("extension_ui_response");
      expect(sentArg.id).toBe("tc-1");
      expect(sentArg.value).toBe("苹果");
    });

    // Regression: real pi server flow for multi-select sends a toolCall
    // (with options + multiSelect=true in args) followed by an
    // extension_ui_request with method="input" — that event has NO
    // `options` field. The card must source options + multiSelect from
    // the tool call args, not the event.
    it("multi-select: sources options + multiSelect from toolCall args (input method has no options)", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Step 1: message_end with the toolCall part carrying options +
      // multiSelect=true in args. This is what arrives BEFORE
      // extension_ui_request in the real server flow.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              id: "m-1",
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tc-multi",
                  name: "ask_user_question",
                  arguments: {
                    question: "周末想做啥?",
                    options: [
                      { label: "打游戏" },
                      { label: "看电影" },
                      { label: "运动" },
                      { label: "看书" },
                    ],
                    multiSelect: true,
                  },
                },
              ],
            },
          },
        });
      });

      // Step 2: extension_ui_request for the same toolCall id with
      // method="input" — no `options` field, only title + placeholder.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "tc-multi",
            method: "input",
            title: "周末想做啥?",
            placeholder: "打游戏 | 看电影 | 运动 | 看书 (comma-separated)",
            timeout: 300000,
          },
        });
      });

      // Card must render with the 4 options from the toolCall args,
      // numbered 1-4 (multi-select mode).
      await waitFor(() => {
        expect(screen.getByText("周末想做啥?")).toBeInTheDocument();
      });
      expect(screen.getByText(/1\..*打游戏/)).toBeInTheDocument();
      expect(screen.getByText(/2\..*看电影/)).toBeInTheDocument();
      expect(screen.getByText(/3\..*运动/)).toBeInTheDocument();
      expect(screen.getByText(/4\..*看书/)).toBeInTheDocument();

      // The input box for multi-select must be present
      const input = screen.getByPlaceholderText("输入选项编号,逗号分隔");
      expect(input).toBeInTheDocument();
    });

    // Regression: a multi-turn conversation can have multiple ask_user_question
    // cards in different states. Each card must be tracked by its own
    // toolCallId in cardStates — one card's lifecycle must not affect another's.
    it("multiple consecutive ask_user_question cards each get their own state", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Turn 1: toolCall + extension_ui_request (single-select).
      // Note: extension_ui_request uses a random UUID, NOT the toolCall id.
      // The webui matches by recency (most recent unmatched ask_user_question
      // toolCall), since the rpc-mode generates a fresh UUID for the dialog
      // (packages/coding-agent/src/modes/rpc/rpc-mode.ts:98, 254).
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              id: "m-1", role: "assistant",
              content: [{
                type: "toolCall", id: "tc-1", name: "ask_user_question",
                arguments: { question: "Q1?", options: [{ label: "A" }, { label: "B" }] },
              }],
            },
          },
        });
      });
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request", id: "uuid-1", method: "select",
            title: "Q1?", options: ["A", "B"],
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Q1?")).toBeInTheDocument();
      });

      // Turn 2: another toolCall + extension_ui_request (multi-select)
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              id: "m-2", role: "assistant",
              content: [{
                type: "toolCall", id: "tc-2", name: "ask_user_question",
                arguments: { question: "Q2?", options: [{ label: "X" }, { label: "Y" }, { label: "Z" }], multiSelect: true },
              }],
            },
          },
        });
      });
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request", id: "uuid-2", method: "input",
            title: "Q2?", placeholder: "X | Y | Z",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Q2?")).toBeInTheDocument();
      });

      // Both cards visible at once
      expect(screen.getByText("Q1?")).toBeInTheDocument();
      expect(screen.getByText("Q2?")).toBeInTheDocument();
      // Multi-select card has its input box
      expect(screen.getByPlaceholderText("输入选项编号,逗号分隔")).toBeInTheDocument();

      // Turn 1 disabled: tool_execution_end for tc-1
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "tool_execution_end", toolCallId: "tc-1",
            toolName: "ask_user_question", result: "User selected: A",
            isError: false,
          },
        });
      });

      // Q1 shows "你的选择: A" result text
      await waitFor(() => {
        expect(screen.getByText(/你的选择:.*A/)).toBeInTheDocument();
      });
      // Q2 still active (no result text)
      expect(screen.queryByText(/你的选择:.*Y/)).toBeNull();
    });

    // Regression: pi rpc-mode generates a fresh `crypto.randomUUID()` for
    // `extension_ui_request.id` (rpc-mode.ts:98, 254). The toolCall in the
    // message content has its own id (e.g. `call_00_...`). The webui's
    // match-by-id code (pre-fix) tried to find a toolCall whose id === e.id,
    // which never matches in the real protocol — so the multi-select card
    // (method="input" has no options in the event payload) failed to render
    // and the model hung waiting for a user response that could never be
    // submitted. The fix: match by recency, picking the most recent
    // ask_user_question toolCall in any assistant message.
    it("multi-select card renders when extension_ui_request id is a UUID unrelated to toolCall id", async () => {
      const mocks = await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Real toolCall message arrives first (matches the production flow).
      // The toolCall id is a `call_00_...` style; the extension_ui_request
      // id is a fresh UUID with no relationship to the toolCall id.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "message_end",
            message: {
              id: "m-1", role: "assistant",
              content: [{
                type: "toolCall", id: "call_00_real_id", name: "ask_user_question",
                arguments: {
                  question: "Pick fruits",
                  options: ["Apple", "Banana", "Cherry"],
                  multiSelect: true,
                },
              }],
            },
          },
        });
      });
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "a-completely-different-uuid",
            method: "input",
            title: "Pick fruits",
            placeholder: "Apple | Banana | Cherry (comma-separated)",
          },
        });
      });

      // The card must render (pre-fix this hung because the id-based lookup
      // couldn't find the toolCall).
      await waitFor(() => {
        expect(screen.getByText("Pick fruits")).toBeInTheDocument();
      });
      // Multi-select input box + submit button must be present.
      const input = screen.getByPlaceholderText("输入选项编号,逗号分隔");
      expect(input).toBeInTheDocument();
      const submit = screen.getByRole("button", { name: "提交" });
      expect(submit).toBeInTheDocument();

      // User types "1, 3" and submits. The submit handler must echo back
      // to the request id (the UUID), not the toolCall id — that's what
      // the server's pendingExtensionRequests map is keyed by.
      fireEvent.change(input, { target: { value: "1, 3" } });
      fireEvent.click(submit);

      // The captured ws.send should have been called with
      //   { type: "extension_ui_response", id: <UUID>, value: "Apple, Cherry" }
      const responseCall = lastWsSend(mocks.ws, "extension_ui_response");
      expect(responseCall).toBeDefined();
      expect(responseCall.id).toBe("a-completely-different-uuid");
      expect(responseCall.value).toBe("Apple, Cherry");
    });

    // Regression: the server emits many extension_ui_request events for
    // methods other than select/input (setTitle, setStatus, set_editor_text,
    // setWidget, notify). These should be ignored — the card logic must
    // only fire for select/input. Otherwise each fire-and-forget event
    // creates a phantom synthetic ask_user_question toolCall in state.
    it("ignores extension_ui_request with method other than select/input (no synthetic message)", async () => {
      await renderChatPage("test-session-1");
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();

      // Emit 4 fire-and-forget events that must all be ignored
      for (const ev of [
        { type: "extension_ui_request", id: "st-1", method: "setTitle", title: "X" },
        { type: "extension_ui_request", id: "st-2", method: "setStatus", statusKey: "k", statusText: "t" },
        { type: "extension_ui_request", id: "st-3", method: "set_editor_text", text: "x" },
        { type: "extension_ui_request", id: "st-4", method: "notify", message: "y" },
      ]) {
        act(() => {
          handler!({ sessionId: "test-session-1", event: ev });
        });
      }

      // No "ask_user_question" tool call button should appear in the UI
      // from any of these events.
      expect(screen.queryByRole("button", { name: /ask_user_question/ })).toBeNull();

      // Now emit a real select event — the card should appear normally.
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: {
            type: "extension_ui_request",
            id: "tc-real",
            method: "select",
            title: "Q?",
            options: ["A", "B"],
          },
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Q?")).toBeInTheDocument();
      });
    });
  });

  describe("message_start with stale empty assistant bubbles", () => {
    // Regression: a session that's been around for a while accumulates
    // empty assistant bubbles from past aborted turns (rate-limit errors,
    // user-cancelled, etc). When the user sends a new message and the
    // first message_start event fires, the previous implementation
    // reused the FIRST empty bubble it found via findIndex — typically
    // hundreds of messages old. The new assistant got placed at the
    // empty bubble's old position in the list, BEFORE the user message
    // that triggered it. groupTurns then concatenated it with the
    // surrounding old messages, and the user saw the new reply buried
    // inside a giant garbled bubble in the middle of the conversation,
    // with nothing visible below their own message.
    it("appends a fresh assistant bubble even when old empty assistant bubbles are in state", async () => {
      // Initial fetch includes an old empty assistant bubble (from a
      // past aborted turn) sandwiched between two user messages.
      await renderChatPage("test-session-1", {
        messages: [
          { id: "u-old", sessionId: "test-session-1", role: "user", parts: [{ type: "text", text: "old prompt" }], timestamp: "2026-01-01T00:00:00.000Z" },
          { id: "a-stale", sessionId: "test-session-1", role: "assistant", parts: [], timestamp: "2026-01-01T00:00:01.000Z" },
          { id: "u-old2", sessionId: "test-session-1", role: "user", parts: [{ type: "text", text: "another old prompt" }], timestamp: "2026-01-01T00:00:02.000Z" },
        ],
      });
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // User sends a new prompt. handleSubmit adds the optimistic
      // user message at the end of state. Then the server's
      // message_start fires before any new content arrives.
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "new prompt" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      // Optimistic user message appears.
      await waitFor(() => {
        expect(screen.getByText("new prompt")).toBeInTheDocument();
      });

      // Fire message_start for the new assistant turn. With the
      // pre-fix code, the new assistant bubble would be grafted into
      // the stale empty's slot, so the DOM would render it in the
      // middle of the chat, FAR above the optimistic user message
      // ("new prompt"). With the fix, the new assistant bubble is
      // appended at the end of state, so the DOM renders it right
      // after the optimistic user bubble.
      const handler = capturedHandlers.get("session_event")!;
      act(() => {
        handler({
          sessionId: "test-session-1",
          event: {
            type: "message_start",
            message: { role: "assistant", content: [{ type: "text", text: "fresh hello" }] },
          },
        });
      });

      // The new assistant text "fresh hello" is rendered.
      await waitFor(() => {
        expect(screen.getByText("fresh hello")).toBeInTheDocument();
      });

      // Inspect the DOM order of message bubbles. The new user
      // message and its response must be ADJACENT and in the right
      // order (user, then assistant). If the new assistant got
      // grafted into the stale empty's slot, it would appear
      // somewhere in the middle of the chat, with the new user
      // message stranded at the bottom with no response below it.
      // Wait for the user bubble to actually render (not just be in React state).
      await waitFor(() => {
        const all = Array.from(document.querySelectorAll('*'));
        return all.some(el => (el.textContent || '').includes("new prompt"));
      });
      // The msg container is the ChatMessages component's outer div,
      // a direct child of the .flex-1.overflow-y-auto wrapper. It has
      // the message bubbles as direct children.
      const overflowWrapper = document.querySelector('.flex-1.overflow-y-auto');
      if (!overflowWrapper) throw new Error("overflow wrapper not found");
      const msgContainer = overflowWrapper.children[0] as HTMLElement;
      const bubbles = Array.from(msgContainer.children).map(c => c.textContent?.slice(0, 200) || "");

      // Find the index of the optimistic user bubble and the new
      // assistant bubble.
      const userIdx = bubbles.findIndex(t => t.includes("new prompt"));
      const asstIdx = bubbles.findIndex(t => t.includes("fresh hello"));
      const staleIdx = bubbles.findIndex(t => t.includes("another old prompt") && t.length < 200); // may be empty bubble

      // The new assistant bubble (containing "fresh hello") must be
      // the LAST bubble, and must be immediately after the new user
      // bubble ("new prompt"). Pre-fix: asstIdx would be < userIdx
      // (assistant stuck in the stale empty's slot, user stranded at end).
      expect(userIdx).toBeGreaterThan(-1);
      expect(asstIdx).toBeGreaterThan(-1);
      expect(asstIdx).toBeGreaterThan(userIdx);
      expect(asstIdx).toBe(bubbles.length - 1);
      // Stale empty bubble still in its old position (it was never
      // the right target to reuse, and now it just shows "(empty turn)").
      if (staleIdx >= 0) {
        expect(staleIdx).toBeLessThan(userIdx);
      }
    });
  });

  describe("isLastMessageStreaming propagation", () => {
    // Task 3.1 RED: ChatPage must compute
    //   isLastMessageStreaming = isThinking && lastMessage?.role === "assistant"
    // and pass it as `isStreaming` ONLY to the last assistant message's
    // MessageBubble. Older messages (including older assistant messages)
    // must always get isStreaming=false.
    //
    // Before Task 3.2 lands, ChatPage doesn't compute isLastMessageStreaming
    // at all and passes nothing to ChatMessages → MessageBubble → MessageParts,
    // so EVERY bubble (including the latest assistant) gets
    // data-is-streaming="false" (the default from MessageBubble). The latest
    // assertion below therefore FAILS until 3.2 wires up the propagation.
    it("isLastMessageStreaming only applies to the last message", async () => {
      // Render with 4 messages: [user u1, assistant a-old, user u2, assistant a-latest].
      // The lastMessage is assistant, so isLastMessageStreaming should be true.
      await renderChatPage("test-session-1", {
        messages: [
          { id: "u1", sessionId: "test-session-1", role: "user", parts: [{ type: "text", text: "first prompt" }], timestamp: "2026-01-01T00:00:00.000Z" },
          { id: "a-old", sessionId: "test-session-1", role: "assistant", parts: [{ type: "text", text: "older reply" }], timestamp: "2026-01-01T00:00:01.000Z" },
          { id: "u2", sessionId: "test-session-1", role: "user", parts: [{ type: "text", text: "second prompt" }], timestamp: "2026-01-01T00:00:02.000Z" },
          { id: "a-latest", sessionId: "test-session-1", role: "assistant", parts: [{ type: "thinking", text: "hmm..." }, { type: "text", text: "latest reply" }], timestamp: "2026-01-01T00:00:03.000Z" },
        ],
      });
      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Flip isThinking=true by emitting session_status_changed("running").
      // ChatPage's session_event handler routes this through
      //   setSessionStatus("running"); setIsThinking(true)
      // (see ChatPage.tsx session_status_changed branch).
      const handler = capturedHandlers.get("session_event");
      expect(handler).toBeDefined();
      act(() => {
        handler!({
          sessionId: "test-session-1",
          event: { type: "session_status_changed", status: "running" },
        });
      });

      // DOM order is the ChatMessages groupTurns output: one bubble per
      // message in this fixture (no toolResults to absorb, no two assistant
      // messages adjacent). 4 messages → 4 MessageBubble divs with
      // data-testid="bubble".
      await waitFor(() => {
        expect(document.querySelectorAll('[data-testid="bubble"]').length).toBe(4);
      });

      const bubbles = Array.from(document.querySelectorAll('[data-testid="bubble"]')) as HTMLElement[];
      // bubbles[0] = user u1, bubbles[1] = assistant a-old,
      // bubbles[2] = user u2, bubbles[3] = assistant a-latest.
      const aOld = bubbles[1];
      const aLatest = bubbles[3];
      const u1 = bubbles[0];
      const u2 = bubbles[2];

      // Older assistant bubble: must NOT be streaming, even though
      // isThinking is true. This protects StepHeader in older turns
      // from flashing "● Executing" forever.
      expect(aOld.getAttribute("data-is-streaming")).toBe("false");
      // Latest assistant bubble (the one with thinking): IS streaming.
      // This assertion FAILS RED until Task 3.2 wires up
      //   const isLastMessageStreaming = isThinking && lastMessage?.role === "assistant"
      // and threads the prop through ChatMessages → MessageBubble.
      expect(aLatest.getAttribute("data-is-streaming")).toBe("true");
      // Sanity: user bubbles carry isStreaming=false too.
      expect(u1.getAttribute("data-is-streaming")).toBe("false");
      expect(u2.getAttribute("data-is-streaming")).toBe("false");
    });
  });


});
