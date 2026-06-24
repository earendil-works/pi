import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryEditor } from "./MemoryEditor";
import type { MemoryAtom } from "../../lib/api";

const ATOM: MemoryAtom = {
  id: "a-1",
  type: "rule",
  title: "Original title",
  summary: "orig summary",
  tags: ["orig"],
  importance: 0.5,
  strength: 0.7,
  access_count: 0,
  last_access: null,
  created_at: 1735689600000,
  updated_at: 1735689600000,
  version: 1,
  archived: false,
  content: "# orig",
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

  it("renders <memory-error> placeholder when content is empty (v2: hash_mismatch collapsed into content=='')", () => {
    const atom: MemoryAtom = {
      ...ATOM,
      content: "",
    };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.getByTestId("memory-error")).toBeDefined();
    expect(screen.getByText(/empty body/)).toBeDefined();
  });

  it("does NOT render <memory-error> when content is non-empty", () => {
    const atom: MemoryAtom = {
      ...ATOM,
      content: "# body",
    };
    render(<MemoryEditor atom={atom} onSave={vi.fn()} onArchive={vi.fn()} />);
    expect(screen.queryByTestId("memory-error")).toBeNull();
  });

  it("type <select> exposes the v2 3-type set (rule / fact / process)", () => {
    const { container } = render(
      <MemoryEditor atom={ATOM} onSave={vi.fn()} onArchive={vi.fn()} />,
    );
    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    const optionTexts = Array.from(select!.children).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionTexts).toEqual(expect.arrayContaining(["rule", "fact", "process"]));
  });
});
