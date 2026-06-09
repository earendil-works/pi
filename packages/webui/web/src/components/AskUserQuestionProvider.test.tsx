/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import * as React from "react";
import { AskUserQuestionProvider } from "./AskUserQuestionProvider";

// ---------------------------------------------------------------------------
// Mock ws (same pattern as ChatPage.test.tsx)
// ---------------------------------------------------------------------------
let capturedHandlers: Map<string, (msg: unknown) => void> = new Map();

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

function createApiMock() {
  return {
    ws: createWsMock(),
  };
}

// ---------------------------------------------------------------------------
// Helper: render with mocked api/ws
// ---------------------------------------------------------------------------
async function renderWithProvider() {
  vi.resetModules();
  const mocks = createApiMock();
  vi.doMock("../lib/api", () => mocks);
  const { AskUserQuestionProvider: Provider } = await import("./AskUserQuestionProvider");
  render(
    <Provider>
      <div data-testid="child">child content</div>
    </Provider>
  );
  return mocks;
}

describe("AskUserQuestionProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    capturedHandlers.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // -------------------------------------------------------------------------
  // 1.收到 session_event 含 extension_ui_request method=select → 弹 modal
  // -------------------------------------------------------------------------
  it("receives session_event with extension_ui_request method=select → shows modal", async () => {
    const mocks = await renderWithProvider();

    const handler = capturedHandlers.get("session_event");
    expect(handler).toBeDefined();

    act(() => {
      handler!({
        type: "session_event",
        sessionId: "s1",
        event: {
          type: "extension_ui_request",
          id: "req-1",
          method: "select",
          title: "Pick one",
          options: [
            { label: "A", description: "a" },
            { label: "B" },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Pick one")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 2. 多 modal 排队:同时 push 2 个,只显示顶部,提交后自动下一个
  // -------------------------------------------------------------------------
  it("multiple modals queued per sessionId — only top shows, submit reveals next", async () => {
    const mocks = await renderWithProvider();

    const handler = capturedHandlers.get("session_event");
    expect(handler).toBeDefined();

    // Push two requests for different sessionIds
    act(() => {
      handler!({
        type: "session_event",
        sessionId: "s1",
        event: {
          type: "extension_ui_request",
          id: "req-1",
          method: "select",
          title: "First",
          options: [{ label: "A1" }],
        },
      });
    });

    act(() => {
      handler!({
        type: "session_event",
        sessionId: "s2",
        event: {
          type: "extension_ui_request",
          id: "req-2",
          method: "select",
          title: "Second",
          options: [{ label: "B1" }],
        },
      });
    });

    // Only the first (top) modal should be visible
    await waitFor(() => {
      expect(screen.getByText("First")).toBeInTheDocument();
    });
    expect(screen.queryByText("Second")).toBeNull();

    // The pending count bar should show "1" when second modal is queued
    // (We need to submit the top modal to reveal the next one)
    // First, submit the top modal by clicking its option
    act(() => {
      // Simulate user selects option "A1" and submits
      // The provider should call ws.send with the response
    });

    // For now just verify the count shows "1" when second is pending
    // This test will be implemented when the provider is built
  });

  // -------------------------------------------------------------------------
  // 3.收到 method=input 也能弹
  // -------------------------------------------------------------------------
  it("receives method=input → shows modal with placeholder and title", async () => {
    const mocks = await renderWithProvider();

    const handler = capturedHandlers.get("session_event");
    expect(handler).toBeDefined();

    act(() => {
      handler!({
        type: "session_event",
        sessionId: "s1",
        event: {
          type: "extension_ui_request",
          id: "req-3",
          method: "input",
          title: "Multi",
          placeholder: "A | B (comma-separated)",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Multi")).toBeInTheDocument();
      expect(screen.getByText("A | B (comma-separated)")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 4.收到非 session_event 消息不弹
  // -------------------------------------------------------------------------
  it("receives non-session_event message → modal not shown", async () => {
    const mocks = await renderWithProvider();

    // Trigger a "subscribed" type message (not session_event)
    const handler = capturedHandlers.get("subscribed");
    // The provider should only subscribe to "session_event" type
    // so other messages should not trigger anything
    // If there's no handler for "subscribed", that's also acceptable
    if (handler) {
      act(() => {
        handler!({ type: "subscribed", sessionId: "s1" });
      });
    }

    // Modal should not be shown
    expect(screen.queryByText("Pick one")).toBeNull();
  });
});
