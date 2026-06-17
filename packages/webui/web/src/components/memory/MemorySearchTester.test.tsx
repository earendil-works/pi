import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemorySearchTester } from "./MemorySearchTester";
import { api } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      memory: {
        ...actual.api.memory,
        search: vi.fn(),
      },
    },
  };
});

describe("MemorySearchTester", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Search button is disabled when query is empty", () => {
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /search/i });
    expect(btn).toBeDisabled();
  });

  it("calls api.memory.search on Search click and renders results", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      rewritten: { keywords: ["foo"], target_types: ["knowledge"], raw_query: "foo" },
      embedding_available: false,
      results: [{
        atom: { id: "a-1", type: "knowledge", title: "Foo result", summary: "",
          tags: [], importance: 0.5, strength: 0.7, access_count: 0, last_access: "",
          created_at: "", updated_at: "", version: 1, archived: false,
          content: "", file_path: "", content_hash: "" },
        fts_score: 0.8, cosine_score: 0, hybrid_score: 0.71,
      }],
    });
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "foo" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(api.memory.search).toHaveBeenCalledWith("foo", 10));
    expect(screen.getByText("Foo result")).toBeDefined();
    expect(screen.getByText("embedding unavailable")).toBeDefined();
  });

  it("renders embedding_available=true when set", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      rewritten: { keywords: ["bar"], target_types: [], raw_query: "bar" },
      embedding_available: true,
      results: [],
    });
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "bar" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByText("embedding available")).toBeDefined());
  });

  it("calls onSelectAtom when result clicked", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      rewritten: { keywords: ["x"], target_types: [], raw_query: "x" },
      embedding_available: false,
      results: [{
        atom: { id: "a-2", type: "preference", title: "X result", summary: "",
          tags: [], importance: 0.5, strength: 0.7, access_count: 0, last_access: "",
          created_at: "", updated_at: "", version: 1, archived: false,
          content: "", file_path: "", content_hash: "" },
        fts_score: 0.5, cosine_score: 0, hybrid_score: 0.5,
      }],
    });
    const onSelect = vi.fn();
    render(<MemorySearchTester onSelectAtom={onSelect} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByText("X result")).toBeDefined());
    fireEvent.click(screen.getByText("X result"));
    expect(onSelect).toHaveBeenCalledWith("a-2");
  });
});