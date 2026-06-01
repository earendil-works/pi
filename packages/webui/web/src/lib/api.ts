// Types for the API

export interface SessionInfo {
  id: string;
  title: string;
  status: "idle" | "running" | "error";
  lastActive: string; // ISO timestamp
  messageCount: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  last_run: string | null; // ISO timestamp or null if never run
  last_run_status?: "ok" | "error";
  created_at: string; // ISO timestamp
}

export interface CronJobInput {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  atomsExtracted: number;
}

export interface ApiError extends Error {
  status: number;
}

// Helper to determine base URL
function getBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.host) {
    // If served from same origin, use same host
    return `http://${window.location.host}`;
  }
  return "http://127.0.0.1:8741";
}

function getWsUrl(): string {
  if (typeof window !== "undefined" && window.location.host) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }
  return "ws://127.0.0.1:8741/ws";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as ApiError;
    error.status = response.status;
    throw error;
  }

  return response.json() as Promise<T>;
}

// REST API client
export const api = {
  listSessions(): Promise<SessionInfo[]> {
    return request<SessionInfo[]>("/api/sessions");
  },

  listCronJobs(): Promise<CronJob[]> {
    return request<CronJob[]>("/api/cron/jobs");
  },

  createCronJob(input: CronJobInput): Promise<CronJob> {
    return request<CronJob>("/api/cron/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  updateCronJob(id: string, partial: Partial<CronJob>): Promise<CronJob> {
    return request<CronJob>(`/api/cron/jobs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(partial),
    });
  },

  deleteCronJob(id: string): Promise<void> {
    return request<void>(`/api/cron/jobs/${id}`, {
      method: "DELETE",
    });
  },

  triggerCronJob(id: string): Promise<CronJob> {
    return request<CronJob>(`/api/cron/jobs/${id}/trigger`, {
      method: "POST",
    });
  },

  getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const query = params.toString();
    return request<Message[]>(
      `/api/sessions/${sessionId}/messages${query ? `?${query}` : ""}`
    );
  },

  deleteSession(id: string): Promise<DeleteSessionResult> {
    return request<DeleteSessionResult>(`/api/sessions/${id}`, {
      method: "DELETE",
    });
  },

  createSession(initialPrompt: string): Promise<SessionInfo> {
    return request<SessionInfo>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ initialPrompt }),
    });
  },
};

// WebSocket client with auto-reconnect
type MessageHandler = (msg: unknown) => void;
type Unsubscribe = () => void;

interface Subscription {
  type: string;
  handler: MessageHandler;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1_000; // start at 1s
  private maxReconnectDelay = 5_000; // max 5s
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Subscription[] = [];
  private isIntentionallyClosed = false;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.isIntentionallyClosed = false;
    const url = getWsUrl();
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.reconnectDelay = 1_000; // reset on successful connect
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        // Dispatch to all subscriptions matching the message type
        for (const sub of this.subscriptions) {
          if (sub.type === msg.type || sub.type === "*") {
            sub.handler(msg);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.addEventListener("close", () => {
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", () => {
      // Error will always be followed by close, let close handle reconnect
    });
  }

  disconnect(): void {
    this.isIntentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  subscribe(type: string, handler: MessageHandler): Unsubscribe {
    const sub: Subscription = { type, handler };
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx !== -1) this.subscriptions.splice(idx, 1);
    };
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff: 1s, 2s, 4s, 5s (capped)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}

// Singleton WS instance for app-wide use
export const ws = new WebSocketClient();
