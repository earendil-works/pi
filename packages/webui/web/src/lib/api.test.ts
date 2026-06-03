import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { api, WebSocketClient, Message, Part, ModelsResponse } from "./api";

describe("api", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listSessions", () => {
    it("should call GET /api/sessions", async () => {
      const mockSessions = [
        { id: "1", title: "Session 1", status: "idle", lastActive: "2025-01-01T00:00:00Z", messageCount: 5 },
        { id: "2", title: "Session 2", status: "running", lastActive: "2025-01-02T00:00:00Z", messageCount: 10 },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSessions),
      });

      const result = await api.listSessions();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/sessions",
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
        })
      );
      expect(result).toEqual(mockSessions);
    });
  });

  describe("listCronJobs", () => {
    it("should call GET /api/cron/jobs", async () => {
      const mockJobs = [
        { id: "abc", name: "Morning Email", schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "Send email", enabled: true, last_run: null, created_at: "2025-01-01T00:00:00Z" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockJobs),
      });

      const result = await api.listCronJobs();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/cron/jobs",
        expect.any(Object)
      );
      expect(result).toEqual(mockJobs);
    });
  });

  describe("createCronJob", () => {
    it("should POST to /api/cron/jobs with input body", async () => {
      const input = { name: "Test Job", schedule: { kind: "cron" as const, expr: "0 10 * * *" }, prompt: "Test", enabled: true };
      const created = { id: "new-123", ...input, last_run: null, created_at: "2025-01-01T00:00:00Z" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(created),
      });

      const result = await api.createCronJob(input);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/cron/jobs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(input),
        })
      );
      expect(result).toEqual(created);
    });
  });

  describe("updateCronJob", () => {
    it("should PATCH to /api/cron/jobs/:id", async () => {
      const partial = { enabled: false };
      const updated = { id: "abc", name: "Test", schedule: { kind: "cron" as const, expr: "0 10 * * *" }, prompt: "Test", enabled: false, last_run: null, created_at: "2025-01-01T00:00:00Z" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(updated),
      });

      const result = await api.updateCronJob("abc", partial);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/cron/jobs/abc",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify(partial),
        })
      );
      expect(result).toEqual(updated);
    });
  });

  describe("deleteCronJob", () => {
    it("should DELETE from /api/cron/jobs/:id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(undefined),
      });

      await api.deleteCronJob("abc");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/cron/jobs/abc",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("triggerCronJob", () => {
    it("should POST to /api/cron/jobs/:id/trigger", async () => {
      const triggered = { id: "abc", name: "Test", schedule: { kind: "cron" as const, expr: "0 10 * * *" }, prompt: "Test", enabled: true, last_run: null, created_at: "2025-01-01T00:00:00Z" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(triggered),
      });

      const result = await api.triggerCronJob("abc");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/cron/jobs/abc/trigger",
        expect.objectContaining({ method: "POST" })
      );
      expect(result).toEqual(triggered);
    });
  });

  describe("getMessages", () => {
    it("should call GET /api/sessions/:id/messages", async () => {
      const mockMessages: Message[] = [
        { id: "1", sessionId: "abc", role: "user", parts: [{ type: "text", text: "Hello" }], timestamp: "2025-01-01T00:00:00Z" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMessages),
      });

      const result = await api.getMessages("abc");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/sessions/abc/messages",
        expect.any(Object)
      );
      expect(result).toEqual(mockMessages);
    });

    it("should include limit and offset params when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await api.getMessages("abc", { limit: 10, offset: 20 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/sessions/abc/messages?limit=10&offset=20",
        expect.any(Object)
      );
    });
  });

  describe("getModels", () => {
    it("should call GET /api/models", async () => {
      const mockResponse: ModelsResponse = {
        providers: [
          { name: "openai", models: [{ id: "gpt-4", name: "GPT-4" }] },
        ],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await api.getModels();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/models",
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
        })
      );
      expect(result).toEqual(mockResponse);
      expect(result.providers[0].models[0].id).toBe("gpt-4");
    });
  });

  describe("getSettings", () => {
    it("should call GET /api/settings", async () => {
      const mockSettings = { theme: "dark", defaultModel: { provider: "openai", model: "gpt-4" } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSettings),
      });

      const result = await api.getSettings();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/settings",
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
        })
      );
      expect(result).toEqual(mockSettings);
    });
  });

  describe("setDefaultModel", () => {
    it("should call PATCH /api/settings with webui.defaultModel string", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(undefined),
      });

      await api.setDefaultModel({ provider: "anthropic", model: "claude-3" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ webui: { defaultModel: "anthropic/claude-3" } }),
        })
      );
    });
  });

  describe("Message.parts type", () => {
    it("should accept text part", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        timestamp: "2025-01-01T00:00:00Z",
      };
      expect(msg.parts[0].type).toBe("text");
    });

    it("should accept thinking part", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "thinking", text: "let me think" }],
        timestamp: "2025-01-01T00:00:00Z",
      };
      expect(msg.parts[0].type).toBe("thinking");
    });

    it("should accept toolCall part", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "toolCall", id: "call-1", name: "bash", args: { cmd: "ls" } }],
        timestamp: "2025-01-01T00:00:00Z",
      };
      expect(msg.parts[0].type).toBe("toolCall");
    });

    it("should accept toolResult part", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "toolResult",
        parts: [{ type: "toolResult", toolCallId: "call-1", content: "file1.txt" }],
        timestamp: "2025-01-01T00:00:00Z",
      };
      expect(msg.parts[0].type).toBe("toolResult");
    });

    it("should accept image part", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "image", mediaType: "image/png", data: "base64..." }],
        timestamp: "2025-01-01T00:00:00Z",
      };
      expect(msg.parts[0].type).toBe("image");
    });

    it("should accept usage and model fields", () => {
      const msg: Message = {
        id: "1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        timestamp: "2025-01-01T00:00:00Z",
        usage: { input: 100, output: 200 },
        model: "gpt-4",
      };
      expect(msg.usage?.input).toBe(100);
      expect(msg.model).toBe("gpt-4");
    });
  });

  describe("Part union type", () => {
    it("should have all required variants", () => {
      const parts: Part[] = [
        { type: "text", text: "hello" },
        { type: "thinking", text: "thinking..." },
        { type: "toolCall", id: "c1", name: "bash", args: {} },
        { type: "toolResult", toolCallId: "c1", content: "result" },
        { type: "image", mediaType: "image/png", data: "base64" },
      ];
      expect(parts.length).toBe(5);
    });
  });

  describe("deleteSession", () => {
    it("should DELETE /api/sessions/:id", async () => {
      const result = { ok: true, atomsExtracted: 5 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(result),
      });

      const res = await api.deleteSession("abc");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8741/api/sessions/abc",
        expect.objectContaining({ method: "DELETE" })
      );
      expect(res).toEqual(result);
    });
  });

  describe("error handling", () => {
    it("should throw on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(api.listSessions()).rejects.toThrow("HTTP 500: Internal Server Error");
    });

    it("should attach status code to error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      try {
        await api.listSessions();
        expect.fail("should have thrown");
      } catch (e: unknown) {
        expect((e as { status: number }).status).toBe(404);
      }
    });
  });
});

