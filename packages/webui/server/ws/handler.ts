import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import type { SessionPool, WSClient } from "../session-pool";

// --- Message types -----------------------------------------------------------

interface SubscribeMsg {
  type: "subscribe";
  sessionId: string;
}

interface UnsubscribeMsg {
  type: "unsubscribe";
  sessionId: string;
}

interface PromptMsg {
  type: "prompt";
  text: string;
  images?: string[];
}

interface AbortMsg {
  type: "abort";
}

interface SwitchSessionMsg {
  type: "switch_session";
  sessionId: string;
}

type ClientMessage = SubscribeMsg | UnsubscribeMsg | PromptMsg | AbortMsg | SwitchSessionMsg;

// --- Client state ------------------------------------------------------------

interface ClientState {
  /** Sessions this client is subscribed to */
  subscriptions: Set<string>;
  /** Currently "active" session for prompt/abort/switch_session */
  activeSession: string | undefined;
}

// --- Handler -----------------------------------------------------------------

/**
 * Attach a WebSocket handler to an HTTP server.
 *
 * Creates a `WebSocketServer({noServer:true})`, listens for `upgrade` events,
 * routes `/ws` upgrades to it, and proxies pi process events to subscribed
 * browser clients.
 *
 * @param httpServer - The Node HTTP server to attach to
 * @param pool       - The SessionPool instance
 * @returns The WebSocketServer (caller may call .close() on it)
 */
export function attachWsHandler(httpServer: Server, pool: SessionPool): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Per-client state
  const clients = new Map<WebSocket, ClientState>();

  // --------------------------------------------------------------------------
  // Forward pool-level events to subscribed WS clients (wrapped in session_event)
  // --------------------------------------------------------------------------
  pool.on("event", ({ sessionId, event }: { sessionId: string; event: unknown }) => {
    for (const [ws, state] of clients) {
      if (state.subscriptions.has(sessionId) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "session_event", sessionId, event }));
      }
    }
  });

  // --------------------------------------------------------------------------
  // HTTP upgrade → WS
  // --------------------------------------------------------------------------
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------
  wss.on("connection", (ws: WebSocket) => {
    clients.set(ws, { subscriptions: new Set(), activeSession: undefined });

    ws.on("close", () => {
      const state = clients.get(ws);
      if (state) {
        for (const sessionId of state.subscriptions) {
          pool.unsubscribe(sessionId, ws as unknown as WSClient);
        }
        clients.delete(ws);
      }
    });

    ws.on("error", () => {
      // Error handling is same as close; cleanup in 'close' event
    });

    // --------------------------------------------------------------------------
    // Message handler
    // --------------------------------------------------------------------------
    ws.on("message", (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        sendError(ws, "Invalid JSON");
        return;
      }

      switch (msg.type) {
        case "subscribe": {
          const { sessionId } = msg;
          if (typeof sessionId !== "string" || !sessionId) {
            sendError(ws, "sessionId is required");
            return;
          }
          const state = clients.get(ws)!;
          state.subscriptions.add(sessionId);
          state.activeSession = sessionId;
          pool.subscribe(sessionId, ws as unknown as WSClient);
          ws.send(JSON.stringify({ type: "subscribed", sessionId }));
          break;
        }

        case "unsubscribe": {
          const { sessionId } = msg;
          if (typeof sessionId !== "string" || !sessionId) {
            sendError(ws, "sessionId is required");
            return;
          }
          const state = clients.get(ws)!;
          state.subscriptions.delete(sessionId);
          if (state.activeSession === sessionId) {
            state.activeSession = undefined;
          }
          pool.unsubscribe(sessionId, ws as unknown as WSClient);
          break;
        }

        case "prompt": {
          const { text, images } = msg;
          if (typeof text !== "string" || !text) {
            sendError(ws, "text is required");
            return;
          }
          const state = clients.get(ws)!;
          const sessionId = state.activeSession;
          if (!sessionId) {
            sendError(ws, "No active session. Use subscribe or switch_session first.");
            return;
          }
          pool
            .prompt(sessionId, text, images)
            .catch((err: Error) => sendError(ws, err.message));
          break;
        }

        case "abort": {
          const state = clients.get(ws)!;
          const sessionId = state.activeSession;
          if (!sessionId) {
            sendError(ws, "No active session to abort.");
            return;
          }
          pool.abort(sessionId);
          break;
        }

        case "switch_session": {
          const { sessionId } = msg;
          if (typeof sessionId !== "string" || !sessionId) {
            sendError(ws, "sessionId is required");
            return;
          }
          const state = clients.get(ws)!;
          // Unsubscribe from current active session
          if (state.activeSession && state.activeSession !== sessionId) {
            pool.unsubscribe(
              state.activeSession,
              ws as unknown as WSClient,
            );
          }
          // Subscribe to new session
          state.subscriptions.add(sessionId);
          state.activeSession = sessionId;
          pool.subscribe(sessionId, ws as unknown as WSClient);
          ws.send(JSON.stringify({ type: "subscribed", sessionId }));
          break;
        }

        default: {
          sendError(ws, `Unknown message type`);
        }
      }
    });
  });

  return wss;
}

// ---------------------------------------------------------------------------
function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}
