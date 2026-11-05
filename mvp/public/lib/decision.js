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
