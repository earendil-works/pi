import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const TEST_PORT = 18761;

// --- Fake SessionPool -------------------------------------------------------
interface FakePool {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  spawnIfNeeded: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  getTitlesSeen: ReturnType<typeof vi.fn>;
  _eventListeners: Map<string, Set<(...args: unknown[]) => void>>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function createFakePool(): FakePool {
  const listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
  const pool: FakePool = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    spawnIfNeeded: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    setSessionName: vi.fn().mockResolvedValue(undefined),
    getTitlesSeen: vi.fn().mockReturnValue(new Set<string>()),
    _eventListeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  } as unknown as FakePool;
  // Use vi.fn().mockImplementation to allow override in specific tests
  (pool as unknown as { on: (...a: unknown[]) => void }).on = vi.fn().mockImplementation(
    (event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
  );
  return pool;
}

// ---------------------------------------------------------------------------
describe("WsHandler", () => {
  let server: Server;
  let wss: WebSocketServer;
  let attachWsHandler: (httpServer: Server, pool: FakePool) => WebSocketServer;

  beforeEach(async () => {
    const mod = await import("../ws/handler");
    attachWsHandler = mod.attachWsHandler;
  });

  afterEach(() => {
    wss?.close();
    server?.close();
  });

  // -------------------------------------------------------------------------
  it("subscribe → emits {type:\"subscribed\",sessionId} to client", async () => {
    const pool = createFakePool();
    pool.subscribe.mockImplementation((_sessionId: string, _client: unknown) => {});

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    const received: unknown[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(received).toContainEqual({ type: "subscribed", sessionId: "s1" });
    expect(pool.subscribe).toHaveBeenCalledWith("s1", expect.anything());

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("prompt → calls pool.prompt with sessionId, text, images", async () => {
    const pool = createFakePool();

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    // Subscribe first so there's an active session
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // Send prompt
    ws.send(JSON.stringify({ type: "prompt", text: "hello world", images: ["img1"] }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(pool.prompt).toHaveBeenCalledWith("s1", "hello world", ["img1"]);

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("prompt without active session → sends error back", async () => {
    const pool = createFakePool();

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    const received: unknown[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));

    // Send prompt without subscribing first
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    expect(received).toContainEqual({ type: "error", message: expect.stringContaining("No active session") });
    expect(pool.prompt).not.toHaveBeenCalled();

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("unsubscribe → calls pool.unsubscribe", async () => {
    const pool = createFakePool();
    pool.unsubscribe.mockImplementation((_s: string, _c: unknown) => {});

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    ws.send(JSON.stringify({ type: "unsubscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    expect(pool.unsubscribe).toHaveBeenCalledWith("s1", expect.anything());

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("abort → calls pool.abort with active session", async () => {
    const pool = createFakePool();

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    ws.send(JSON.stringify({ type: "abort" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    expect(pool.abort).toHaveBeenCalledWith("s1");

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("switch_session → unsubscribes old, subscribes new, sends subscribed", async () => {
    const pool = createFakePool();

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    const received: unknown[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));

    // Subscribe to s1
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // Switch to s2
    ws.send(JSON.stringify({ type: "switch_session", sessionId: "s2" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // Should have unsubscribed from s1
    expect(pool.unsubscribe).toHaveBeenCalledWith("s1", expect.anything());
    // Should have subscribed to s2
    expect(pool.subscribe).toHaveBeenCalledWith("s2", expect.anything());
    // Should have sent subscribed confirmation for s2
    expect(received).toContainEqual({ type: "subscribed", sessionId: "s2" });

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("session pool event → forwarded to subscribed client as session_event", async () => {
    const pool = createFakePool();

    // Capture the listener registered on the pool's "event" emitter
    let eventListener: ((ev: unknown) => void) | null = null;
    pool._eventListeners.set("event", new Set());
    (pool as unknown as { on: (e: string, fn: (...a: unknown[]) => void) => void }).on = (
      event: string,
      fn: (...args: unknown[]) => void,
    ) => {
      if (event === "event") {
        eventListener = fn as (...args: unknown[]) => void;
        pool._eventListeners.get(event)!.add(fn);
      }
    };

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    const received: unknown[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));

    // Simulate pi process stdout event flowing through pool
    const piEvent = { type: "chunk", content: "hello world" };
    // Manually emit the pool "event" - this is what SessionPool does when proc.stdout receives data
    pool._emit("event", { sessionId: "s1", event: piEvent });
    await new Promise<void>((res) => setTimeout(res, 30));

    expect(received).toContainEqual({ type: "session_event", sessionId: "s1", event: piEvent });

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("WS disconnect → removes client from all session subscriptions", async () => {
    const pool = createFakePool();
    const unsubscribedClients: unknown[] = [];
    pool.unsubscribe.mockImplementation((_s: string, client: unknown) => {
      unsubscribedClients.push(client);
    });
    pool.subscribe.mockImplementation((_s: string, client: unknown) => {});

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s2" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    ws.close();
    await new Promise<void>((res) => setTimeout(res, 30));

    // Client should have been unsubscribed from both sessions
    expect(pool.unsubscribe).toHaveBeenCalledTimes(2);

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("non-/ws path → connection is destroyed", async () => {
    const pool = createFakePool();

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/other`);
    const errors: string[] = [];
    ws.on("error", (err) => errors.push(err.message));

    await new Promise<void>((res) => ws.on("close", res));

    // Should have been rejected
    expect(errors.length).toBeGreaterThan(0);

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("setSessionName called once on first prompt", async () => {
    const pool = createFakePool();
    // Track titlesSeen state per session to simulate real behavior:
    // First prompt: size=0 → setSessionName called
    // Second prompt: size>0 → setSessionName NOT called
    const titlesSeenStore = new Map<string, Set<string>>();
    pool.getTitlesSeen.mockImplementation((sessionId: string) => {
      if (!titlesSeenStore.has(sessionId)) titlesSeenStore.set(sessionId, new Set<string>());
      return titlesSeenStore.get(sessionId)!;
    });
    pool.setSessionName.mockImplementation(async (sessionId: string, _name: string) => {
      titlesSeenStore.get(sessionId)?.add(sessionId);
    });

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // First prompt — should trigger setSessionName
    ws.send(JSON.stringify({ type: "prompt", text: "hello world, how are you?" }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(pool.setSessionName).toHaveBeenCalledTimes(1);
    expect(pool.setSessionName).toHaveBeenCalledWith("s1", "hello world, how are you?");

    // Second prompt — setSessionName should NOT be called again
    ws.send(JSON.stringify({ type: "prompt", text: "tell me a joke" }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(pool.setSessionName).toHaveBeenCalledTimes(1);

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("setSessionName uses first 30 chars of first prompt", async () => {
    const pool = createFakePool();
    const titlesSeenStore = new Map<string, Set<string>>();
    pool.getTitlesSeen.mockImplementation((sessionId: string) => {
      if (!titlesSeenStore.has(sessionId)) titlesSeenStore.set(sessionId, new Set<string>());
      return titlesSeenStore.get(sessionId)!;
    });
    pool.setSessionName.mockImplementation(async (sessionId: string, _name: string) => {
      titlesSeenStore.get(sessionId)?.add(sessionId);
    });

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // First prompt is exactly 30 chars — title should be all 30
    const prompt30 = "abcdefghijklmnopqrstuvwxyz1234"; // 30 chars
    ws.send(JSON.stringify({ type: "prompt", text: prompt30 }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(pool.setSessionName).toHaveBeenCalledTimes(1);
    expect(pool.setSessionName).toHaveBeenCalledWith("s1", prompt30);

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("setSessionName handles first prompt with newlines (takes first 30 chars)", async () => {
    const pool = createFakePool();
    const titlesSeenStore = new Map<string, Set<string>>();
    pool.getTitlesSeen.mockImplementation((sessionId: string) => {
      if (!titlesSeenStore.has(sessionId)) titlesSeenStore.set(sessionId, new Set<string>());
      return titlesSeenStore.get(sessionId)!;
    });
    pool.setSessionName.mockImplementation(async (sessionId: string, _name: string) => {
      titlesSeenStore.get(sessionId)?.add(sessionId);
    });

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    // First prompt has newlines
    const promptWithNewlines = "hello\nworld\nfoo\nbar";
    ws.send(JSON.stringify({ type: "prompt", text: promptWithNewlines }));
    await new Promise<void>((res) => setTimeout(res, 50));

    expect(pool.setSessionName).toHaveBeenCalledTimes(1);
    // Should slice to first 30 chars including newlines
    expect(pool.setSessionName).toHaveBeenCalledWith("s1", promptWithNewlines.slice(0, 30));

    ws.close();
  });

  // -------------------------------------------------------------------------
  it("setSessionName skips when getTitlesSeen returns undefined (race)", async () => {
    const pool = createFakePool();
    // Simulate race: session doesn't exist yet
    pool.getTitlesSeen.mockReturnValue(undefined);

    server = createServer();
    wss = attachWsHandler(server, pool as unknown as import("../session-pool").SessionPool);

    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const addr = server.address() as { port: number };

    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise<void>((res) => ws.on("open", res));

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
    await new Promise<void>((res) => setTimeout(res, 30));

    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await new Promise<void>((res) => setTimeout(res, 50));

    // setSessionName should NOT be called because getTitlesSeen returned undefined
    expect(pool.setSessionName).not.toHaveBeenCalled();

    ws.close();
  });
});
