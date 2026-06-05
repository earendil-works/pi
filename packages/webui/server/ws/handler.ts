import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import type { SessionPool, WSClient } from "../session-pool";

/**
 * WebSocket path used by vite's HMR client when vite runs as express
 * middleware in dev mode (PI_WEB_DEV=1). The upgrade handler in this file
 * preserves any upgrade to this path so vite's own listener can respond;
 * see the comment in the `upgrade` handler below.
 */
export const VITE_HMR_PATH = "/__vite_hmr";

// --- Message types -----------------------------------------------------------

interface SubscribeMsg {
  type: "subscribe";
  sessionId: string;
}

interface UnsubscribeMsg {
  type: "unsubscribe";
  sessionId: string;
}

interface ImageObject {
  mediaType: string;
  data: string;
}

interface PromptMsg {
  type: "prompt";
  text: string;
  images?: ImageObject[];
  // Client may include the target sessionId. We use it as the source of
  // truth for routing, falling back to the active session set by the most
  // recent subscribe. Without this, a prompt that races ahead of subscribe
  // (because the singleton WS was already open when the page mounted) gets
  // dropped with "No active session" and the client never knows.
  sessionId?: string;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });

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
    // In dev mode (PI_WEB_DEV=1) the same httpServer is shared with vite's
    // HMR WebSocket. We must not destroy sockets for non-/ws paths here —
    // vite's upgrade listener (registered when we call
    // `createServer({ server: { hmr: { server: httpServer, path: VITE_HMR_PATH } } })`)
    // needs the socket to answer `/__vite_hmr` upgrades. For any path neither
    // we nor vite handles, the socket simply times out client-side; the
    // production server (no vite) destroys nothing in this branch and the
    // only /ws traffic is the only thing that gets upgraded.
    if (url.pathname !== "/ws" && url.pathname !== VITE_HMR_PATH) {
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
    // /__vite_hmr upgrades are claimed by vite's own listener registered on
    // the same httpServer; do not run wss.handleUpgrade for them.
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
          // Validate text: string, length 1-256KB
          if (
            typeof text !== "string" ||
            text.length === 0 ||
            text.length > 256 * 1024
          ) {
            sendError(ws, "invalid prompt");
            return;
          }
          // Validate images: Array<{mediaType: string, data: string}>
          const ALLOWED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
          const MAXIndividual_SIZE = 5 * 1024 * 1024; // 5MB
          const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB
          const MAX_IMAGES = 4;
          if (images !== undefined) {
            if (!Array.isArray(images)) {
              sendError(ws, "invalid prompt");
              return;
            }
            if (images.length > MAX_IMAGES) {
              sendError(ws, "invalid prompt");
              return;
            }
            let totalDataLength = 0;
            for (const img of images) {
              if (typeof img !== "object" || img === null) {
                sendError(ws, "invalid prompt");
                return;
              }
              if (typeof img.mediaType !== "string" || typeof img.data !== "string") {
                sendError(ws, "invalid prompt");
                return;
              }
              if (!ALLOWED_MEDIA_TYPES.has(img.mediaType)) {
                sendError(ws, "invalid prompt");
                return;
              }
              if (img.data.length > MAXIndividual_SIZE) {
                sendError(ws, "invalid prompt");
                return;
              }
              totalDataLength += img.data.length;
              if (totalDataLength > MAX_TOTAL_SIZE) {
                sendError(ws, "invalid prompt");
                return;
              }
            }
          }
          const state = clients.get(ws)!;
          // Prefer the sessionId the client put on the message itself.
          // Fall back to the active session (set by subscribe/switch_session)
          // so older clients still work, and so a stray prompt with the
          // wrong sessionId doesn't end up routed to whatever was last
          // active.
          const sessionId =
            typeof (msg as PromptMsg).sessionId === "string" && (msg as PromptMsg).sessionId
              ? (msg as PromptMsg).sessionId!
              : state.activeSession;
          if (!sessionId) {
            sendError(ws, "No active session. Use subscribe or switch_session first.");
            return;
          }
          pool
            .prompt(sessionId, text, images)
            .catch((err: Error) => sendError(ws, err.message));
          // Set session title from first user message (first 30 chars, RPC set_session_name)
          if (text.trim().length > 0) {
            const titlesSeen = pool.getTitlesSeen(sessionId);
            if (titlesSeen !== undefined && titlesSeen.size === 0) {
              const name = text.slice(0, 30);
              pool
                .setSessionName(sessionId, name)
                .catch((err: Error) => console.error("setSessionName failed:", err));
            }
          }
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
