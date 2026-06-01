import express from "express";
import { createServer, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import { mountStatic } from "./routes/static";
import { mountHealth } from "./routes/health";
import { mountCronRoutes } from "./routes/cron";
import { CronStore } from "./cron-store";

const PORT = parseInt(process.env.PI_WEB_PORT || "8741", 10);
const MAX_SESSIONS = parseInt(process.env.PI_WEB_MAX_SESSIONS || "16", 10);

export function createApp(): express.Express {
  const app = express();

  // Cron store singleton (used by cron routes)
  const cronStore = new CronStore();

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

  // Static files (SPA fallback) - mounted LAST as catch-all
  mountStatic(app, join(__dirname, "../web/dist"));

  return app;
}

export async function startServer(opts: {
  port?: number;
}): Promise<{ server: Server; stopServer: () => Promise<void> }> {
  const port = opts.port ?? PORT;
  const app = createApp();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade on /ws path
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://127.0.0.1");
    if (url.pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Placeholder: accept connection, log, close
        console.error("[WebSocket] Client connected");
        ws.on("close", () => {
          console.error("[WebSocket] Client disconnected");
        });
        ws.close();
      });
    } else {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          "Error: port " + port + " in use, try --port <other>"
        );
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      console.error("WebUI running at http://127.0.0.1:" + port);
      resolve({
        server,
        stopServer: async () => {
          console.error("Shutting down");
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

  startServer({ port }).then(({ stopServer }) => {
    const shutdown = async (signal: string) => {
      console.error("Shutting down");
      await stopServer();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}
