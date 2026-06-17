import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryPage } from "./MemoryPage";
import { api } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      memory: {
        ...actual.api.memory,
        list: vi.fn(),
        stats: vi.fn(),
        archive: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
        search: vi.fn(),
      },
    },
  };
});

const ATOMS = [
  {
    id: "a-1",
    type: "preference" as const,
    title: "Atom 1",
    summary: "",
    tags: [],
    importance: 0.5,
    strength: 0.7,
    access_count: 0,
    last_access: "",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    version: 1,
    archived: false,
    content: "",
    file_path: "",
    content_hash: "",
  },
  {
    id: "a-2",
    type: "workflow" as const,
    title: "Atom 2",
    summary: "",
    tags: [],
    importance: 0.5,
    strength: 0.7,
    access_count: 0,
    last_access: "",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    version: 1,
    archived: false,
    content: "",
    file_path: "",
    content_hash: "",
  },
];

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.memory.list as ReturnType<typeof vi.fn>).mockResolvedValue(ATOMS);
    (api.memory.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      total: 2,
      archived: 0,
      byType: { preference: 1, workflow: 1 },
    });
    (api.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ATOMS[0],
      content: "# body",
    });
    // Only fake setInterval/clearInterval (not setTimeout) so waitFor's internal
    // setTimeout retries still fire on real time. The page polls every 3s via
    // setInterval which we want to control with runOnlyPendingTimersAsync.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders list with stats on mount", async () => {
    render(<MemoryPage />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByText("Atom 1")).toBeInTheDocument();
    expect(screen.getByText("Atom 2")).toBeInTheDocument();
    expect(screen.getByText(/total: 2/)).toBeInTheDocument();
  });

  it("clicking a list item shows detail", async () => {
    render(<MemoryPage />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.click(screen.getByText("Atom 1"));
    await waitFor(() => expect(screen.getByDisplayValue("Atom 1")).toBeInTheDocument());
  });

  it("Archive handler removes atom from list optimistically", async () => {
    (api.memory.archive as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      atom: ATOMS[0],
    });
    render(<MemoryPage />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const archiveBtns = screen.getAllByText("Archive");
    fireEvent.click(archiveBtns[0]!);
    await waitFor(() => expect(api.memory.archive).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Atom 1")).toBeNull());
  });

  it("shows empty state when no atom selected", async () => {
    render(<MemoryPage />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByText("Select an atom from the list")).toBeInTheDocument();
  });

  it("debounces filter input by 300ms before re-fetching", async () => {
    // This test needs full fake timers (including setTimeout) because the
    // debounce uses setTimeout. beforeEach only fakes setInterval/clearInterval
    // so the other tests' waitFor() retries still fire on real time.
    vi.useFakeTimers();
    (api.memory.list as ReturnType<typeof vi.fn>).mockClear();
    (api.memory.stats as ReturnType<typeof vi.fn>).mockClear();
    render(<MemoryPage />);
    // Let initial mount fetch resolve
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const initialCallCount = (api.memory.list as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(initialCallCount).toBeGreaterThan(0);

    // Change q filter via typing
    const qInput = screen.getByPlaceholderText(/search title/i) as HTMLInputElement;
    fireEvent.change(qInput, { target: { value: "hello" } });
    // Flush React state updates from the input change before advancing timers.
    await act(async () => {
      await Promise.resolve();
    });

    // 100ms in: not committed yet — debounce should keep call count flat
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect((api.memory.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCallCount);

    // 300ms+ in: committed — debounce should now trigger a new fetch.
    // Advance timers, then flush the resulting React state update + effect.
    await vi.advanceTimersByTimeAsync(250);
    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });
    expect((api.memory.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      initialCallCount,
    );
  });
});