describe("WebSocketClient", () => {
  // Store the original WebSocket
  const OriginalWebSocket = global.WebSocket;

  // Mock WebSocket instance
  let mockWsInstance: {
    addEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    readyState: number;
  };
  let addEventListenerMock: ReturnType<typeof vi.fn>;
  let closeMock: ReturnType<typeof vi.fn>;
  let sendMock: ReturnType<typeof vi.fn>;
  let wsConstructorUrl: string | null = null;

  // Create a mock WebSocket class
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    url: string;
    readyState: number;
    addEventListener: typeof addEventListenerMock;
    close: typeof closeMock;
    send: typeof sendMock;

    constructor(url: string) {
      wsConstructorUrl = url;
      this.url = url;
      this.readyState = 1; // OPEN
      this.addEventListener = addEventListenerMock;
      this.close = closeMock;
      this.send = sendMock;
    }
  }

  beforeEach(() => {
    addEventListenerMock = vi.fn();
    closeMock = vi.fn();
    sendMock = vi.fn();
    wsConstructorUrl = null;

    mockWsInstance = {
      addEventListener: addEventListenerMock,
      close: closeMock,
      send: sendMock,
      readyState: 1, // OPEN
    };

    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    global.WebSocket = OriginalWebSocket;
    vi.restoreAllMocks();
  });

  describe("connect", () => {
    it("should open WebSocket to ws://127.0.0.1:8741/ws", () => {
      const ws = new WebSocketClient();
      ws.connect();

      expect(wsConstructorUrl).toBe("ws://127.0.0.1:8741/ws");
    });

    it("should register message and close listeners", () => {
      const ws = new WebSocketClient();
      ws.connect();

      expect(addEventListenerMock).toHaveBeenCalledWith("open", expect.any(Function));
      expect(addEventListenerMock).toHaveBeenCalledWith("message", expect.any(Function));
      expect(addEventListenerMock).toHaveBeenCalledWith("close", expect.any(Function));
    });
  });

  describe("disconnect", () => {
    it("should close the WebSocket", () => {
      const ws = new WebSocketClient();
      ws.connect();
      ws.disconnect();

      expect(closeMock).toHaveBeenCalled();
    });
  });

  describe("send", () => {
    it("should send JSON stringified message when connected", () => {
      const ws = new WebSocketClient();
      ws.connect();

      ws.send({ type: "prompt", text: "hello" });

      expect(sendMock).toHaveBeenCalledWith(JSON.stringify({ type: "prompt", text: "hello" }));
    });
  });

  describe("subscribe", () => {
    it("should call handler when matching message received", () => {
      const ws = new WebSocketClient();
      ws.connect();

      // Find the message handler
      let messageHandler: (event: { data: string }) => void;
      for (const call of addEventListenerMock.mock.calls) {
        if (call[0] === "message") {
          messageHandler = call[1] as typeof messageHandler;
          break;
        }
      }

      const handler = vi.fn();
      ws.subscribe("session_event", handler);

      // Simulate receiving a message
      messageHandler!({ data: JSON.stringify({ type: "session_event", sessionId: "abc", event: { text: "hello" } }) });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: "session_event", sessionId: "abc", event: { text: "hello" } });
    });

    it("should return unsubscribe function", () => {
      const ws = new WebSocketClient();
      ws.connect();

      // Find the message handler
      let messageHandler: (event: { data: string }) => void;
      for (const call of addEventListenerMock.mock.calls) {
        if (call[0] === "message") {
          messageHandler = call[1] as typeof messageHandler;
          break;
        }
      }

      const handler = vi.fn();
      const unsubscribe = ws.subscribe("session_event", handler);

      // Unsubscribe
      unsubscribe();

      // Simulate message - handler should not be called
      messageHandler!({ data: JSON.stringify({ type: "session_event", sessionId: "abc", event: {} }) });

      expect(handler).not.toHaveBeenCalled();
    });

    it("should support wildcard subscription", () => {
      const ws = new WebSocketClient();
      ws.connect();

      let messageHandler: (event: { data: string }) => void;
      for (const call of addEventListenerMock.mock.calls) {
        if (call[0] === "message") {
          messageHandler = call[1] as typeof messageHandler;
          break;
        }
      }

      const handler = vi.fn();
      ws.subscribe("*", handler);

      messageHandler!({ data: JSON.stringify({ type: "anything", data: "test" }) });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should dispatch 'open' event to subscribers when WS connects", () => {
      const ws = new WebSocketClient();
      ws.connect();

      const openHandler = vi.fn();
      ws.subscribe("open", openHandler);

      // Find the open listener that was registered
      const openListener = addEventListenerMock.mock.calls.find(c => c[0] === "open")?.[1] as ((event: Event) => void) | undefined;
      expect(openListener).toBeDefined();

      // Simulate WS open event
      openListener!(new Event("open"));

      expect(openHandler).toHaveBeenCalledTimes(1);
      expect(openHandler).toHaveBeenCalledWith({ type: "open" });
    });

    it("should dispatch 'open' to wildcard subscribers", () => {
      const ws = new WebSocketClient();
      ws.connect();

      const wildcardHandler = vi.fn();
      ws.subscribe("*", wildcardHandler);

      const openListener = addEventListenerMock.mock.calls.find(c => c[0] === "open")?.[1] as ((event: Event) => void) | undefined;
      openListener!(new Event("open"));

      expect(wildcardHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledWith({ type: "open" });
    });
  });
});
