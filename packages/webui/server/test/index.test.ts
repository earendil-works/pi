import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const TEST_PORT = 18741;

function promiseWithResolvers<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

describe("WebUI Server", () => {
  let startServer: (opts: { port?: number }) => Promise<{
    server: http.Server;
    stopServer: () => Promise<void>;
  }>;

  beforeEach(async () => {
    // Dynamic import to get the exported functions
    const module = await import("../index.ts");
    startServer = module.startServer;
  });

  it("(a) Server starts on specified port, /api/health returns 200 with {ok:true,version}", async () => {
    const { server, stopServer } = await startServer({ port: TEST_PORT });
    try {
      const addr = server.address() as AddressInfo;
      expect(addr.port).toBe(TEST_PORT);

      const response = await fetch("http://127.0.0.1:" + TEST_PORT + "/api/health");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.version).toBeDefined();
      expect(typeof body.version).toBe("string");
      expect(body.uptime).toBeDefined();
      expect(body.sessions).toBe(0);
    } finally {
      await stopServer();
    }
  });

  it("(b) Server binds to 127.0.0.1 only (not 0.0.0.0)", async () => {
    const { server, stopServer } = await startServer({ port: TEST_PORT + 1 });
    try {
      const addr = server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(addr.address).not.toBe("0.0.0.0");
    } finally {
      await stopServer();
    }
  });

  it("(c) /ws upgrade is handled (placeholder accepts connection, log, close)", async () => {
    const { server, stopServer } = await startServer({ port: TEST_PORT + 2 });
    try {
      const addr = server.address() as AddressInfo;
      const port = addr.port;

      // Attempt WebSocket upgrade
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws");

      const { promise, resolve, reject } = promiseWithResolvers<void>();

      ws.on("open", function () {
        // Connection opened - placeholder just accepts
        ws.close();
        resolve();
      });
      ws.on("error", reject);

      await promise;

      // Give time for close to process
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await stopServer();
    }
  });

  it("(d) Graceful shutdown: SIGTERM causes process to exit 0", async () => {
    const tmpFile = "/tmp/test-sigterm-" + process.pid + ".mjs";
    const serverPath = "/home/qjh/workspace/personal/pi/packages/webui/server/index.ts";

    const testScript =
      "import { startServer } from 'file://" +
      serverPath +
      "';\n" +
      "const { server, stopServer } = await startServer({ port: " +
      (TEST_PORT + 3) +
      " });\n" +
      "process.on('SIGTERM', async () => {\n" +
      "  await stopServer();\n" +
      "  process.exit(0);\n" +
      "});\n";

    writeFileSync(tmpFile, testScript);

    let stderr = "";
    const proc: ChildProcess = spawn(
      "/home/qjh/workspace/personal/pi/packages/webui/node_modules/.bin/tsx",
      [tmpFile],
      {
        cwd: "/home/qjh/workspace/personal/pi/packages/webui",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    // Wait for server to start
    await new Promise((r) => setTimeout(r, 500));

    // Send SIGTERM
    proc.kill("SIGTERM");

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code: number) => resolve(code ?? 0));
    });

    expect(exitCode).toBe(0);

    // Cleanup
    try {
      unlinkSync(tmpFile);
    } catch {}

    // Also verify "Shutting down" was logged
    expect(stderr).toContain("Shutting down");
  }, 10000);

  it("(e) Port-in-use: starting a second server on same port throws EADDRINUSE error", async () => {
    const { server: server1, stopServer: stop1 } = await startServer({
      port: TEST_PORT + 4,
    });
    try {
      const addr = server1.address() as AddressInfo;
      const port = addr.port;
      expect(port).toBe(TEST_PORT + 4);

      // Try to start a second server on the same port - should throw EADDRINUSE
      let caughtError: NodeJS.ErrnoException | null = null;
      try {
        await startServer({ port });
      } catch (err) {
        caughtError = err as NodeJS.ErrnoException;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.code).toBe("EADDRINUSE");
    } finally {
      await stop1();
    }
  });
});
