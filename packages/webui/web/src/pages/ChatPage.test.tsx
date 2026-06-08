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
});
