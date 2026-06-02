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

      // The active session button should have bg-blue-100 class
      const firstChatButton = screen.getByText("First Chat").closest("button");
      expect(firstChatButton).toHaveClass("bg-blue-100");
    });
  });

  describe("new chat button", () => {
    it("should call onNewChat when New Chat button is clicked", async () => {
      vi.mocked(mockApi.api.listSessions).mockResolvedValueOnce([]);

      const onNewChat = vi.fn();
      renderSidebar({ onNewChat });

      await waitFor(() => {
        expect(screen.queryByText("Loading...")).toBeNull();
      });

      // Get all buttons and find the one with "New Chat" text in the last rendered sidebar
      const buttons = screen.getAllByRole("button");
      const newChatButton = buttons.find((btn) => btn.textContent === "New Chat");
      expect(newChatButton).toBeDefined();

      fireEvent.click(newChatButton!);
      expect(onNewChat).toHaveBeenCalledTimes(1);
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
});
