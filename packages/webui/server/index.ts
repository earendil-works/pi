import express from "express";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mountStatic } from "./routes/static";
import { mountHealth } from "./routes/health";
import { mountCronRoutes } from "./routes/cron";
import { mountSessionsRoutes } from "./routes/sessions";
import { CronStore } from "./cron-store";
import { CronWatcher } from "./cron-watcher";
import { SessionPool } from "./session-pool";
import { LLMClient } from "./llm-client";
import { MemoryStore } from "./memory-store";
import { attachWsHandler } from "./ws/handler";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PORT = parseInt(process.env.PI_WEB_PORT || "8741", 10);

export interface ServerDeps {
  sessionPool: SessionPool;
  cronWatcher: CronWatcher;
  llmClient: LLMClient;
  memoryStore: MemoryStore;
  cronStore: CronStore;
}

export function createApp(deps?: Partial<ServerDeps>): { app: express.Express; deps: ServerDeps } {
  const cronStore = deps?.cronStore ?? new CronStore();
  const sessionPool = deps?.sessionPool ?? new SessionPool();
  const llmClient = deps?.llmClient ?? new LLMClient();
  const memoryStore = deps?.memoryStore ?? new MemoryStore();
  const cronWatcher = deps?.cronWatcher ?? new CronWatcher(cronStore.dataPath);

  // Fire-and-forget: start scanning sessions in the background so createApp
  // returns immediately. startServer awaits the same call again to wait for
  // completion before accepting requests.
  void sessionPool.init();
  llmClient.init();
  memoryStore.init();

  const app = express();

  // CORS: loopback-only (http://127.0.0.1:*)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // JSON body parser
  app.use(express.json());

  // Health check endpoint - mounted BEFORE static catch-all
  mountHealth(app);

  // Cron REST API endpoints - mounted BEFORE static catch-all
  mountCronRoutes(app, cronStore);

  // Session REST API endpoints - mounted BEFORE static catch-all
  mountSessionsRoutes(app, sessionPool, { llmClient, memoryStore });

  // Static files (SPA fallback) - mounted LAST as catch-all
  mountStatic(app, join(__dirname, "../web/dist"));

  return { app, deps: { sessionPool, cronWatcher, llmClient, memoryStore, cronStore } };
}

export async function startServer(opts: {
  port?: number;
  deps?: Partial<ServerDeps>;
}): Promise<{ server: Server; stopServer: () => Promise<void> }> {
  const port = opts.port ?? PORT;
  const { app, deps } = createApp(opts.deps);
  // Wait for the background init() started by createApp to finish before
  // accepting requests. Calling again is safe — init() is idempotent in
  // effect (both invocations scan the same sessions dir).
  await deps.sessionPool.init();

  const server = createServer(app);
  const wss = attachWsHandler(server, deps.sessionPool);

  // Wire CronWatcher → WS broadcast: on cron_changed, notify all WS clients
  deps.cronWatcher.subscribe((event) => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
      }
    }
  });
  deps.cronWatcher.start();

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          "Error: port " + port + " in use, try --port <other>"
        );
        reject(err);
        return;
      }
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      console.error("WebUI running at http://127.0.0.1:" + port);
      resolve({
        server,
        stopServer: async () => {
          console.error("Shutting down");
          deps.cronWatcher.stop();
          deps.memoryStore.close();
          deps.sessionPool.cleanupOnExit();
          await new Promise<void>((res) => {
            wss.close();
            server.close(() => res());
          });
        },
      });
    });
  });
}

// CLI mode
if (import.meta.url === "file://" + process.argv[1]) {
  const port = parseInt(process.env.PI_WEB_PORT || String(PORT), 10);

  startServer({ port })
    .then(({ stopServer }) => {
      const shutdown = async (signal: string) => {
        console.error("Shutting down");
        await stopServer();
        process.exit(0);
      };

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.exit(1);
      }
      throw err;
    });
}
