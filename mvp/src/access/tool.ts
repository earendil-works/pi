/**
 * `request_network_access` tool for the sandboxed agent. Registered only when the feature is enabled,
 * a conversation id is present, DATABASE_URL is set, and egress is not allow-all.
 *
 * The tool records a pending request (owner-scoped, bound to conversation+task hash) and signals the
 * runner to end the turn with `needs_access`. It never grants access; only the signed-in owner can.
 * Hosts are exact hostnames only. The reason is untrusted text (control chars stripped, length capped).
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { normalizeHost, sanitizeReason } from "./host.ts";
import type { AccessStore } from "./store.ts";

export interface AccessRequestRecord {
  id: string;
  host: string;
  reason: string;
}

export interface AccessToolState {
  /** Requests made this turn (max 3). */
  requests: AccessRequestRecord[];
  /** Set when the runner should stop after the tool call. */
  stopRequested: boolean;
}

export interface AccessToolOptions {
  store: AccessStore;
  owner: string;
  conversationId: string;
  /** The prompt of the asking turn (hashed for binding). */
  prompt: string;
  /** Hosts already allowed for this turn (presets + grants + valid resume grants). */
  alreadyAllowed: ReadonlySet<string>;
  state: AccessToolState;
  log: (line: string) => void;
  now?: () => number;
}

const schema = Type.Object({
  host: Type.String({ description: "The exact hostname the agent needs to reach (for example docs.example.com). No scheme, port, path, or wildcard." }),
  reason: Type.String({ description: "A short explanation of why this site is needed. The owner will see it." }),
});

const MAX_PER_TURN = 3;

export function createRequestNetworkAccessTool(options: AccessToolOptions) {
  return {
    name: "request_network_access",
    label: "Request network access",
    description:
      "If a command fails to connect to a site you need, call this with the site and why. Then stop; the owner will answer.",
    parameters: schema,
    async execute(_toolCallId: string, params: { host: string; reason: string }) {
      if (options.state.requests.length >= MAX_PER_TURN) {
        return {
          content: [{ type: "text" as const, text: "You have already requested access the maximum number of times this turn. Stop and wait for the owner." }],
          details: { error: "limit" },
        };
      }
      const host = normalizeHost(params.host);
      if (!host) {
        return {
          content: [{ type: "text" as const, text: "That is not a valid hostname. Use an exact hostname with no scheme, port, path, wildcard, or IP address." }],
          details: { error: "invalid_host" },
        };
      }
      if (options.alreadyAllowed.has(host)) {
        return {
          content: [{ type: "text" as const, text: `${host} is already allowed for this turn. Try the command again.` }],
          details: { alreadyAllowed: true, host },
        };
      }
      const reason = sanitizeReason(params.reason);
      const id = randomUUID();
      try {
        const created = await options.store.createRequest(options.owner, {
          id,
          conversationId: options.conversationId,
          prompt: options.prompt,
          host,
          reason,
          now: options.now?.() ?? Date.now(),
        });
        if ("error" in created) {
          return {
            content: [{ type: "text" as const, text: "Too many access requests are waiting for an answer. Stop and wait for the owner." }],
            details: { error: created.error },
          };
        }
        const record: AccessRequestRecord = { id: created.id, host, reason };
        options.state.requests.push(record);
        options.state.stopRequested = true;
        options.log(JSON.stringify({ event: "access_request", host, requestId: created.id, conversationId: options.conversationId }));
        return {
          content: [{ type: "text" as const, text: `Requested access to ${host}. Stop now and wait for the owner to answer.` }],
          details: { requested: true, requestId: created.id, host },
        };
      } catch {
        options.log(JSON.stringify({ event: "access_lookup_error", op: "create_request" }));
        return {
          content: [{ type: "text" as const, text: "The access request could not be recorded. Stop and try again later." }],
          details: { error: "store" },
        };
      }
    },
  };
}
