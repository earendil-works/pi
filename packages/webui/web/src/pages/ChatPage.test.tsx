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

      expect(mocks.ws.send).not.toHaveBeenCalled();
      expect(textarea.value).toBe("with newline");
    });
  });
});
