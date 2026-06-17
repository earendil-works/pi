import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryEditor } from "./MemoryEditor";
import type { MemoryAtom } from "../../lib/api";

const ATOM: MemoryAtom = {
  id: "a-1",
  type: "preference",
  title: "Original title",
  summary: "orig summary",
  tags: ["orig"],
  importance: 0.5,
  strength: 0.7,
  access_count: 0,
  last_access: "",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  version: 1,
  archived: false,
  content: "# orig",
  file_path: "",
  content_hash: "",
};

describe("MemoryEditor", () => {
  it("renders title in input", () => {
    render(<MemoryEditor atom={ATOM} onSave={vi.fn()} onArchive={vi.fn()} />);
    const titleInput = screen.getByDisplayValue("Original title");
    expect(titleInput).toBeDefined();
  });

  it("Save now calls onFlush (bypasses debounce)", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryEditor
        atom={ATOM}
        onSave={vi.fn()}
        onArchive={vi.fn()}
        onFlush={onFlush}
      />,
    );
    fireEvent.click(screen.getByText("Save now"));
    await waitFor(() => expect(onFlush).toHaveBeenCalled());
  });

  it("Save now does NOT call onSave (debounce bypasses the patch path)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onFlush = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryEditor
        atom={ATOM}
        onSave={onSave}
        onArchive={vi.fn()}
        onFlush={onFlush}
      />,
    );
    fireEvent.click(screen.getByText("Save now"));
    await waitFor(() => expect(onFlush).toHaveBeenCalled());
    // Save now flushes immediately; it should NOT also call onSave (that path
    // is reserved for per-keystroke auto-save patches).
    expect(onSave).not.toHaveBeenCalled();
  });

  it("content change fires onSave with patch (typing path still works)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemoryEditor atom={ATOM} onSave={onSave} onArchive={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("# orig"), {
      target: { value: "# new body" },
    });
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patch = onSave.mock.calls[0]![0];
    expect(patch.content).toBe("# new body");
  });

  it("Archive button calls onArchive (bypasses debounce)", () => {
    const onArchive = vi.fn();
    render(<MemoryEditor atom={ATOM} onSave={vi.fn()} onArchive={onArchive} />);
    fireEvent.click(screen.getByText("Archive"));
    expect(onArchive).toHaveBeenCalled();
  });

  it("importance slider value is reflected", () => {
    render(<MemoryEditor atom={ATOM} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.getByText(/importance 0\.50/)).toBeDefined();
  });

  it("renders <memory-error> placeholder when content='' and file_path set", () => {
    const atom: MemoryAtom = { ...ATOM, content: "", file_path: "/tmp/x.md" };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.getByTestId("memory-error")).toBeDefined();
    expect(screen.getByText(/file hash mismatch/)).toBeDefined();
  });

  it("does NOT render <memory-error> when content is non-empty", () => {
    const atom: MemoryAtom = {
      ...ATOM,
      content: "# body",
      file_path: "/tmp/x.md",
    };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.queryByTestId("memory-error")).toBeNull();
  });

  it("does NOT render <memory-error> when file_path is empty", () => {
    const atom: MemoryAtom = { ...ATOM, content: "", file_path: "" };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.queryByTestId("memory-error")).toBeNull();
  });
});
