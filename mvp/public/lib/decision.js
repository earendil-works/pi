/**
 * Pure helpers for the chat page. No DOM access, so they can be unit-tested with node:test.
 *
 * The page never decides anything about safety. It only describes what POST /api/govern (the ASFDK
 * governance gate) returned. Anything that is not an unambiguous "allowed: true" is treated as not allowed.
 */

export const MAX_PROMPT_LENGTH = 2000;

/** Crisis levels the foundation reports, mapped to a display tone. Unknown levels stay neutral. */
const LEVEL_TONES = {
  stable: "ok",
  elevated: "warn",
  high: "alert",
  critical: "alert",
  emergency: "alert",
};

/** Maps a foundation crisis level to a display tone; unknown levels stay neutral. */
export function levelTone(level) {
  if (typeof level !== "string") return "neutral";
  const key = level.toLowerCase();
  // Own keys only: names such as "constructor" or "__proto__" must not resolve to inherited values.
  return Object.hasOwn(LEVEL_TONES, key) ? LEVEL_TONES[key] : "neutral";
}

/** Reads a non-empty string, or undefined. */
function text(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Turns a gate response into what the page shows.
 *
 * @param {{ status?: number, body?: unknown, networkError?: boolean }} result
 * @returns {{
 *   kind: "allowed" | "blocked" | "unavailable" | "not-deployed" | "invalid",
 *   crisisLevel?: string,
 *   components: string[],
 *   reason?: string,
 *   failClosed: boolean,
 * }}
 */
export function interpretGate(result) {
  const { status, body, networkError } = result ?? {};
  const unavailable = { kind: "unavailable", components: [], failClosed: true };

  if (networkError || typeof status !== "number") return unavailable;
  // The endpoint answers 404 on production deployments. That is "not available here", not a verdict.
  if (status === 404) return { kind: "not-deployed", components: [], failClosed: true };
  if (status === 400) return { kind: "invalid", components: [], failClosed: true };

  const data = body !== null && typeof body === "object" ? body : {};
  // 503 is the gate saying it could not assess. It is never a pass, even if a body claims otherwise.
  if (status !== 200) return { ...unavailable, reason: text(data.blockedReason) };

  const components = Array.isArray(data.componentsInvolved)
    ? data.componentsInvolved.filter((item) => typeof item === "string")
    : [];
  const crisisLevel = text(data.crisisLevel);
  const reason = text(data.blockedReason);

  // Only a literal boolean true passes. A missing or malformed field fails closed.
  if (data.allowed === true) return { kind: "allowed", crisisLevel, components, reason, failClosed: false };
  if (data.allowed === false) return { kind: "blocked", crisisLevel, components, reason, failClosed: false };
  return { ...unavailable, reason };
}

/**
 * The chat bubble for a result. Wording is deliberately calm and does not assume the person is in crisis:
 * the gate can also flag a message that only mentions a topic. Copy here needs owner / clinician review.
 */
export function assistantMessage(view) {
  switch (view.kind) {
    case "allowed":
      return "This message passed the governance check. No model is connected to this preview yet, so there is nothing to answer with. Nothing was run.";
    case "blocked":
      return [
        "The governance check flagged this message, so it was not passed on.",
        "It can flag a message that only mentions a sensitive topic, so this is not a judgement about you.",
        "If you are in immediate danger, contact your local emergency services. In the US you can call or text 988.",
      ].join(" ");
    case "not-deployed":
      return "The governance check is not available on this deployment, so nothing was sent on.";
    case "invalid":
      return "That message could not be checked. Try a shorter, non-empty message.";
    default:
      return "The governance check could not run, so nothing was sent on. Please try again.";
  }
}

/** Short label for the "last gate result" row. */
export function resultLabel(view) {
  switch (view.kind) {
    case "allowed":
      return "Allowed";
    case "blocked":
      return "Blocked";
    case "not-deployed":
      return "Not available here";
    case "invalid":
      return "Rejected input";
    default:
      return "Unavailable (fail closed)";
  }
}

/** Clock text such as "10:27 AM" in the viewer's locale. */
export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Trims the input and checks it against the limits the endpoint enforces. */
export function validatePrompt(raw) {
  const prompt = typeof raw === "string" ? raw.trim() : "";
  if (prompt.length === 0) return { ok: false, reason: "empty" };
  if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, prompt };
}

/**
 * Splits streamed NDJSON text into complete events. Returns the parsed events and the unfinished remainder.
 * Lines that are not valid JSON objects with a string `type` are dropped, never trusted.
 *
 * @param {string} buffer
 * @returns {{ events: { type: string, [key: string]: unknown }[], rest: string }}
 */
export function parseNdjson(buffer) {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object" && typeof value.type === "string") events.push(value);
    } catch {
      // ignore a malformed line
    }
  }
  return { events, rest };
}

/** What to tell the user for a finished agent turn. Anything but an explicit completed status is not a success. */
export function agentDoneMessage(event) {
  if (event?.status === "completed") return undefined;
  if (event?.status === "blocked") return "The governance gate stopped this message. Please talk to a person you trust.";
  if (event?.status === "busy") return "The agent is busy with another turn. Try again in a moment.";
  if (event?.status === "no_free_model") return "No free model is available right now.";
  if (event?.status === "timed_out") return "The turn ran out of time.";
  return "The agent could not finish this turn.";
}

/**
 * What the header shows for the sign-in state. Only an explicit `signedIn: true` counts as signed in.
 *
 * @param {{ status?: number, body?: unknown, networkError?: boolean }} result
 * @returns {{ state: "signed-in" | "signed-out" | "not-configured" | "unknown", label: string }}
 */
export function interpretSession(result) {
  const { status, body, networkError } = result ?? {};
  if (networkError || status !== 200 || body === null || typeof body !== "object") {
    return { state: "unknown", label: "Sign-in unavailable" };
  }
  if (body.signedIn === true && typeof body.name === "string" && body.name.length > 0) {
    return { state: "signed-in", label: `Signed in as ${body.name}` };
  }
  if (body.configured === false) return { state: "not-configured", label: "Sign-in not set up" };
  return { state: "signed-out", label: "Not signed in" };
}

/** Longest model id the page will send; the server rejects anything longer. */
export const MAX_MODEL_ID_LENGTH = 200;

/**
 * What the model selector shows for a `/api/models` answer. Only a 200 with a list counts; each entry needs a
 * non-empty string id. Anything else leaves the selector on automatic choice.
 *
 * @param {{ status?: number, body?: unknown, networkError?: boolean }} result
 * @returns {{ state: "ready" | "empty" | "unavailable", models: { id: string, label: string }[] }}
 */
export function interpretModels(result) {
  const { status, body, networkError } = result ?? {};
  if (networkError || status !== 200 || body === null || typeof body !== "object" || !Array.isArray(body.models)) {
    return { state: "unavailable", models: [] };
  }
  const seen = new Set();
  const models = [];
  for (const item of body.models) {
    if (item === null || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === "string" && item.name.trim().length > 0 ? item.name.trim() : id;
    models.push({ id, label: name === id ? id : `${name} (${id})` });
  }
  return { state: models.length > 0 ? "ready" : "empty", models };
}

/**
 * The model id to send with a turn: the chosen one only if it is still in the loaded list, otherwise undefined
 * (automatic). The server re-checks it either way.
 *
 * @param {string} selected
 * @param {{ id: string }[]} models
 */
export function modelToSend(selected, models) {
  if (typeof selected !== "string" || selected.length === 0) return undefined;
  return Array.isArray(models) && models.some((model) => model.id === selected) ? selected : undefined;
}
