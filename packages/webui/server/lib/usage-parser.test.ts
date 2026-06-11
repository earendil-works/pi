import { describe, it, expect } from "vitest";
import { extractUsage } from "./usage-parser";

describe("extractUsage", () => {
  it("should extract usage from valid JSONL line with numbers", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 100, output: 200 } },
    });
    expect(extractUsage(line)).toEqual({ input: 100, output: 200 });
  });

  it("should return undefined when usage field is missing", () => {
    const line = JSON.stringify({ message: { role: "assistant" } });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when message field is missing", () => {
    const line = JSON.stringify({});
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should convert string numbers to actual numbers", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: "150", output: "350" } },
    });
    expect(extractUsage(line)).toEqual({ input: 150, output: 350 });
  });

  it("should handle zero values", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 0, output: 0 } },
    });
    expect(extractUsage(line)).toEqual({ input: 0, output: 0 });
  });

  it("should return undefined for negative numbers", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: -10, output: 200 } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when input is negative", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 100, output: -50 } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when input is not a number (string)", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: "abc", output: 200 } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when output is not a number (string)", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 100, output: "def" } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when input is null", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: null, output: 200 } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when output is undefined in object", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 100 } },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should throw for malformed JSON", () => {
    const line = '{invalid json}';
    expect(() => extractUsage(line)).toThrow();
  });

  it("should throw for empty string", () => {
    const line = "";
    expect(() => extractUsage(line)).toThrow();
  });

  it("should return numbers, not strings", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 42, output: 84 } },
    });
    const result = extractUsage(line);
    expect(typeof result?.input).toBe("number");
    expect(typeof result?.output).toBe("number");
  });

  it("should handle usage with float values", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: { input: 1.5, output: 2.5 } },
    });
    expect(extractUsage(line)).toEqual({ input: 1.5, output: 2.5 });
  });

  it("should return undefined when usage is not an object", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: "not an object" },
    });
    expect(extractUsage(line)).toBeUndefined();
  });

  it("should return undefined when usage is an array", () => {
    const line = JSON.stringify({
      message: { role: "assistant", usage: [1, 2, 3] },
    });
    expect(extractUsage(line)).toBeUndefined();
  });
});
