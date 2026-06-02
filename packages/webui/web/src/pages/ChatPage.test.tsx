/// <reference types="vitest/globals" />
import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

// Store captured subscribe handlers per test
let capturedHandlers: Map<string, (msg: unknown) => void> = new Map();

function getCapturedHandlers() {
  return capturedHandlers;
}

function clearCapturedHandlers() {
  capturedHandlers.clear();
}

// Spy on console.error
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

describe("ChatPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCapturedHandlers();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("user submit behavior", () => {
    it("handles user submit by adding user message and clearing input", async () => {
      // Set up mocks before importing the component
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Find textarea and type
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello" } });

      // Submit
      const form = textarea.closest("form")!;
      fireEvent.submit(form);

      // Verify user message was added
      await waitFor(() => {
        expect(screen.getByText("hello")).toBeInTheDocument();
      });

      // Verify input was cleared
      expect(textarea.value).toBe("");

      // Verify ws.send was called with prompt
      const { ws } = await import("../lib/api");
      expect(vi.mocked(ws.send)).toHaveBeenCalledWith({
        type: "prompt",
        text: "hello",
        sessionId: "test-session-1",
      });
    });

    it("does NOT put user text in streaming content after submit (bug fix verification)", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello" } });

      // Submit
      const form = textarea.closest("form")!;
      fireEvent.submit(form);

      // Wait for state updates
      await act(async () => {});

      // After fix: streamingContent should be empty, so no streaming bubble (which shows "streaming...")
      const streamingIndicator = screen.queryByText("streaming...");
      expect(streamingIndicator).toBeNull();

      // User message should appear in its own bubble (not as streaming content)
      const userMessages = screen.getAllByText("hello");
      expect(userMessages.length).toBe(1);
    });
  });

  describe("WebSocket event handling", () => {
    it("renders assistant response from message_end event", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Simulate user submitting a message first
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello" } });
      const form = textarea.closest("form")!;
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText("hello")).toBeInTheDocument();
      });

      // Now simulate message_end event with assistant response
      const sessionEventHandler = getCapturedHandlers().get("session_event");
      expect(sessionEventHandler).toBeDefined();

      const assistantMessage = {
        type: "session_event",
        sessionId: "test-session-1",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Boss, hello there, dear friend." }],
            timestamp: new Date().toISOString(),
          },
        },
      };

      act(() => {
        sessionEventHandler!(assistantMessage);
      });

      // Verify assistant message appears
      await waitFor(() => {
        expect(screen.getByText("Boss, hello there, dear friend.")).toBeInTheDocument();
      });

      // Should have both user and assistant messages
      const allMessages = screen.getAllByText(/hello|Boss, hello there/);
      expect(allMessages.length).toBe(2);
    });

    it("ignores session_event with wrong sessionId", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Get the session_event handler
      const sessionEventHandler = getCapturedHandlers().get("session_event");
      expect(sessionEventHandler).toBeDefined();

      // Send message_end for a DIFFERENT sessionId
      act(() => {
        sessionEventHandler!({
          type: "session_event",
          sessionId: "wrong-session-id",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Should not appear" }],
            },
          },
        });
      });

      // The assistant message should NOT appear
      await act(async () => {});
      const wrongMessage = screen.queryByText("Should not appear");
      expect(wrongMessage).not.toBeInTheDocument();
    });

    it("clears streaming content on agent_end", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Get the session_event handler
      const sessionEventHandler = getCapturedHandlers().get("session_event");
      expect(sessionEventHandler).toBeDefined();

      // Simulate agent_end event
      act(() => {
        sessionEventHandler!({
          type: "session_event",
          sessionId: "test-session-1",
          event: {
            type: "agent_end",
          },
        });
      });

      // streamingContent should be empty (no streaming bubble shown)
      const streamingIndicator = screen.queryByText("streaming...");
      expect(streamingIndicator).toBeNull();
    });
  });

  describe("event subscription verification (tests current buggy behavior)", () => {
    it("subscribes to session_event and open events", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");
      const { ws } = await import("../lib/api");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Verify ws.subscribe was called for session_event
      expect(vi.mocked(ws.subscribe)).toHaveBeenCalledWith(
        "session_event",
        expect.any(Function)
      );

      // Verify ws.subscribe was called for open (connection status)
      expect(vi.mocked(ws.subscribe)).toHaveBeenCalledWith(
        "open",
        expect.any(Function)
      );
    });

    it("should NOT subscribe to stream_end event (current bug - this test SHOULD FAIL until fixed)", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");
      const { ws } = await import("../lib/api");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // After fix: ws.subscribe should NOT be called for stream_end
      const subscribeCalls = vi.mocked(ws.subscribe).mock.calls;
      const streamEndCalls = subscribeCalls.filter((call) => call[0] === "stream_end");
      expect(streamEndCalls.length).toBe(0);
    });

    it("should NOT subscribe to message event (current bug - this test SHOULD FAIL until fixed)", async () => {
      vi.doMock("../lib/api", () => ({
        api: {
          getMessages: vi.fn().mockResolvedValue([]),
          deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
        },
        ws: {
          connect: vi.fn(),
          disconnect: vi.fn(),
          send: vi.fn(),
          subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
            capturedHandlers.set(type, handler);
            return () => capturedHandlers.delete(type);
          }),
        },
      }));

      const { default: ChatPage } = await import("../pages/ChatPage");
      const { ws } = await import("../lib/api");

      render(
        <MemoryRouter initialEntries={["/session/test-session-1"]}>
          <Routes>
            <Route path="/session/:id" element={<ChatPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // After fix: ws.subscribe should NOT be called for message
      const subscribeCalls = vi.mocked(ws.subscribe).mock.calls;
      const messageCalls = subscribeCalls.filter((call) => call[0] === "message");
      expect(messageCalls.length).toBe(0);
    });
  });
});
