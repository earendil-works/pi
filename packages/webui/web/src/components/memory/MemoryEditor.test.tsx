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
    const atom: MemoryAtom = {
      ...ATOM,
      content: "",
      file_path: "/tmp/x.md",
      hash_mismatch: true,
    };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.getByTestId("memory-error")).toBeDefined();
    expect(screen.getByText(/file hash mismatch/)).toBeDefined();
  });

  it("shows memory-error banner only when atom.hash_mismatch is true (task 7.3)", () => {
    const mismatched: MemoryAtom = {
      ...ATOM,
      content: "",
      file_path: "/tmp/x.md",
      hash_mismatch: true,
    };
    const { unmount } = render(
      <MemoryEditor atom={mismatched} onSave={vi.fn()} onArchive={vi.fn()} />,
    );
    expect(screen.getByTestId("memory-error")).toBeDefined();
    expect(screen.getByText(/file hash mismatch/)).toBeDefined();
    unmount();

    const clearedBody: MemoryAtom = {
      ...ATOM,
      content: "",
      file_path: "/tmp/x.md",
    };
    render(<MemoryEditor atom={clearedBody} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.queryByTestId("memory-error")).toBeNull();
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

  it("renders 'bug' as an option in the type <select> (8th type)", () => {
    // Production data has 1 atom with type='bug' (out-of-band from the
    // documented 7-type set). Without this option the editor's <select>
    // defaults to "constraint" on PATCH and silently changes the atom's
    // type. See task 6.7 / review-fail MEDIUM.
    const { container } = render(
      <MemoryEditor atom={ATOM} onSave={vi.fn()} onArchive={vi.fn()} />,
    );
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    const optionTexts = Array.from(select!.children).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionTexts).toContain("bug");
  });
});
