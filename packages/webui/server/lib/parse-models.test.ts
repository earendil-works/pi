import { describe, it, expect } from "vitest";
import { parseModelsJson } from "./parse-models";

describe("parseModelsJson", () => {
  it("returns empty providers for null input", () => {
    expect(parseModelsJson(null as unknown as string)).toEqual({ providers: [] });
  });

  it("returns empty providers for undefined input", () => {
    expect(parseModelsJson(undefined as unknown as string)).toEqual({ providers: [] });
  });

  it("returns empty providers for empty string", () => {
    expect(parseModelsJson("")).toEqual({ providers: [] });
  });

  it("returns empty providers for whitespace-only string", () => {
    expect(parseModelsJson("   ")).toEqual({ providers: [] });
  });

  it("returns empty providers for invalid JSON", () => {
    expect(parseModelsJson("not json")).toEqual({ providers: [] });
  });

  it("returns empty providers for non-object JSON (array primitives)", () => {
    expect(parseModelsJson('"string"')).toEqual({ providers: [] });
    expect(parseModelsJson("123")).toEqual({ providers: [] });
  });

  // Schema 1: { providers: [{ name, models }] }
  it("parses schema 1: providers array with name and models", () => {
    const input = JSON.stringify({
      providers: [
        {
          name: "openai",
          models: [
            { id: "gpt-4", name: "GPT-4" },
            { id: "gpt-3.5", name: "GPT-3.5 Turbo" },
          ],
        },
        {
          name: "anthropic",
          models: [
            { id: "claude-3", name: "Claude 3" },
          ],
        },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "openai",
          models: [
            { id: "gpt-4", name: "GPT-4" },
            { id: "gpt-3.5", name: "GPT-3.5 Turbo" },
          ],
        },
        {
          name: "anthropic",
          models: [{ id: "claude-3", name: "Claude 3" }],
        },
      ],
    });
  });

  // Schema 2: { [name]: models[] } flat structure
  it("parses schema 2: flat provider structure with id and name", () => {
    const input = JSON.stringify({
      openai: [
        { id: "gpt-4", name: "GPT-4" },
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
      ],
      anthropic: [
        { id: "claude-3-opus", name: "Claude 3 Opus" },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "openai",
          models: [
            { id: "gpt-4", name: "GPT-4" },
            { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
          ],
        },
        {
          name: "anthropic",
          models: [{ id: "claude-3-opus", name: "Claude 3 Opus" }],
        },
      ],
    });
  });

  it("parses schema 2: flat provider structure with id and label (label becomes name)", () => {
    const input = JSON.stringify({
      openai: [
        { id: "gpt-4", label: "GPT-4" },
        { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "openai",
          models: [
            { id: "gpt-4", name: "GPT-4" },
            { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
          ],
        },
      ],
    });
  });

  it("parses schema 2: flat provider with model having only id (id becomes name)", () => {
    const input = JSON.stringify({
      local: [
        { id: "llama-3" },
        { id: "mistral-7b" },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "local",
          models: [
            { id: "llama-3", name: "llama-3" },
            { id: "mistral-7b", name: "mistral-7b" },
          ],
        },
      ],
    });
  });

  // Schema 3: [{ name, models }] array of providers
  it("parses schema 3: array of providers", () => {
    const input = JSON.stringify([
      {
        name: "openai",
        models: [{ id: "gpt-4", name: "GPT-4" }],
      },
      {
        name: "anthropic",
        models: [{ id: "claude-3", name: "Claude 3" }],
      },
    ]);
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "openai",
          models: [{ id: "gpt-4", name: "GPT-4" }],
        },
        {
          name: "anthropic",
          models: [{ id: "claude-3", name: "Claude 3" }],
        },
      ],
    });
  });

  // Missing name field in model - use id as name
  it("fills missing model name with id", () => {
    const input = JSON.stringify({
      providers: [
        {
          name: "test-provider",
          models: [
            { id: "model-1" },
            { id: "model-2", name: "Model Two" },
            { id: "model-3", label: "Model Three Label" },
          ],
        },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "test-provider",
          models: [
            { id: "model-1", name: "model-1" },
            { id: "model-2", name: "Model Two" },
            { id: "model-3", name: "Model Three Label" },
          ],
        },
      ],
    });
  });

  // Schema 1 with missing name in model
  it("schema 1 fills missing model name with id", () => {
    const input = JSON.stringify({
      providers: [
        {
          name: "provider-a",
          models: [{ id: "model-x" }],
        },
      ],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [
        {
          name: "provider-a",
          models: [{ id: "model-x", name: "model-x" }],
        },
      ],
    });
  });

  // Edge case: empty providers array
  it("handles empty providers array", () => {
    const input = JSON.stringify({ providers: [] });
    expect(parseModelsJson(input)).toEqual({ providers: [] });
  });

  // Edge case: empty models arrays
  it("handles empty models arrays", () => {
    const input = JSON.stringify({
      providers: [{ name: "empty-provider", models: [] }],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [{ name: "empty-provider", models: [] }],
    });
  });

  // Edge case: schema 2 with empty provider arrays
  it("handles schema 2 with empty arrays", () => {
    const input = JSON.stringify({
      empty: [],
    });
    expect(parseModelsJson(input)).toEqual({
      providers: [{ name: "empty", models: [] }],
    });
  });

  // Non-object root for schema 3 (array of non-objects)
  it("returns empty for non-object array items", () => {
    expect(parseModelsJson("[]")).toEqual({ providers: [] });
    expect(parseModelsJson("[1, 2, 3]")).toEqual({ providers: [] });
  });
  describe("schema 4: { providers: { [name]: config { models, ... } } }", () => {
    it("parses the actual models.json shape with provider configs", () => {
      const json = JSON.stringify({
        providers: {
          local: { baseUrl: "http://localhost:11434/v1", api: "openai", models: [{ id: "qwen2.5:3b" }] },
          opencode: { api: "opencode", models: [{ id: "mimo-v2.5" }] },
        },
      });
      const result = parseModelsJson(json);
      expect(result.providers).toHaveLength(2);
      expect(result.providers[0].name).toBe("local");
      expect(result.providers[0].models[0].id).toBe("qwen2.5:3b");
      expect(result.providers[1].name).toBe("opencode");
      expect(result.providers[1].models[0].id).toBe("mimo-v2.5");
    });
  });

  // Schema-independent coverage for `contextWindow`. Frontend uses this
  // for the topbar's "used / total" context indicator; an invalid /
  // missing field must round-trip to `undefined` so the UI drops back
  // to "used only" instead of showing a misleading denominator.
  describe("contextWindow propagation", () => {
    it("schema 1: extracts contextWindow when present on a model", () => {
      const input = JSON.stringify({
        providers: [
          {
            name: "anthropic",
            models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4", contextWindow: 200000 }],
          },
        ],
      });
      const result = parseModelsJson(input);
      expect(result.providers[0].models[0]).toEqual({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4",
        contextWindow: 200000,
      });
    });

    it("schema 4: extracts contextWindow under provider configs", () => {
      const input = JSON.stringify({
        providers: {
          anthropic: { models: [{ id: "claude-sonnet-4-6", contextWindow: 200000 }] },
        },
      });
      const result = parseModelsJson(input);
      expect(result.providers[0].models[0].contextWindow).toBe(200000);
    });

    it("omits contextWindow (undefined) when the field is missing", () => {
      const input = JSON.stringify({
        providers: [{ name: "openai", models: [{ id: "gpt-4", name: "GPT-4" }] }],
      });
      const result = parseModelsJson(input);
      expect(result.providers[0].models[0]).not.toHaveProperty("contextWindow");
    });

    it("ignores contextWindow when non-numeric / non-positive", () => {
      const input = JSON.stringify({
        providers: [
          { name: "p1", models: [{ id: "m1", contextWindow: -1 }] },
          { name: "p2", models: [{ id: "m2", contextWindow: "200000" }] },
          { name: "p3", models: [{ id: "m3", contextWindow: null }] },
        ],
      });
      const result = parseModelsJson(input);
      // All three models should drop the field — UI must not render a
      // misleading denominator when the source is malformed.
      for (const provider of result.providers) {
        for (const model of provider.models) {
          expect(model).not.toHaveProperty("contextWindow");
        }
      }
    });
  });
});
