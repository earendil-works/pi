import express from "express";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { mountStatic } from "./routes/static";
import { mountHealth } from "./routes/health";
import { mountCronRoutes } from "./routes/cron";
import { mountSessionsRoutes } from "./routes/sessions";
import { mountMemoryRoutes } from "./routes/memory";
import { mountModelsRoutes } from "./routes/models";
import { mountSettingsRoutes } from "./routes/settings";
import { rateLimit } from "./middleware/rate-limit";
import { CronStore } from "./cron-store";
import { CronWatcher } from "./cron-watcher";
import { SessionPool } from "./session-pool";
import { attachWsHandler } from "./ws/handler";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { type PersonalAssistantConfig, DEFAULT_DB_PATH, DEFAULT_ATOMS_DIR } from "@earendil-works/pi-personal-assistant";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PORT = parseInt(process.env.PI_WEB_PORT || "8741", 10);

// Paths
const AGENT_DIR = join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const MODELS_JSON_PATH = join(AGENT_DIR, "models.json");

// Types for models.json
interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, Record<string, unknown>>;
}

interface ModelsJsonConfig {
  providers: Record<string, ProviderConfig>;
}

// Load settings.json
function loadSettings(): PersonalAssistantConfig {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf-8");
      const settings = JSON.parse(raw);
      return (settings?.personalAssistant ?? {}) as PersonalAssistantConfig;
    }
  } catch {
    // ignore
  }
  return {};
}

// Load models.json and find a model by provider + model id
function findModel(provider: string, modelId: string): { model: Model<"openai-completions" | "anthropic-messages" | "openai-responses">; apiKey: string | null; authHeader: string | null } | null {
  try {
    if (!existsSync(MODELS_JSON_PATH)) return null;

    const raw = readFileSync(MODELS_JSON_PATH, "utf-8");
    const config = JSON.parse(raw) as ModelsJsonConfig;

    const providerConfig = config.providers[provider];
    if (!providerConfig) return null;

    const modelDef = providerConfig.models?.find((m) => m.id === modelId);
    if (!modelDef) return null;

    // Build the model object
    const api = (modelDef.api ?? providerConfig.api ?? "openai-completions") as "openai-completions" | "anthropic-messages" | "openai-responses";

    const model: Model<"openai-completions" | "anthropic-messages" | "openai-responses"> = {
      id: modelDef.id,
      name: modelDef.name ?? modelDef.id,
      api,
      provider: provider as any,
      baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl ?? "",
      reasoning: modelDef.reasoning ?? false,
      input: modelDef.input ?? ["text"],
      cost: modelDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: modelDef.contextWindow ?? 4096,
      maxTokens: modelDef.maxTokens ?? 2048,
      headers: { ...providerConfig.headers, ...modelDef.headers },
    };

    // Extract apiKey from provider config (model layer doesn't carry it)
    const apiKey = providerConfig.apiKey ?? null;
    // Anthropic uses x-api-key; OpenAI-compat uses Authorization: Bearer
    const authHeader = api === "anthropic-messages" ? "x-api-key" : "Authorization";

    return { model, apiKey, authHeader };
  } catch {
    return null;
  }
}

