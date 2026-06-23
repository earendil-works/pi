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
      results: [{
        id: "abc123def456",
        type: "rule",
        title: "Foo result",
        summary: "Test summary",
        tags: ["test"],
        distance: 0.42,
        cosine: 0.79,
        score: 1.05,
      }],
      recallTimeMs: 12,
    });
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "foo" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(api.memory.search).toHaveBeenCalledWith("foo", 10));
    expect(screen.getByText("Foo result")).toBeDefined();
    expect(screen.getByText(/cos 0\.\d{3}/)).toBeDefined();
    expect(screen.getByText(/score 1\.\d{3}/)).toBeDefined();
  });

  it("calls onSelectAtom when result clicked", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{
        id: "abc123def456",
        type: "fact",
        title: "X result",
        summary: "",
        tags: [],
        distance: 0.5,
        cosine: 0.6,
        score: 0.9,
      }],
      recallTimeMs: 8,
    });
    const onSelect = vi.fn();
    render(<MemorySearchTester onSelectAtom={onSelect} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByText("X result")).toBeDefined());
    fireEvent.click(screen.getByText("X result"));
    expect(onSelect).toHaveBeenCalledWith("abc123def456");
  });

  it("displays score in result row", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{
        id: "deadbeefcafe",
        type: "process",
        title: "Score row",
        summary: "",
        tags: [],
        distance: 0.1,
        cosine: 0.95,
        score: 1.5,
      }],
      recallTimeMs: 5,
    });
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByText(/score 1\.500/)).toBeDefined());
  });

  it("displays truncated id", async () => {
    (api.memory.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{
        id: "1234567890abcdef",
        type: "rule",
        title: "Id row",
        summary: "",
        tags: [],
        distance: 0.1,
        cosine: 0.95,
        score: 1.0,
      }],
      recallTimeMs: 5,
    });
    render(<MemorySearchTester onSelectAtom={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Query..."), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByText(/id: 12345678/)).toBeDefined());
  });
});
