import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Must mock before importing the module under test
const mockSpawn = vi.hoisted(() => vi.fn());
const mockHomedir = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockRmdir = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  rm: mockRmdir,
}));

// Import after mocks are set up
import { spawnPiNewSession, getSessionsDir } from "./new-session";

describe("spawnPiNewSession", () => {
  const tmpBase = "/tmp/pi-new-session-test";
  const fakeSessionsBase = path.join(tmpBase, ".pi", "agent", "sessions");
  const testCwd = "/home/user/project";

  beforeEach(async () => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue(tmpBase);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("");
    mockRmdir.mockResolvedValue(undefined);
    // Ensure PI_SESSIONS_DIR is clean for each test
    delete process.env.PI_SESSIONS_DIR;
  });

  afterEach(async () => {
    // No real fs cleanup needed since we're mocking
    // But ensure PI_SESSIONS_DIR is cleaned up
    delete process.env.PI_SESSIONS_DIR;
  });

  // Helper to build expected sessionsDir for a given cwd
  function expectedSessionsDir(cwd: string): string {
    // Use resolve to match what the implementation does
    const resolved = path.resolve(cwd);
    const encoded = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return path.join(fakeSessionsBase, `--${encoded}--`);
  }

  // -------------------------------------------------------------------------
  // S6: Successful new conversation via pi --new-session
  // -------------------------------------------------------------------------
  describe("S6: pi --new-session success", () => {
    it("spawns pi with correct args and returns sessionId + sessionFile", async () => {
      const fakeSessionId = "abc-123-session";
      let stdoutHandler: ((data: string) => void) | null = null;

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "error") {
              return proc;
            }
            return proc;
          }),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                stdoutHandler = handler;
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() })) as any },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const result = spawnPiNewSession(testCwd);

      // Simulate session_created JSON line arriving on stdout
      await new Promise<void>((resolve) => setTimeout(() => {
        stdoutHandler?.(`{"type":"session_created","sessionId":"${fakeSessionId}"}\n`);
        resolve();
      }, 10));

      // Now trigger exit
      const exitHandler = mockSpawn.mock.calls[0]?.[3]?.on?.mock?.results?.find?.((r: any) => r.value === "exit" || typeof r.value === "function");
      // Simulate the process ending successfully after session created
      await new Promise<void>((resolve) => setTimeout(() => {
        // Find the exit handler and call it
        const procInstance = mockSpawn.mock.results[0].value;
        const exitCb = procInstance.once.mock.calls.find((c: any[]) => c[0] === "exit");
        if (exitCb) {
          (exitCb[1] as (...args: unknown[]) => void)(0);
        }
        resolve();
      }, 10));

      const { sessionId, sessionFile } = await result;

      expect(sessionId).toBe(fakeSessionId);
      expect(sessionFile).toBe(path.join(expectedSessionsDir(testCwd), `${fakeSessionId}.jsonl`));
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledWith(
        "pi",
        ["--mode", "rpc", "--new-session", "--cwd", testCwd],
        expect.objectContaining({ shell: false }),
      );
    });

    it("uses default timeoutMs of 5000 when not specified", async () => {
      const fakeSessionId = "timeout-test-session";

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(0), 20);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                setTimeout(() => handler(`{"type":"session_created","sessionId":"${fakeSessionId}"}\n`), 5);
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() })) as any },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      await spawnPiNewSession(testCwd);

      expect(mockSpawn).toHaveBeenCalledWith(
        "pi",
        ["--mode", "rpc", "--new-session", "--cwd", testCwd],
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it("respects custom timeoutMs option", async () => {
      const fakeSessionId = "custom-timeout-session";

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(0), 20);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                setTimeout(() => handler(`{"type":"session_created","sessionId":"${fakeSessionId}"}\n`), 5);
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() })) as any },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      await spawnPiNewSession(testCwd, { timeoutMs: 10000 });

      expect(mockSpawn).toHaveBeenCalledWith(
        "pi",
        ["--mode", "rpc", "--new-session", "--cwd", testCwd],
        expect.objectContaining({ timeout: 10000 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // S7: pi --new-session fallback to UUID on failure
  // -------------------------------------------------------------------------
  describe("S7: UUID fallback on pi failure", () => {
    it("falls back to UUID on timeout", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              // Never call cb to simulate timeout
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                // Never send session_created to simulate timeout
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() })) as any },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const result = await spawnPiNewSession(testCwd, { timeoutMs: 50 });

      expect(result.sessionId).toBeTruthy();
      expect(result.sessionId).toHaveLength(36); // UUID format
      expect(result.sessionFile).toContain(".jsonl");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        "pi --new-session failed, fallback to UUID:",
        expect.objectContaining({ message: expect.stringContaining("timeout") }),
      );
    });

    it("falls back to UUID on non-zero exit", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10); // non-zero exit
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                // Send no session_created
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() })) as any },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const result = await spawnPiNewSession(testCwd);

      expect(result.sessionId).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        "pi --new-session failed, fallback to UUID:",
        expect.objectContaining({ message: expect.stringContaining("exit") }),
      );
    });

    it("falls back to UUID when pi binary not found", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn((event: string, cb: (err: Error) => void) => {
            if (event === "error") {
              // Simulate ENOENT (pi not found)
              const err = new Error("spawn pi ENOENT");
              (err as any).code = "ENOENT";
              setTimeout(() => cb(err), 10);
              return proc;
            }
            return proc;
          }),
          once: vi.fn(),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const result = await spawnPiNewSession(testCwd);

      expect(result.sessionId).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        "pi --new-session failed, fallback to UUID:",
        expect.objectContaining({ message: expect.stringContaining("ENOENT") }),
      );
    });

    it("falls back to UUID on invalid JSON output", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(0), 10);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn((event: string, handler: (data: string) => void) => {
              if (event === "data") {
                setTimeout(() => handler("not valid json\n"), 10);
              }
              return { off: vi.fn() } as any;
            }),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const result = await spawnPiNewSession(testCwd);

      expect(result.sessionId).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        "pi --new-session failed, fallback to UUID:",
        expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // UUID fallback writes session file
  // -------------------------------------------------------------------------
  describe("UUID fallback writes session file", () => {
    it("writes empty header JSONL to sessionsDir on UUID fallback", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10); // fail immediately
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const { sessionId, sessionFile } = await spawnPiNewSession(testCwd);

      const sessionsDir = expectedSessionsDir(testCwd);
      expect(sessionFile).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));

      // Verify mkdir was called with the correct sessionsDir
      expect(mockMkdir).toHaveBeenCalledWith(sessionsDir, { recursive: true });

      // Verify writeFile was called with correct content
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const writeCall = mockWriteFile.mock.calls[0];
      const [writtenPath, writtenContent] = writeCall;

      expect(writtenPath).toBe(sessionFile);
      const header = JSON.parse(writtenContent.trim());
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);
      expect(header.timestamp).toBeTruthy();
      expect(header.cwd).toBe(testCwd);
    });

    it("uses PI_SESSIONS_DIR env var when set", async () => {
      const customDir = "/custom/sessions/dir";
      process.env.PI_SESSIONS_DIR = customDir;

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const { sessionId, sessionFile } = await spawnPiNewSession(testCwd);

      // sessionsDir should be PI_SESSIONS_DIR/<encoded-cwd>
      const resolved = path.resolve(testCwd);
      const encodedCwd = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
      const expectedDir = path.join(customDir, `--${encodedCwd}--`);
      expect(sessionFile).toBe(path.join(expectedDir, `${sessionId}.jsonl`));

      // Verify mkdir was called with the custom dir
      expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });

      delete process.env.PI_SESSIONS_DIR;
    });
  });

  // -------------------------------------------------------------------------
  // CWD encoding
  // -------------------------------------------------------------------------
  describe("CWD encoding matches pi core", () => {
    it("encodes root cwd correctly", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      const rootCwd = "/";
      const { sessionFile } = await spawnPiNewSession(rootCwd);

      // Root "/" should become "----" (leading / removed, then wrapped)
      const expectedDir = path.join(fakeSessionsBase, "----");
      expect(sessionFile).toContain(expectedDir);
    });

    it("encodes path with colons correctly", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      // This tests the encoding logic for Windows-style paths
      // C:/Users/test after resolve becomes /home/.../C:/Users/test
      const windowsCwd = "/home/qjh/workspace/C:/Users/test";
      const { sessionFile } = await spawnPiNewSession(windowsCwd);

      // After resolve and encoding: remove leading /, replace / \ : with -
      // /home/qjh/workspace/C:/Users/test -> home-qjh-workspace-C--Users-test
      // Note: both : and / are replaced with -, so C:/ becomes C--
      const expectedDir = path.join(fakeSessionsBase, "--home-qjh-workspace-C--Users-test--");
      expect(sessionFile).toContain(expectedDir);
    });

    it("encodes path with backslashes correctly", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockSpawn.mockImplementation(() => {
        const proc = {
          pid: 99999,
          on: vi.fn(),
          once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (event === "exit") {
              setTimeout(() => cb(1), 10);
              return proc;
            }
            return proc;
          }),
          stdout: {
            on: vi.fn(() => ({ off: vi.fn() } as any)),
          },
          stderr: { on: vi.fn(() => ({ off: vi.fn() } as any)) },
          kill: vi.fn(),
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        return proc;
      });

      // Test backslash encoding
      const backslashCwd = "/home/qjh/workspace/network/share/project";
      const { sessionFile } = await spawnPiNewSession(backslashCwd);

      // After resolve and encoding: remove leading /, replace / \ : with -
      const expectedDir = path.join(fakeSessionsBase, "--home-qjh-workspace-network-share-project--");
      expect(sessionFile).toContain(expectedDir);
    });
  });
});
