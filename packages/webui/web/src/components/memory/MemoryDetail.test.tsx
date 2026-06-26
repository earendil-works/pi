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

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Map<string, Set<(event: { data: string }) => void>> =
    new Map();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  simulateMessage(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    if (type === "message") {
      this.onmessage?.({ data } as MessageEvent);
      return;
    }
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data } as MessageEvent);
    }
  }

  simulateError(): void {
    this.onerror?.(new Event("error"));
  }
}

function lastSource(): MockEventSource {
  const src = MockEventSource.instances[MockEventSource.instances.length - 1];
  if (!src) throw new Error("no EventSource was created");
  return src;
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  globalThis.EventSource =
    MockEventSource as unknown as typeof globalThis.EventSource;
});

describe("MemoryDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances.length = 0;
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
    const archiveButtons = screen.getAllByText("Archive");
    expect(archiveButtons.length).toBeGreaterThan(0);
    fireEvent.click(archiveButtons[0]!);
    expect(onArchive).toHaveBeenCalledWith("a-1", false);
  });
});

describe("MemoryDetail SSE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances.length = 0;
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

  it("opens an EventSource pointing at /api/memory/<id>/stream on mount", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(lastSource().url).toBe("/api/memory/a-1/stream");
  });

  it("does not poll after the initial fetch", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const callsAfterMount = (api.memory.get as ReturnType<typeof vi.fn>).mock
      .calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect((api.memory.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterMount,
    );
  });

  it("applies SSE messages whose version is newer than the current atom", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const updated: MemoryAtom = {
      ...ATOM,
      version: 2,
      title: "From SSE",
      updated_at: ATOM.updated_at + 1,
    };
    act(() => {
      lastSource().simulateMessage("atom", updated);
    });
    expect(screen.getByDisplayValue("From SSE")).toBeDefined();
    expect(screen.getByText("version: 2")).toBeDefined();
  });

  it("drops SSE messages whose version is not greater than current", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const stale: MemoryAtom = { ...ATOM, version: 1, title: "Stale" };
    act(() => {
      lastSource().simulateMessage("atom", stale);
    });
    expect(screen.queryByDisplayValue("Stale")).toBeNull();
    expect(screen.getByDisplayValue("Test title")).toBeDefined();
  });

  it("drops SSE messages with a smaller version (out-of-order)", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const newer: MemoryAtom = {
      ...ATOM,
      version: 5,
      title: "Newer",
      updated_at: ATOM.updated_at + 5,
    };
    const older: MemoryAtom = {
      ...ATOM,
      version: 3,
      title: "Older",
      updated_at: ATOM.updated_at + 3,
    };
    act(() => {
      lastSource().simulateMessage("atom", newer);
    });
    act(() => {
      lastSource().simulateMessage("atom", older);
    });
    expect(screen.getByDisplayValue("Newer")).toBeDefined();
    expect(screen.queryByDisplayValue("Older")).toBeNull();
  });

  it("shows a reconnect hint on EventSource error and keeps the stream alive", async () => {
    render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    act(() => {
      lastSource().simulateError();
    });
    expect(screen.getByText(/连接中断|重连/)).toBeDefined();
    expect(lastSource().closed).toBe(false);
  });

  it("closes the EventSource on unmount", async () => {
    const { unmount } = render(
      <MemoryDetail id="a-1" onArchive={vi.fn()} onListRefresh={vi.fn()} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    unmount();
    expect(lastSource().closed).toBe(true);
  });
});