import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryDetail } from "./MemoryDetail";
import { api, type MemoryAtom } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      memory: {
        ...actual.api.memory,
        get: vi.fn(),
        patch: vi.fn(),
      },
    },
  };
});

const ATOM: MemoryAtom = {
  id: "a-1",
  type: "rule",
  title: "Test title",
  summary: "summary",
  tags: [],
  importance: 0.5,
  strength: 0.7,
  access_count: 0,
  last_access: null,
  created_at: 1735689600000,
  updated_at: 1735689600000,
  version: 1,
  archived: false,
  content: "# body",
};

describe("MemoryDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.memory.get as ReturnType<typeof vi.fn>).mockResolvedValue(ATOM);
    (api.memory.patch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ATOM,
      title: "New",
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads atom and renders title", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(screen.getByDisplayValue("Test title")).toBeDefined();
    expect(screen.getByText("version: 1")).toBeDefined();
  });

  it("debounced patch fires 3s after title change", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.change(screen.getByDisplayValue("Test title"), {
      target: { value: "New title" },
    });
    expect(api.memory.patch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.memory.patch).toHaveBeenCalledWith(
      "a-1",
      expect.objectContaining({ title: "New title" }),
    );
  });

  it("error status shows red message", async () => {
    (api.memory.patch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("save failed"),
    );
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.change(screen.getByDisplayValue("Test title"), {
      target: { value: "X" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/error: save failed/)).toBeDefined();
  });

  it("Archive button calls onArchive immediately", async () => {
    const onArchive = vi.fn();
    render(
      <MemoryDetail
        id="a-1"
        onArchive={onArchive}
        onListRefresh={vi.fn()}
      />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    // header Archive button is the first one rendered
    const archiveButtons = screen.getAllByText("Archive");
    expect(archiveButtons.length).toBeGreaterThan(0);
    fireEvent.click(archiveButtons[0]!);
    expect(onArchive).toHaveBeenCalledWith("a-1");
  });
});
