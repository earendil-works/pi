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

  it("Save now calls onSave with patch containing changed fields", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemoryEditor atom={ATOM} onSave={onSave} onArchive={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("Original title"), {
      target: { value: "New title" },
    });
    fireEvent.click(screen.getByText("Save now"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patch = onSave.mock.calls[0]![0];
    expect(patch.title).toBe("New title");
    // content should NOT be in patch when not changed
    expect(patch.content).toBeUndefined();
  });

  it("content change is included in patch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MemoryEditor atom={ATOM} onSave={onSave} onArchive={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue("# orig"), {
      target: { value: "# new body" },
    });
    fireEvent.click(screen.getByText("Save now"));
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
});
