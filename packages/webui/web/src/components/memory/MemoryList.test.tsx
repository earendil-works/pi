import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryList } from "./MemoryList";
import type { MemoryAtom } from "../../lib/api";

const ATOMS: MemoryAtom[] = [
  { id: "a-1", type: "preference", title: "Use tabs", summary: "tabs not spaces",
    tags: ["editor"], importance: 0.8, strength: 0.9, access_count: 0, last_access: "",
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z", version: 1, archived: false,
    content: "", file_path: "", content_hash: "" },
  { id: "a-2", type: "workflow", title: "Run tests first", summary: "test policy",
    tags: [], importance: 0.5, strength: 0.7, access_count: 0, last_access: "",
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-03T00:00:00Z", version: 1, archived: true,
    content: "", file_path: "", content_hash: "" },
  { id: "a-3", type: "preference", title: "Dark mode", summary: "ui",
    tags: ["ui"], importance: 0.3, strength: 0.5, access_count: 0, last_access: "",
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", version: 1, archived: false,
    content: "", file_path: "", content_hash: "" },
];

describe("MemoryList", () => {
  it("renders all atoms by default", () => {
    render(<MemoryList atoms={ATOMS} onSelect={vi.fn()} onArchive={vi.fn()} filters={{ types: [], archived: "all", tag: "", q: "" }} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText("Use tabs")).toBeDefined();
    expect(screen.getByText("Run tests first")).toBeDefined();
    expect(screen.getByText("Dark mode")).toBeDefined();
  });

  it("filters by archived=active (excludes archived a-2)", () => {
    render(<MemoryList atoms={ATOMS} onSelect={vi.fn()} onArchive={vi.fn()} filters={{ types: [], archived: "active", tag: "", q: "" }} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.queryByText("Run tests first")).toBeNull();
  });

  it("calls onSelect when card clicked", () => {
    const onSelect = vi.fn();
    render(<MemoryList atoms={ATOMS} onSelect={onSelect} onArchive={vi.fn()} filters={{ types: [], archived: "all", tag: "", q: "" }} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);
    const card = screen.getByText("Use tabs").closest("[data-atom-id]");
    fireEvent.click(card!);
    expect(onSelect).toHaveBeenCalledWith("a-1");
  });

  it("filters by type when chip toggled", () => {
    const onFilterChange = vi.fn();
    render(<MemoryList atoms={ATOMS} onSelect={vi.fn()} onArchive={vi.fn()} filters={{ types: [], archived: "all", tag: "", q: "" }} onFilterChange={onFilterChange} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "preference" }));
    expect(onFilterChange).toHaveBeenCalled();
    const called = onFilterChange.mock.calls[0][0];
    expect(called.types).toContain("preference");
  });

  it("calls onArchive when archive button clicked", () => {
    const onArchive = vi.fn();
    render(<MemoryList atoms={ATOMS} onSelect={vi.fn()} onArchive={onArchive} filters={{ types: [], archived: "all", tag: "", q: "" }} onFilterChange={vi.fn()} onRefresh={vi.fn()} />);
    const archiveBtn = screen.getAllByTitle("Archive")[0];
    fireEvent.click(archiveBtn);
    expect(onArchive).toHaveBeenCalled();
  });
});
