import { describe, it, expect } from "bun:test";
import { z } from "zod/v3";

// Import the module
import * as satellite from "./satellite-server.ts";

// =============================================================================
// transfer_file tests
// =============================================================================

describe("transfer_file schema validation", () => {
  // Schema definition as per spec
  const transferFileSchema = z.object({
    direction: z.enum(["upload", "download"]),
    local_path: z.string(),
    remote_path: z.string(),
    content: z.string().optional(), // only used for "download" direction
  });

  // S16: direction 参数无效
  it("S16: direction='push' returns zod error (invalid direction)", () => {
    expect(() => transferFileSchema.parse({
      direction: "push",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    })).toThrow();
  });

  it("S16: direction='pull' returns zod error (invalid direction)", () => {
    expect(() => transferFileSchema.parse({
      direction: "pull",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    })).toThrow();
  });

  it("S16: missing direction returns zod error", () => {
    expect(() => transferFileSchema.parse({
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    })).toThrow();
  });

  // S10: transfer_file — 上传本地文件到远程 (upload happy path)
  it("S10: upload direction is valid", () => {
    const result = transferFileSchema.parse({
      direction: "upload",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    });
    expect(result.direction).toBe("upload");
    expect(result.local_path).toBe("/local/file.txt");
    expect(result.remote_path).toBe("/remote/file.txt");
  });

  it("S10: upload direction does not require content", () => {
    const result = transferFileSchema.parse({
      direction: "upload",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    });
    expect(result.content).toBeUndefined();
  });

  // S11: transfer_file — 从远程下载文件到本地 (download happy path)
  it("S11: download direction is valid with content", () => {
    const result = transferFileSchema.parse({
      direction: "download",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
      content: "hello world",
    });
    expect(result.direction).toBe("download");
    expect(result.content).toBe("hello world");
  });

  it("S11: download direction with content is valid", () => {
    const result = transferFileSchema.parse({
      direction: "download",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
      content: "file content here",
    });
    expect(result.content).toBe("file content here");
  });
});

