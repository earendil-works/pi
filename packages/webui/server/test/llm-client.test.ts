import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the fs module used by the module under test.
// Since llm-client.ts imports 'node:fs' directly, we need to handle this carefully.

describe("LLMClient", () => {
  let tempModelsJson: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  const fakeProviderConfig = {
    providers: {
      "test-provider": {
        name: "Test Provider",
        baseUrl: "https://api.test.com",
        apiKey: "test-key",
        authHeader: true,
        models: [
          {
            id: "test-model",
            name: "Test Model",
            api: "openai-completions",
            baseUrl: "https://api.test.com",
            headers: {},
          },
        ],
      },
    },
  };

  beforeEach(() => {
    // Create temp models.json
    const tmpPath = join(tmpdir(), `pi-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpPath, { recursive: true });
    tempModelsJson = join(tmpPath, "models.json");
    writeFileSync(tempModelsJson, JSON.stringify(fakeProviderConfig));

    // Reset and setup fetch mock
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // Advance timers through any pending async ops
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    try {
      unlinkSync(tempModelsJson);
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Test (a): reads models.json
  // -------------------------------------------------------------------------
  it("(a) reads models.json and initializes provider config", async () => {
    // Dynamic import to get a fresh module
    const { LLMClient } = await import("../llm-client");
    const inst = new LLMClient(tempModelsJson);
    inst.init();

    // Access private state via type assertion (test-only introspection)
    const state = inst as { provider: string | null; modelId: string | null; baseUrl: string | null; apiKey: string | null };
    expect(state.provider).toBe("test-provider");
    expect(state.modelId).toBe("test-model");
    expect(state.baseUrl).toBe("https://api.test.com");
    expect(state.apiKey).toBe("test-key");
  });

  // -------------------------------------------------------------------------
  // Test (b): extractAtoms parses valid JSON response
  // -------------------------------------------------------------------------
  it("(b) extractAtoms parses valid JSON and returns atoms", async () => {
    vi.useRealTimers(); // Need real timers for actual async fetch
    const { LLMClient } = await import("../llm-client");
    const inst = new LLMClient(tempModelsJson);
    inst.init();

    const extractionResponse = {
      plan: [
        {
          action: "create",
          type: "preference",
          title: "User prefers dark mode",
          summary: "User has set dark mode as their preferred theme",
          tags: ["ui", "theme", "dark-mode"],
          importance: 0.8,
        },
        {
          action: "create",
          type: "workflow",
          title: "Daily standup workflow",
          summary: "User attends daily standup at 9am",
          tags: ["schedule", "meetings"],
          importance: 0.6,
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(extractionResponse) } }],
      }),
    } as Response);

    const result = await inst.extractAtoms("some session content");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "preference",
      title: "User prefers dark mode",
      summary: "User has set dark mode as their preferred theme",
      tags: ["ui", "theme", "dark-mode"],
      importance: 0.8,
      strength: 1.0,
    });
    expect(result[1]).toMatchObject({
      type: "workflow",
      title: "Daily standup workflow",
      tags: ["schedule", "meetings"],
    });
  });

  // -------------------------------------------------------------------------
  // Test (c): retries on 500
  // -------------------------------------------------------------------------
  it("(c) retries on 500 and succeeds on retry", async () => {
    const { LLMClient } = await import("../llm-client");
    const inst = new LLMClient(tempModelsJson);
    inst.init();

    const extractionResponse = {
      plan: [
        {
          action: "create",
          type: "knowledge",
          title: "Learning Go",
          summary: "User is learning Go programming",
          tags: ["golang", "programming"],
          importance: 0.7,
        },
      ],
    };

    // First call: 500 error, Second call: success
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(extractionResponse) } }],
        }),
      } as Response);

    // Start the extraction call
    const extractPromise = inst.extractAtoms("session messages");

    // Advance through the retry delay (2000ms)
    await vi.advanceTimersByTimeAsync(2000);

    const result = await extractPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Learning Go");
  });

  // -------------------------------------------------------------------------
  // Test (d): throws after 2nd failure
  // -------------------------------------------------------------------------
  it("(d) throws after 2nd failure", async () => {
    const { LLMClient } = await import("../llm-client");
    const inst = new LLMClient(tempModelsJson);
    inst.init();

    // Both calls fail with 500
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const extractPromise = inst.extractAtoms("session messages");

    // Advance through first timeout (5000ms), then retry delay (2000ms), then second timeout (5000ms)
    // The actual flow: call fails -> sleep 2000 -> retry -> fail -> throw
    // But the first call will fail quickly (no real network), then 2000ms sleep, then second call fails
    await vi.advanceTimersByTimeAsync(2100); // past the 2000ms retry delay

    await expect(extractPromise).rejects.toThrow(/LLM extraction failed after retry/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
