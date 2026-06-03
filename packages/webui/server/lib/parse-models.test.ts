import { describe, it, expect } from "vitest";
import { parseModelsJson } from "./parse-models.js";

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
});
