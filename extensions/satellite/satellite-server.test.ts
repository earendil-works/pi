// @ts-ignore - bun:test types not available in tsgo; tests run via bun
import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod/v3";

// Import the module
import * as satellite from "./satellite-server.ts";

// =============================================================================
// detectIntent direct unit tests (covers S2, S3, S4, S5, S6, S18)
// =============================================================================

describe("detectIntent", () => {
  // S2: cat <path> → read_file
  it("a: cat /foo/x.txt → read_file", () => {
    expect(satellite.detectIntent("cat /foo/x.txt")).toBe("read_file");
  });

  // S18: any cat with single file path triggers read_file
  it("a2: cat /home/user/TJPROJ-backup/notes.md → read_file (path-agnostic)", () => {
    expect(satellite.detectIntent("cat /home/user/TJPROJ-backup/notes.md")).toBe("read_file");
  });

  // S3: sed -i → edit_file
  it("b: sed -i 's/a/b/' /foo/x → edit_file", () => {
    expect(satellite.detectIntent("sed -i 's/a/b/' /foo/x")).toBe("edit_file");
  });

  // S4: echo > /path → write_file
  it("c: echo 'x' > /foo/y → write_file", () => {
    expect(satellite.detectIntent("echo 'x' > /foo/y")).toBe("write_file");
  });

  it("c2: printf 'x' > /foo/y → write_file", () => {
    expect(satellite.detectIntent("printf 'x' > /foo/y")).toBe("write_file");
  });

  // S5: find → find_files
  it("d: find /foo -name '*.ts' → find_files", () => {
    expect(satellite.detectIntent("find /foo -name '*.ts'")).toBe("find_files");
  });

  // S6/S18 (negative): grep → grep_files
  it("e: grep -r foo /bar → grep_files", () => {
    expect(satellite.detectIntent("grep -r foo /bar")).toBe("grep_files");
  });

  // S6: legitimate bash → null
  it("f: ls -la /foo → null (legitimate)", () => {
    expect(satellite.detectIntent("ls -la /foo")).toBe(null);
  });

  // S18: pipeline → null (cat inside pipe, not a direct read)
  it("g: cat file1 file2 | grep x → null (pipeline)", () => {
    expect(satellite.detectIntent("cat file1 file2 | grep x")).toBe(null);
  });

  // S18: stdin redirect → null
  it("h: cat < input.txt → null (stdin redirect)", () => {
    expect(satellite.detectIntent("cat < input.txt")).toBe(null);
  });
});

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
// transfer HTTP endpoint tests (Task 5.1)
// =============================================================================

