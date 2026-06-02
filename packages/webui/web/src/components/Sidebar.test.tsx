/// <reference types="vitest/globals" />
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrowserRouter } from "react-router-dom";
import Sidebar from "./Sidebar";
import type { SessionInfo } from "../lib/api";

// Mock the api module
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual("../lib/api");
  return {
    ...actual,
    api: {
      listSessions: vi.fn(),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
    },
  };
});

const mockApi = await import("../lib/api");

function renderSidebar(props?: Partial<React.ComponentProps<typeof Sidebar>>) {
  const defaultProps = {
    onSelectSession: vi.fn(),
    onNewChat: vi.fn(),
  };

  render(
    <BrowserRouter>
      <Sidebar {...defaultProps} {...props} />
    </BrowserRouter>
  );

  return {
    onSelectSession: props?.onSelectSession ?? defaultProps.onSelectSession,
    onNewChat: props?.onNewChat ?? defaultProps.onNewChat,
  };
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("session list rendering", () => {
    it("should display 'No sessions yet' when sessions list is empty", async () => {
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce([]);

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    });

    it("should render session titles and trigger onSelectSession on click", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "First Chat", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
        { id: "2", title: "Second Chat", status: "running", lastActive: "2025-01-02T00:00:00Z", messageCount: 10 },
      ];
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(sessions);

      const onSelectSession = vi.fn();
      renderSidebar({ onSelectSession });

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("First Chat")).toBeInTheDocument();
      expect(screen.getByText("Second Chat")).toBeInTheDocument();

      fireEvent.click(screen.getByText("First Chat"));
      expect(onSelectSession).toHaveBeenCalledWith("1");
    });

    it("should truncate long session titles to 30 characters", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "This is a very long session title that exceeds thirty characters", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
      ];
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(sessions);

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Title should be truncated to 30 chars with ellipsis
      expect(screen.getByText("This is a very long session ti…")).toBeInTheDocument();
    });

    it("should highlight active session with bg-blue-100", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "First Chat", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
        { id: "2", title: "Second Chat", status: "idle", lastActive: "2025-01-02T00:00:00Z", messageCount: 10 },
      ];
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(sessions);

      renderSidebar({ currentSessionId: "1" });

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // The active session row (outer div with group class) should have bg-blue-100
      const firstChatRow = screen.getByText("First Chat").closest("div.group");
      expect(firstChatRow).toHaveClass("bg-blue-100");
    });
  });

  describe("new chat button", () => {
    it("should render New Chat button", async () => {
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce([]);

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // New Chat button should be present
      const newChatButton = screen.getByRole("button", { name: /new chat/i });
      expect(newChatButton).toBeInTheDocument();
    });
  });

  describe("error handling", () => {
    it("should display 'Failed to load' when sessions fail to load", async () => {
      vi.mocked(mockApi.api.listSessions).mockRejectedValueOnce(new Error("Network error"));

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("Failed to load")).toBeInTheDocument();
    });
  });

  describe("delete session", () => {
    beforeEach(() => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should immediately remove session from list when delete is clicked (optimistic)", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "Chat to Delete", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
        { id: "2", title: "Keep This Chat", status: "idle", lastActive: "2025-01-02T00:00:00Z", messageCount: 10 },
      ];
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(sessions);
      vi.mocked(mockApi.api.deleteSession).mockResolvedValue({ ok: true, atomsExtracted: 0 });

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("Chat to Delete")).toBeInTheDocument();
      expect(screen.getByText("Keep This Chat")).toBeInTheDocument();

      // Find the delete button using aria-label within the session row
      const chatToDeleteRow = screen.getByText("Chat to Delete").closest("div.group")!;
      const deleteBtn = chatToDeleteRow.querySelector("button[aria-label='Delete']")!;

      expect(deleteBtn).not.toBeNull();
      fireEvent.click(deleteBtn!);

      // Session should be removed immediately (optimistic) — no waitFor needed
      expect(screen.queryByText("Chat to Delete")).toBeNull();
      expect(screen.getByText("Keep This Chat")).toBeInTheDocument();
    });

    it("should roll back session list and alert when api.deleteSession fails", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "Failed Delete Chat", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
      ];
      // listSessions is called twice: initial load + rollback after failed delete
      vi.mocked(mockApi.api.listSessions)
        .mockResolvedValueOnce(sessions)
        .mockResolvedValueOnce(sessions);
      vi.mocked(mockApi.api.deleteSession).mockRejectedValueOnce(new Error("Delete failed"));
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("Failed Delete Chat")).toBeInTheDocument();

      const chatRow = screen.getByText("Failed Delete Chat").closest("div.group")!;
      const deleteBtn = chatRow.querySelector("button[aria-label='Delete']")!;
      fireEvent.click(deleteBtn!);

      // Should roll back — session reappears after re-fetch
      await waitFor(() => {
        expect(screen.getByText("Failed Delete Chat")).toBeInTheDocument();
      });

      expect(alertSpy).toHaveBeenCalled();
    });

    it("should keep session removed when api.deleteSession succeeds", async () => {
      const sessions: SessionInfo[] = [
        { id: "1", title: "Will Be Deleted", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
      ];
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(sessions);
      vi.mocked(mockApi.api.deleteSession).mockResolvedValue({ ok: true, atomsExtracted: 0 });

      renderSidebar();

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      expect(screen.getByText("Will Be Deleted")).toBeInTheDocument();

      const chatRow = screen.getByText("Will Be Deleted").closest("div.group")!;
      const deleteBtn = chatRow.querySelector("button[aria-label='Delete']")!;
      fireEvent.click(deleteBtn!);

      // Session stays gone
      await waitFor(() => {
        expect(screen.queryByText("Will Be Deleted")).toBeNull();
      });
    });
  });

  describe("new chat optimistic update", () => {
    it("should optimistically add new session to top of list and call onSelectSession", async () => {
      const existingSessions: SessionInfo[] = [
        { id: "2", title: "Existing Chat", status: "idle", lastActive: "2025-01-02T00:00:00Z", messageCount: 10 },
      ];
      const newSession: SessionInfo = {
        id: "new-123",
        title: "New Chat",
        status: "idle",
        lastActive: "2025-01-03T00:00:00Z",
        messageCount: 0,
      };
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce(existingSessions);
      vi.mocked(mockApi.api.createSession).mockResolvedValueOnce(newSession);

      const onSelectSession = vi.fn();
      renderSidebar({ onSelectSession });

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const newChatButtons = screen.getAllByRole("button", { name: /new chat/i });
      fireEvent.click(newChatButtons[0]);

      // New session should appear immediately at top
      await waitFor(() => {
        expect(screen.getByText("New Chat")).toBeInTheDocument();
      });

      // onSelectSession should be called with new ID
      expect(onSelectSession).toHaveBeenCalledWith("new-123");
    });

    it("should not call onSelectSession when api.createSession fails", async () => {
      vi.mocked(mockApi.api.listSessions).mockResolvedValue([]);
      vi.mocked(mockApi.api.createSession).mockImplementation(() =>
        Promise.reject(new Error("Create failed"))
      );
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const onSelectSession = vi.fn();
      renderSidebar({ onSelectSession });

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      const newChatButtons = screen.getAllByRole("button", { name: /new chat/i });
      fireEvent.click(newChatButtons[0]);

      // Wait for async error to propagate
      await waitFor(() => {});

      // onSelectSession should NOT be called on failure
      expect(onSelectSession).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