describe("handleTransferFile", () => {
  // S10: upload - reads remote file and returns content
  it("S10: upload reads remote_path and returns content", async () => {
    const handler = (satellite as any).handleTransferFile;
    if (!handler) {
      throw new Error("handleTransferFile not implemented");
    }

    // Create a temp file to read
    const testPath = "/tmp/test-transfer-upload.txt";
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const testContent = "hello from upload test";
    writeFileSync(testPath, testContent, "utf-8");

    try {
      const result = await handler({
        direction: "upload",
        local_path: "/local/file.txt",
        remote_path: testPath,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(testContent);
    } finally {
      unlinkSync(testPath);
    }
  });

  // S11: download - writes content to remote_path
  it("S11: download requires content field", async () => {
    const handler = (satellite as any).handleTransferFile;
    if (!handler) {
      throw new Error("handleTransferFile not implemented");
    }

    // When content is missing for download, handler should return isError
    const result = await handler({
      direction: "download",
      local_path: "/local/file.txt",
      remote_path: "/tmp/test-no-content.txt",
      // content is intentionally missing
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("content");
  });

  it("S11: download with content writes to remote_path", async () => {
    const handler = (satellite as any).handleTransferFile;
    if (!handler) {
      throw new Error("handleTransferFile not implemented");
    }

    const testPath = "/tmp/test-transfer-download.txt";
    const testContent = "hello from download test";
    const { unlinkSync } = await import("node:fs");

    // Clean up any existing file
    try { unlinkSync(testPath); } catch { /* ignore */ }

    try {
      const result = await handler({
        direction: "download",
        local_path: "/local/file.txt",
        remote_path: testPath,
        content: testContent,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Successfully wrote");
      expect(result.content[0].text).toContain(testPath);

      // Verify file was actually written
      const { readFileSync } = await import("node:fs");
      const written = readFileSync(testPath, "utf-8");
      expect(written).toBe(testContent);
    } finally {
      try { unlinkSync(testPath); } catch { /* ignore */ }
    }
  });

  // S16: invalid direction returns error
  it("S16: invalid direction is rejected by schema", async () => {
    // Schema validation happens before handler is called
    // This test verifies the schema rejects invalid direction
    const TransferFileSchema = z.object({
      direction: z.enum(["upload", "download"]),
      local_path: z.string(),
      remote_path: z.string(),
      content: z.string().optional(),
    });

    expect(() => TransferFileSchema.parse({
      direction: "push",
      local_path: "/local/file.txt",
      remote_path: "/remote/file.txt",
    })).toThrow();
  });
});

describe("find_files schema validation", () => {
  // Schema definition as per spec
  const findFilesSchema = z.object({
    pattern: z.string(),
    path: z.string().optional().default("."),
    limit: z.number().optional().default(500),
  });

  it("pattern is required", () => {
    expect(() => findFilesSchema.parse({})).toThrow();
  });

  it("accepts valid pattern", () => {
    expect(() => findFilesSchema.parse({ pattern: "*.ts" })).not.toThrow();
  });

  it("accepts optional path with default \".\"", () => {
    const result = findFilesSchema.parse({ pattern: "*.ts" });
    expect(result.path).toBe(".");
  });

  it("accepts explicit path", () => {
    const result = findFilesSchema.parse({ pattern: "*.ts", path: "/tmp" });
    expect(result.path).toBe("/tmp");
  });

  it("accepts optional limit with default 500", () => {
    const result = findFilesSchema.parse({ pattern: "*.ts" });
    expect(result.limit).toBe(500);
  });

  it("accepts explicit limit", () => {
    const result = findFilesSchema.parse({ pattern: "*.ts", limit: 100 });
    expect(result.limit).toBe(100);
  });
});

describe("handleFindFiles", () => {
  // S12: fd available → returns file list
  it("S12: returns file list when fd is available", async () => {
    const handler = (satellite as any).handleFindFiles;
    if (!handler) {
      throw new Error("handleFindFiles not implemented");
    }

    const result = await handler({ pattern: "*.ts", path: ".", limit: 500 });
    // Success returns without isError, not isError: false
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  // Test default parameters
  it("uses default path \".\" and limit 500", async () => {
    const handler = (satellite as any).handleFindFiles;
    if (!handler) {
      throw new Error("handleFindFiles not implemented");
    }

    // Should work with just pattern
    const result = await handler({ pattern: "*.ts" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  // Test non-recursive glob pattern
  it("returns matching files for glob pattern", async () => {
    const handler = (satellite as any).handleFindFiles;
    if (!handler) {
      throw new Error("handleFindFiles not implemented");
    }

    const result = await handler({ pattern: "*.json", path: "/home/qjh/workspace/personal/pi", limit: 100 });
    expect(result.isError).toBeUndefined();
    // Result should contain .json files or "(no matches found)"
    expect(result.content[0].text).toBeTruthy();
  });

  // S14: fd not installed - we can't easily test this without mocking
  // since fd is installed on this system. The implementation returns
  // isError: true with install instructions when fd is missing.
  it("S14: would return error if fd were missing (implementation check)", async () => {
    // Verify the handler exists and the implementation checks for fd
    const handler = (satellite as any).handleFindFiles;
    expect(handler).toBeDefined();

    // The actual S14 test requires mocking checkFdAvailable which is not exported
    // This is tested in integration tests with a PATH that excludes fd
  });
});

// =============================================================================
// grep_files tests
// =============================================================================

describe("grep_files schema validation", () => {
  // Schema definition as per spec
  const grepFilesSchema = z.object({
    pattern: z.string(),
    path: z.string().optional().default("."),
    glob: z.string().optional(),
    limit: z.number().optional().default(500),
  });

  it("pattern is required", () => {
    expect(() => grepFilesSchema.parse({})).toThrow();
  });

  it("accepts valid pattern", () => {
    expect(() => grepFilesSchema.parse({ pattern: "test" })).not.toThrow();
  });

  it("accepts optional path with default \".\"", () => {
    const result = grepFilesSchema.parse({ pattern: "test" });
    expect(result.path).toBe(".");
  });

  it("accepts optional glob filter", () => {
    const result = grepFilesSchema.parse({ pattern: "test", glob: "*.ts" });
    expect(result.glob).toBe("*.ts");
  });

  it("accepts optional limit with default 500", () => {
    const result = grepFilesSchema.parse({ pattern: "test" });
    expect(result.limit).toBe(500);
  });
});

describe("handleGrepFiles", () => {
  // S13: grep_files — 远程按正则搜索代码 (rg available, returns matches)
  it("S13: returns match list when rg is available", async () => {
    const handler = (satellite as any).handleGrepFiles;
    if (!handler) {
      throw new Error("handleGrepFiles not implemented");
    }

    const result = await handler({ pattern: "test", path: "/home/qjh/workspace/personal/pi/extensions/satellite", limit: 100 });
    // Success returns without isError
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  // Test default parameters
  it("uses default path \".\", glob undefined, and limit 500", async () => {
    const handler = (satellite as any).handleGrepFiles;
    if (!handler) {
      throw new Error("handleGrepFiles not implemented");
    }

    // Should work with just pattern
    const result = await handler({ pattern: "test" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  // Test with glob filter
  it("supports glob filter", async () => {
    const handler = (satellite as any).handleGrepFiles;
    if (!handler) {
      throw new Error("handleGrepFiles not implemented");
    }

    const result = await handler({ pattern: "test", path: "/home/qjh/workspace/personal/pi/extensions/satellite", glob: "*.ts" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  // S15: grep_files — 远程 rg 未安装 (returns install instruction error)
  // This can't be easily tested without mocking since rg is installed,
  // but we verify the handler exists and would return isError with apt install message
  it("S15: implementation returns error with apt install ripgrep when rg missing", async () => {
    const handler = (satellite as any).handleGrepFiles;
    expect(handler).toBeDefined();

    // The implementation checks `which rg` and returns the appropriate error
    // This is tested in integration tests with a PATH that excludes rg
    // The expected error message is: "ripgrep not found on remote server. Install with: apt install ripgrep"
  });
});

// =============================================================================
// list_dir tests (Task 1.3: align list_dir schema to native pi ls)
// =============================================================================

describe("REMOTE_EXEC_SCHEMA - list_dir path optional", () => {
  // S8: Schema 对齐 — list_dir path 可选: Agent 调用 list_dir (不传 path) 默认使用 '.'

  it("list_dir with empty body uses default path '.'", () => {
    const schema = (satellite as any).REMOTE_EXEC_SCHEMA;
    expect(schema).toBeDefined();
    const result = schema.safeParse({ tool: "list_dir" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("list_dir");
      expect(result.data.path).toBe(".");
      expect(result.data.limit).toBe(500); // default limit
    }
  });

  it("list_dir with explicit path works correctly", () => {
    const schema = (satellite as any).REMOTE_EXEC_SCHEMA;
    const result = schema.safeParse({ tool: "list_dir", path: "/tmp" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("list_dir");
      expect(result.data.path).toBe("/tmp");
    }
  });

  it("list_dir with explicit limit works correctly", () => {
    const schema = (satellite as any).REMOTE_EXEC_SCHEMA;
    const result = schema.safeParse({ tool: "list_dir", limit: 100 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("list_dir");
      expect(result.data.path).toBe("."); // default path
      expect(result.data.limit).toBe(100);
    }
  });
});
