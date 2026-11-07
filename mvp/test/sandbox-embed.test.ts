import { describe, expect, it } from "vitest";
import { createEmbedRunner, validateVector, EMBED_VECTOR_DIM, EMBED_SCRIPT_PATH } from "../src/memory/sandbox-embed.ts";
import type { SandboxLike } from "../src/sandbox/operations.ts";
import { Writable } from "node:stream";

const GOOD_VEC = Array.from({ length: EMBED_VECTOR_DIM }, (_, i) => i / EMBED_VECTOR_DIM);

function makeSandbox(opts: {
  exitCode?: number;
  output?: string;
  fsWriteError?: boolean;
  runError?: boolean;
}): SandboxLike & { written: string[]; commands: string[] } {
  const written: string[] = [];
  const commands: string[] = [];
  return {
    written,
    commands,
    runCommand: async (params) => {
      commands.push(params.args?.join(" ") ?? "");
      if (opts.runError) throw new Error("sandbox error");
      if (params.stdout && opts.output !== undefined) {
        (params.stdout as Writable).write(Buffer.from(opts.output));
      }
      return { exitCode: opts.exitCode ?? 0 };
    },
    fs: {
      readFile: async () => Buffer.from(""),
      writeFile: async (path, data) => {
        if (opts.fsWriteError) throw new Error("fs write error");
        written.push(typeof data === "string" ? data : Buffer.from(data).toString());
      },
      mkdir: async () => undefined,
      access: async () => {},
      realpath: async (p) => p,
    },
  };
}

describe("validateVector", () => {
  it("accepts a valid 384-dim finite float array", () => {
    expect(validateVector(GOOD_VEC)).toEqual(GOOD_VEC);
  });
  it("rejects wrong length", () => {
    expect(validateVector(Array(383).fill(0))).toBeNull();
    expect(validateVector(Array(385).fill(0))).toBeNull();
  });
  it("rejects non-finite values", () => {
    const bad = [...GOOD_VEC];
    bad[0] = Infinity;
    expect(validateVector(bad)).toBeNull();
    bad[0] = NaN;
    expect(validateVector(bad)).toBeNull();
  });
  it("rejects non-arrays", () => {
    expect(validateVector("string")).toBeNull();
    expect(validateVector(null)).toBeNull();
    expect(validateVector({})).toBeNull();
  });
});

describe("createEmbedRunner", () => {
  const runner = createEmbedRunner();

  it("returns a valid vector on success", async () => {
    const sb = makeSandbox({ output: JSON.stringify(GOOD_VEC) + "\n" });
    const result = await runner.embed("hello world", sb);
    expect(result).toEqual(GOOD_VEC);
  });

  it("passes text via fs.writeFile (not shell args)", async () => {
    const sb = makeSandbox({ output: JSON.stringify(GOOD_VEC) });
    const text = "sensitive memory text";
    await runner.embed(text, sb);
    // Text was written to a temp file, not interpolated into shell args
    expect(sb.written.some((w) => w === text)).toBe(true);
    // The embed script path appears in the command, but the text does not
    expect(sb.commands.some((c) => c.includes(EMBED_SCRIPT_PATH))).toBe(true);
    expect(sb.commands.every((c) => !c.includes(text))).toBe(true);
  });

  it("returns null on non-zero exit code", async () => {
    const sb = makeSandbox({ exitCode: 1, output: JSON.stringify(GOOD_VEC) });
    expect(await runner.embed("hello", sb)).toBeNull();
  });

  it("returns null on malformed JSON output", async () => {
    const sb = makeSandbox({ output: "not json" });
    expect(await runner.embed("hello", sb)).toBeNull();
  });

  it("returns null on wrong dimension output", async () => {
    const sb = makeSandbox({ output: JSON.stringify([1, 2, 3]) });
    expect(await runner.embed("hello", sb)).toBeNull();
  });

  it("returns null on non-finite values in output", async () => {
    const bad = Array.from({ length: EMBED_VECTOR_DIM }, () => 0);
    bad[0] = NaN;
    const sb = makeSandbox({ output: JSON.stringify(bad) });
    // JSON.stringify drops NaN → null, so parsed as null (not a number) → invalid
    expect(await runner.embed("hello", sb)).toBeNull();
  });

  it("returns null when sandbox throws", async () => {
    const sb = makeSandbox({ runError: true });
    expect(await runner.embed("hello", sb)).toBeNull();
  });

  it("returns null on empty text", async () => {
    const sb = makeSandbox({ output: JSON.stringify(GOOD_VEC) });
    expect(await runner.embed("", sb)).toBeNull();
  });

  it("returns null when fs.writeFile throws", async () => {
    const sb = makeSandbox({ fsWriteError: true, output: JSON.stringify(GOOD_VEC) });
    expect(await runner.embed("hello", sb)).toBeNull();
  });
});