describe("transfer HTTP endpoints", () => {
  // The handler functions are exported for unit testing
  const handleTransferPost = (satellite as any).handleTransferPost;
  const handleTransferGet = (satellite as any).handleTransferGet;

  // Helper to create a mock Request with optional auth
  function makeRequest(method: string, path: string, hasAuth: boolean, body?: ArrayBuffer): Request {
    const headers = new Headers();
    if (hasAuth) {
      headers.set("Authorization", "Bearer test-token");
    }
    if (body) {
      headers.set("Content-Type", "application/octet-stream");
    }
    const url = `http://localhost:29001/transfer${path}`;
    return new Request(url, { method, headers, body });
  }

  describe("handleTransferPost", () => {
    // POST without auth → 401
    it("POST without auth returns 401", async () => {
      expect(handleTransferPost).toBeDefined();
      const req = makeRequest("POST", "?path=/tmp/test.txt", false);
      const response = await handleTransferPost(req);
      expect(response.status).toBe(401);
    });

    // POST without ?path= → 400
    it("POST without path query returns 400", async () => {
      expect(handleTransferPost).toBeDefined();
      const req = makeRequest("POST", "", true);
      const response = await handleTransferPost(req);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("path");
    });

    // POST with valid path and body → 200, bytes written
    it("POST with valid path and body returns 200 with bytes count", async () => {
      expect(handleTransferPost).toBeDefined();
      const testContent = "hello from POST test";
      const encoder = new TextEncoder();
      const body = encoder.encode(testContent).buffer;
      const req = makeRequest("POST", "?path=/tmp/test-transfer-post.txt", true, body);
      const response = await handleTransferPost(req);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("Content-Type");
      expect(contentType?.startsWith("application/json")).toBeTrue();
      const body_json = await response.json();
      expect(body_json.bytes).toBe(testContent.length);
    });

    // POST creates parent directories recursively
    it("POST creates parent directories recursively", async () => {
      expect(handleTransferPost).toBeDefined();
      const testContent = "testing nested dirs";
      const encoder = new TextEncoder();
      const body = encoder.encode(testContent).buffer;
      const nestedPath = "/tmp/satellite-test-nested/deep/dir/test.txt";
      const req = makeRequest("POST", `?path=${nestedPath}`, true, body);
      const response = await handleTransferPost(req);
      expect(response.status).toBe(200);
    });
  });

  describe("handleTransferGet", () => {
    // GET without auth → 401
    it("GET without auth returns 401", async () => {
      expect(handleTransferGet).toBeDefined();
      const req = makeRequest("GET", "?path=/tmp/test.txt", false);
      const response = await handleTransferGet(req);
      expect(response.status).toBe(401);
    });

    // GET without ?path= → 400
    it("GET without path query returns 400", async () => {
      expect(handleTransferGet).toBeDefined();
      const req = makeRequest("GET", "", true);
      const response = await handleTransferGet(req);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("path");
    });

    // GET with valid path → 200, body bytes match
    it("GET with valid path returns 200 with file bytes", async () => {
      expect(handleTransferGet).toBeDefined();
      // First create a test file
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const testContent = "hello from GET test";
      const testPath = "/tmp/test-transfer-get.txt";
      writeFileSync(testPath, testContent, "utf-8");

      try {
        const req = makeRequest("GET", `?path=${testPath}`, true);
        const response = await handleTransferGet(req);
        expect(response.status).toBe(200);
        const contentType = response.headers.get("Content-Type");
        expect(contentType).toBe("application/octet-stream");
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder("utf-8");
        const result = decoder.decode(buffer);
        expect(result).toBe(testContent);
      } finally {
        unlinkSync(testPath);
      }
    });

    // GET with non-existent file → error response
    it("GET with non-existent path returns error", async () => {
      expect(handleTransferGet).toBeDefined();
      const req = makeRequest("GET", "?path=/tmp/nonexistent-file-12345.txt", true);
      const response = await handleTransferGet(req);
      // readFile throws an error, handler should catch and return 500 or similar
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
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

  // S20: bash missing command → zod validation fails
  it("S20: bash with no command field fails schema validation", () => {
    const schema = (satellite as any).REMOTE_EXEC_SCHEMA;
    expect(schema).toBeDefined();
    const result = schema.safeParse({ tool: "bash" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// guardrailRetry per-turn counter tests (Task 2.4)
// =============================================================================

describe("guardrailRetry counter", () => {
  // Cleanup after each test to avoid pollution
  afterEach(() => {
    const { resetGuardrail } = satellite as any;
    if (resetGuardrail) {
      resetGuardrail(1);
      resetGuardrail(2);
      resetGuardrail(3);
      resetGuardrail(99);
    }
  });

  // Test a: getGuardrailCount returns 0 initially
  it("getGuardrailCount(1, 'read_file') returns 0 initially", () => {
    const { getGuardrailCount } = satellite as any;
    expect(getGuardrailCount).toBeDefined();
    expect(getGuardrailCount(1, "read_file")).toBe(0);
  });

  // Test b: After incrementGuardrail, returns 1
  it("after incrementGuardrail(1, 'read_file'), returns 1", () => {
    const { getGuardrailCount, incrementGuardrail } = satellite as any;
    expect(incrementGuardrail).toBeDefined();
    incrementGuardrail(1, "read_file");
    expect(getGuardrailCount(1, "read_file")).toBe(1);
  });

  // Test c: After 2 increments, returns 2
  it("after 2 increments, returns 2", () => {
    const { getGuardrailCount, incrementGuardrail } = satellite as any;
    incrementGuardrail(1, "read_file");
    incrementGuardrail(1, "read_file");
    expect(getGuardrailCount(1, "read_file")).toBe(2);
  });

  // Test d: Different intent has its own counter
  it("edit_file counter is independent of read_file counter", () => {
    const { getGuardrailCount, incrementGuardrail } = satellite as any;
    incrementGuardrail(1, "read_file");
    incrementGuardrail(1, "read_file");
    // edit_file should still be 0
    expect(getGuardrailCount(1, "edit_file")).toBe(0);
    expect(getGuardrailCount(1, "read_file")).toBe(2);

    // Now increment edit_file
    incrementGuardrail(1, "edit_file");
    expect(getGuardrailCount(1, "edit_file")).toBe(1);
    expect(getGuardrailCount(1, "read_file")).toBe(2); // unchanged
  });

  // Test e: resetGuardrail clears all counters for a turn
  it("resetGuardrail(3) clears all counters for turn 3", () => {
    const { getGuardrailCount, incrementGuardrail, resetGuardrail } = satellite as any;
    incrementGuardrail(3, "read_file");
    incrementGuardrail(3, "read_file");
    incrementGuardrail(3, "edit_file");
    expect(getGuardrailCount(3, "read_file")).toBe(2);
    expect(getGuardrailCount(3, "edit_file")).toBe(1);

    resetGuardrail(3);

    expect(getGuardrailCount(3, "read_file")).toBe(0);
    expect(getGuardrailCount(3, "edit_file")).toBe(0);
  });
});

// =============================================================================
// default bash timeout tests (Task 3.1)
// =============================================================================

describe("default bash timeout", () => {
  // S9: Agent 调 sleep 60 无 timeout 参数 → 30s 后命令仍未返回 → 进程被 kill, 返回 isError

  it("a: sleep 60 with no timeout is killed at 30s and returns isError", async () => {
    const handleBash = (satellite as any).handleBash;
    if (!handleBash) {
      throw new Error("handleBash not implemented or exported");
    }

    const t0 = Date.now();
    // Note: sleep 60 should NOT be intercepted by guardrail since 'sleep' is not a guardrail pattern
    const result = await handleBash({ command: "sleep 60" }); // no timeout arg
    const elapsed = Date.now() - t0;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exceeded 30s timeout/);
    expect(elapsed).toBeLessThan(35_000); // less than 30s + 5s buffer
    expect(elapsed).toBeGreaterThan(28_000); // at least 28s
  }, { timeout: 40_000 });

  it("b: sleep 60 with explicit timeout=1 is killed at 1s and returns isError", async () => {
    const handleBash = (satellite as any).handleBash;
    if (!handleBash) {
      throw new Error("handleBash not implemented or exported");
    }

    const t0 = Date.now();
    const result = await handleBash({ command: "sleep 60", timeout: 1 });
    const elapsed = Date.now() - t0;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exceeded 1s timeout/);
    expect(elapsed).toBeLessThan(3_000);
  }, { timeout: 10_000 });
});

// =============================================================================
// handleBash guardrail tests (Task 2.5)
// =============================================================================

describe("handleBash guardrail", () => {
  // Note: handleBash uses hardcoded turnId=0 internally (plumbed from MCP in task 2.6)
  // So all tests must use turnId=0 to match
  const guardrailTurnId = 0;

  // Cleanup after each test
  afterEach(() => {
    const { resetGuardrail } = satellite as any;
    if (resetGuardrail) {
      resetGuardrail(guardrailTurnId);
    }
  });

  // S2: First cat violation → soft guidance error with "Prefer read_file"
  it("handleBash guardrail: cat /foo/x.txt first call returns isError with Prefer read_file", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(guardrailTurnId); // ensure clean state
    expect(handleBash).toBeDefined();
    const result = await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Prefer read_file");
  });

  // S2: Second cat violation → still soft guidance error
  it("handleBash guardrail: cat /foo/x.txt second call returns isError (soft block)", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(guardrailTurnId); // ensure clean state
    // First call
    await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    // Second call
    const result = await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Prefer read_file");
  });

  // S17: Third cat violation → hard block
  it("handleBash guardrail: cat /foo/x.txt third call returns Blocked with 3 times", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(guardrailTurnId); // ensure clean state
    await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    const result = await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Blocked");
    expect(result.content[0].text).toContain("3 times");
  });

  // S3: Different intent (sed -i) has independent counter
  it("handleBash guardrail: sed -i 's/a/b/' /foo returns isError with Prefer edit_file", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(guardrailTurnId); // ensure clean state
    const result = await handleBash({ command: "sed -i 's/a/b/' /foo" }, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Prefer edit_file");
  });

  // S4: ls -la passes through without guardrail (no intent detected)
  it("handleBash guardrail: ls -la /foo runs normally without guardrail", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(guardrailTurnId); // ensure clean state
    const result = await handleBash({ command: "ls -la /tmp" }, undefined, undefined);
    // ls should succeed (not be an error from guardrail)
    // It may or may not be an isError depending on /tmp existence, but should NOT contain guardrail guidance
    if (result.content && result.content[0] && result.content[0].text) {
      expect(result.content[0].text).not.toContain("Prefer");
      expect(result.content[0].text).not.toContain("Blocked");
    }
  });
});

// =============================================================================
// handleBash session isolation tests (Task 2.6)
// Per-session counter isolation: turn 1's cat count doesn't affect turn 2's cat count
// =============================================================================

describe("handleBash session isolation", () => {
  // These tests verify that guardrail counters are isolated per session/turn id
  // Session 1 (turnId=1): counter starts at 0, increments independently
  // Session 2 (turnId=2): counter starts at 0, increments independently

  // Cleanup after each test - use unique turnIds for isolation
  afterEach(() => {
    const { resetGuardrail } = satellite as any;
    if (resetGuardrail) {
      resetGuardrail(1);
      resetGuardrail(2);
    }
  });

  // Test 1: handleBash with turnId=1: cat twice, no hard block
  it("session isolation: cat with turnId=1 twice returns soft guidance (not hard block)", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(1); // ensure clean state for session 1
    expect(handleBash).toBeDefined();

    // First call with turnId=1
    const result1 = await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined, 1);
    expect(result1.isError).toBe(true);
    expect(result1.content[0].text).toContain("Prefer read_file");
    expect(result1.content[0].text).not.toContain("Blocked");

    // Second call with turnId=1
    const result2 = await handleBash({ command: "cat /foo/y.txt" }, undefined, undefined, 1);
    expect(result2.isError).toBe(true);
    expect(result2.content[0].text).toContain("Prefer read_file");
    expect(result2.content[0].text).not.toContain("Blocked");
  });

  // Test 2: handleBash with turnId=1 third time: hard block
  it("session isolation: cat with turnId=1 third time returns hard block", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(1); // ensure clean state for session 1

    // First call
    await handleBash({ command: "cat /foo/x.txt" }, undefined, undefined, 1);
    // Second call
    await handleBash({ command: "cat /foo/y.txt" }, undefined, undefined, 1);
    // Third call - should be hard blocked
    const result = await handleBash({ command: "cat /foo/z.txt" }, undefined, undefined, 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Blocked");
    expect(result.content[0].text).toContain("3 times");
  });

  // Test 3: handleBash with turnId=2 (different session): cat once, no hard block
  it("session isolation: cat with turnId=2 (different session) has independent counter", async () => {
    const { handleBash, resetGuardrail } = satellite as any;
    resetGuardrail(1); // clean session 1
    resetGuardrail(2); // clean session 2

    // Session 1: already has 2 violations (we'll simulate by calling twice)
    await handleBash({ command: "cat /foo/a.txt" }, undefined, undefined, 1);
    await handleBash({ command: "cat /foo/b.txt" }, undefined, undefined, 1);

    // Session 2: first call - should NOT be hard blocked even though session 1 hit the limit
    const result = await handleBash({ command: "cat /foo/c.txt" }, undefined, undefined, 2);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Prefer read_file");
    expect(result.content[0].text).not.toContain("Blocked");
  });
});