// Build the callLlm function based on settings
function buildCallLlm(settings: PersonalAssistantConfig): (prompt: string) => Promise<string> {
  const extractionConfig = settings?.memory?.extraction;
  const provider = extractionConfig?.provider;
  const modelId = extractionConfig?.model;

  if (!provider || !modelId) {
    // No extraction model configured - return a function that throws
    return async () => {
      throw new Error("No memory extraction model configured in settings.json");
    };
  }

  const found = findModel(provider, modelId);
  if (!found) {
    return async () => {
      throw new Error(`Model ${provider}/${modelId} not found in models.json`);
    };
  }
  const { model, apiKey, authHeader } = found;

  // maxTokens budget for the extraction response. Same pattern as
  // /compact (harness/compaction/compaction.ts: `min(0.8 * reserveTokens,
  // model.maxTokens)`): scale with the model's own maxTokens so reasoning
  // models (deepseek-v4-flash 8k, minimax M3 131k) get budget
  // proportional to their capability, while a hard 8192 ceiling stops the
  // worst-case model from being asked to write 100k tokens of JSON. The
  // previous hardcoded 2048 truncated reasoning models mid-think and made
  // them look like "no text content" failures.
  //
  // 8192 covers a generous extraction (40+ atoms with full content +
  // tags) and matches the upper bound pi core uses for /compact summaries.
  // Fallback 4096 if model.maxTokens is missing (custom / local models
  // that don't populate it in models.json).
  const extractionMaxTokens = Math.min(
    model.maxTokens > 0 ? Math.floor(0.8 * model.maxTokens) : 4096,
    8192,
  );

  // Build callLlm using completeSimple
  return async (prompt: string): Promise<string> => {
    const headers: Record<string, string> = { ...(model.headers ?? {}) };
    if (apiKey) {
      headers[authHeader!] = authHeader === "Authorization" ? `Bearer ${apiKey}` : apiKey;
    }
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { apiKey: apiKey ?? undefined, headers, maxTokens: extractionMaxTokens },
    );
    if (!result.content) throw new Error("No content in LLM response");
    // Collect text blocks first, then fall back to thinking blocks.
    // Reasoning models (deepseek-v4-flash) sometimes put the answer in
    // the thinking block with an empty content field when finish_reason
    // hits the maxTokens limit mid-think. The thinking-block fallback
    // strips a leading <think>...</think> prefix so parseExtractionJson
    // sees the trailing JSON.
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const seenTypes: string[] = [];
    for (const c of result.content) {
      seenTypes.push(c.type);
      if (c.type === "text" && "text" in c) {
        textParts.push(c.text);
      } else if (c.type === "thinking" && "thinking" in c) {
        thinkingParts.push(c.thinking);
      }
    }
    if (textParts.length > 0) {
      return textParts.join("");
    }
    if (thinkingParts.length > 0) {
      const raw = thinkingParts.join("");
      const stripped = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
      if (stripped.length > 0) return stripped;
      // Thinking block present but empty after stripping <think> wrappers:
      // dump the first 200 chars of the raw thinking so the log shows what
      // the model actually produced (don't include the full thing — it
      // can be 10k+ tokens of chain-of-thought).
      console.warn(
        `[memory-extract] thinking-block-only response (finishReason=${result.stopReason ?? "unknown"}); ` +
          `raw thinking preview: ${JSON.stringify(raw.slice(0, 200))}`,
      );
      throw new Error(
        "No text content in LLM response (response was a thinking block only; model may have run out of tokens before writing the answer)",
      );
    }
    // Neither text nor thinking blocks. Log the full raw response so we
    // can tell whether this is a content_filter (finish_reason mapped
    // to stopReason=error, content=[]), a network/HTTP error, or some
    // other provider quirk. Truncate each field to keep log size sane.
    const safe = (v: unknown): string => {
      try {
        return JSON.stringify(v).slice(0, 500);
      } catch {
        return String(v).slice(0, 500);
      }
    };
    const r = result as unknown as Record<string, unknown>;
    console.warn(
      `[memory-extract] no usable content ` +
        `(model=${provider}/${modelId}, ` +
        `promptChars=${prompt.length}, ` +
        `maxTokens=${extractionMaxTokens}, ` +
        `stopReason=${result.stopReason ?? "unknown"}, ` +
        `finishReason=${safe(r.finishReason ?? r.finish_reason)}, ` +
        `contentTypes=[${seenTypes.join(",")}], ` +
        `blockCount=${result.content.length}, ` +
        `usage=${safe(r.usage)}, ` +
        `error=${safe(r.error)}, ` +
        `raw=${safe(r)})`,
    );
    throw new Error(`No text content in LLM response (content types: [${seenTypes.join(",")}])`);
  };
}

export interface ServerDeps {
  sessionPool: SessionPool;
  cronWatcher: CronWatcher;
  cronStore: CronStore;
  callLlm: (prompt: string) => Promise<string>;
  settings: PersonalAssistantConfig;
}

export function createApp(deps?: Partial<ServerDeps>): { app: express.Express; deps: ServerDeps } {
  const cronStore = deps?.cronStore ?? new CronStore();
  const sessionPool = deps?.sessionPool ?? new SessionPool();
  const cronWatcher = deps?.cronWatcher ?? new CronWatcher(cronStore.dataPath);

  // Prevent unhandled 'error' from crashing the process when a pi spawn fails.
  // The pool re-emits 'error' from child processes; without a listener this
  // would bubble up to an uncaughtException.
  sessionPool.on("error", (err) => {
    console.error("[session-pool] error:", err);
  });

  // Load settings and build callLlm at startup
  const settings = deps?.settings ?? loadSettings();
  const callLlm = deps?.callLlm ?? buildCallLlm(settings);

  // Fire-and-forget: start scanning sessions in the background so createApp
  // returns immediately. startServer awaits the same call again to wait for
  // completion before accepting requests.
  void sessionPool.init();

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

  // JSON body parser with size limit
  app.use("/api/memory", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "32kb" }));

  // Security headers. In dev mode (PI_WEB_DEV=1) vite injects React
  // Refresh + HMR preamble as inline <script type="module"> blocks in
  // index.html. The strict 'script-src' that protects the production
  // bundle would block those inline scripts, leaving $RefreshReg$
  // undefined and causing every React component to throw "can't detect
  // preamble" on load. Add 'unsafe-inline' to script-src only when
  // dev mode is on — the dev server is loopback-only and never
  // user-content, so this is acceptable.
  const isDev = process.env.PI_WEB_DEV === "1";
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
      },
    },
  }));

  // Health check endpoint - mounted BEFORE static catch-all
  mountHealth(app);

  // Cron REST API endpoints - mounted BEFORE static catch-all
  mountCronRoutes(app, cronStore);

  // Session REST API endpoints - mounted BEFORE static catch-all.
  // dbPath / atomsDir must be passed so DELETE /api/sessions/:id can extract
  // atoms into the same memory.db the rest of the system reads from.
  // Without these, runMemoryExtraction's MemoryIndex constructor throws on
  // dirname(undefined) and the warning "Memory extraction failed, proceeding
  // with deletion" fires silently — losing memories on session delete.
  const dbPath = settings?.memory?.dbPath ?? DEFAULT_DB_PATH;
  const atomsDir = settings?.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;
  mountSessionsRoutes(app, sessionPool, { callLlm, settings, dbPath, atomsDir });

  // Models REST API endpoint - mounted BEFORE static catch-all
  mountModelsRoutes(app);

  // Settings REST API endpoint - mounted BEFORE static catch-all
  mountSettingsRoutes(app);

  // Memory REST API endpoints - mounted BEFORE static catch-all.
  // dbPath / atomsDir resolve to the same default location as the
  // personal-assistant extension's DEFAULT_DB_PATH / DEFAULT_ATOMS_DIR
  // (extensions/personal-assistant/memory.ts). Env-var overrides keep
  // tests and CI off the user's real ~/.pi/agent/memory tree.
  //
  // Rate limiting (Task 5.2, security hardening): PATCH and SSE share
  // the writeLimiter (60/min/IP) because both can be spammed cheaply,
  // and extract gets a tighter extractLimiter (10/min/IP) because it
  // calls an external LLM. Limiters are local-only — the in-memory
  // bucket resets on server restart, which is acceptable for a
  // loopback dev API.
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 60 });
  const extractLimiter = rateLimit({ windowMs: 60_000, max: 10 });
  // searchLimiter (60/min/IP): the filtered search pipeline fans out to
  // 1 ollama rewrite + up to 3 parallel recallAtoms + up to 3 reranks.
  // A loopback-local actor that spams /api/memory/search can starve the
  // shared ollama + bge-m3 services; cap the abuse surface even though
  // the server itself is loopback-only.
  const searchLimiter = rateLimit({ windowMs: 60_000, max: 60 });
  mountMemoryRoutes(
    app,
    {
      dbPath: process.env.PI_MEMORY_DB_PATH ?? join(homedir(), ".pi", "agent", "memory", "memory.db"),
      atomsDir: process.env.PI_MEMORY_ATOMS_DIR ?? join(homedir(), ".pi", "agent", "memory", "atoms"),
      settings,
      callLlm,
    },
    { writeLimiter, extractLimiter, searchLimiter },
  );

  // Static files (SPA fallback) - mounted LAST as catch-all
  // Search for the web build in both dev and bundled contexts. In dev (tsx
  // running webui/server/index.ts), __dirname is webui/server/ and web lives
  // at webui/web/dist. In the esbuild-bundled install layout, __dirname is
  // coding-agent/dist/webui/ and web lives as a sibling at coding-agent/dist/webui/web/.
  //
  // Skipped in dev mode (PI_WEB_DEV=1) — vite's middlewares own every
  // non-/api, non-/ws path so the React app is served with HMR enabled.
  if (process.env.PI_WEB_DEV !== "1") {
    const webDistCandidates = [join(__dirname, "../web/dist"), join(__dirname, "./web")];
    const webDist = webDistCandidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? webDistCandidates[0];
    mountStatic(app, webDist);
  }

  return { app, deps: { sessionPool, cronWatcher, cronStore, callLlm, settings } };
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

  // In dev mode, attach vite as express middleware so the React app is
  // served with HMR on the same port. Vite's HMR WebSocket is wired to the
  // same httpServer at /__vite_hmr — see attachWsHandler in
  // server/ws/handler.ts for the matching path reservation. The dynamic
  // import keeps vite out of the production esbuild bundle (--external:vite
  // in package.json's build:server script). vite is a devDependency of the
  // web app, present in node_modules when running via tsx watch but
  // intentionally absent from the bundled server.bundle.js.
  let viteClose: (() => Promise<void>) | null = null;
  if (process.env.PI_WEB_DEV === "1") {
    const { createServer: createViteServer } = await import(/* @vite-ignore */ "vite");
    const vite = await createViteServer({
      configFile: join(__dirname, "../web/vite.config.ts"),
      root: join(__dirname, "../web"),
      server: {
        middlewareMode: true,
        hmr: { server, path: "/__vite_hmr" },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
    viteClose = async () => {
      await vite.close();
    };
    console.error("[dev] vite middleware attached — HMR enabled");
  }

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
          deps.sessionPool.cleanupOnExit();
          if (viteClose) {
            try { await viteClose(); } catch { /* best effort */ }
          }
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

  // When run via the dev script (scripts/dev-webui.sh) the process is
  // launched from packages/webui/server so tsx's watch scope is limited
  // to the webui source. But the SessionPool needs to spawn pi subprocesses
  // in the user's actual project tree (PI_WEB_CWD, default ~/.pi/agent)
  // so session JSONL files land in the right directory. Switch cwd here
  // before constructing the SessionPool / CronWatcher (both read
  // process.cwd() at construction time).
  const webuiCwd = process.env.PI_WEB_CWD;
  if (webuiCwd && webuiCwd !== process.cwd()) {
    process.chdir(webuiCwd);
  }

  startServer({ port })
    .then(({ stopServer }) => {
      const shutdown = async (signal: string) => {
        console.error("Shutting down");
        await stopServer();
        process.exit(0);
      };

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("uncaughtException", (err) => {
        console.error("[uncaughtException]", err);
      });
      process.on("unhandledRejection", (reason) => {
        console.error("[unhandledRejection]", reason);
      });
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.exit(1);
      }
      throw err;
    });
}
