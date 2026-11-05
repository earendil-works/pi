import {
  MAX_PROMPT_LENGTH,
  agentDoneMessage,
  interpretModels,
  interpretSession,
  modelToSend,
  assistantMessage,
  formatClock,
  interpretGate,
  levelTone,
  parseNdjson,
  resultLabel,
  validatePrompt,
} from "./lib/decision.js";

/**
 * Chat page for the nlt-pi MVP.
 *
 * What it does: sends each message to POST /api/govern (the ASFDK governance gate) and shows the verdict.
 * What it does not do: call a model, run a tool, sign anyone in, or save anything. Conversations live in
 * memory for this tab only. User text is only ever written with textContent.
 */

const REQUEST_TIMEOUT_MS = 20000;
const SPARK_POINTS = 20;

const $ = (id) => document.getElementById(id);
const els = {
  log: $("log"),
  form: $("composer"),
  prompt: $("prompt"),
  send: $("send"),
  counter: $("counter"),
  chips: document.querySelectorAll(".chip"),
  newChat: $("new-chat"),
  sessionList: $("session-list"),
  title: $("chat-title"),
  healthDot: $("health-dot"),
  healthLabel: $("health-label"),
  governanceSummary: $("governance-summary"),
  activityDot: $("activity-dot"),
  currentTask: $("current-task"),
  modelSelect: $("model-select"),
  modelNote: $("model-note"),
  activityModel: $("activity-model"),
  lastLatency: $("last-latency"),
  spark: $("spark"),
  govVerification: $("gov-verification"),
  govResult: $("gov-result"),
  govLevel: $("gov-level"),
  govComponents: $("gov-components"),
  govExecution: $("gov-execution"),
  govReason: $("gov-reason"),
  sessionId: $("session-id"),
  sessionStarted: $("session-started"),
  events: $("events"),
  accountAvatar: $("account-avatar"),
  accountLabel: $("account-label"),
  signinLink: $("signin-link"),
  signout: $("signout"),
};

const tabSession = { id: crypto.randomUUID().slice(0, 8), startedAt: new Date() };
/** @type {{ id: number, title: string, startedAt: Date, messages: { role: string, text: string, kind?: string, at: Date }[] }[]} */
const conversations = [];
let active = null;
let pending = false;
const latencies = [];
let eventCount = 0;

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function logEvent(label, tone) {
  if (eventCount === 0) els.events.replaceChildren();
  eventCount += 1;
  const row = el("li");
  const dot = el("span", "dot");
  dot.dataset.state = tone ?? "idle";
  dot.setAttribute("aria-hidden", "true");
  row.append(dot, el("span", "", label), el("span", "t", formatClock(new Date())));
  els.events.prepend(row);
  while (els.events.children.length > 8) els.events.lastChild.remove();
}

function renderMessage(message) {
  const wrap = el("div", `msg ${message.role}`);
  const who = el("span", `who ${message.role === "user" ? "avatar" : "mark-sm"}`, message.role === "user" ? "You" : "");
  who.setAttribute("aria-hidden", "true");
  const body = el("div");
  const speaker = el("span", "sr-only", message.role === "user" ? "You: " : "Assistant: ");
  const bubble = el("div", "bubble", message.text);
  if (message.kind) bubble.dataset.kind = message.kind;
  body.append(speaker, bubble, el("span", "meta", formatClock(message.at)));
  wrap.append(who, body);
  return wrap;
}

/** Full re-render, used only when switching conversations. The live region is off so history is not re-announced. */
function renderLog() {
  els.log.setAttribute("aria-live", "off");
  els.log.replaceChildren(...(active?.messages ?? []).map(renderMessage));
  els.log.scrollTop = els.log.scrollHeight;
  els.log.setAttribute("aria-live", "polite");
}

/** Adds one message without touching the others, so a screen reader announces only the new one. */
function appendMessage(message) {
  els.log.append(renderMessage(message));
  els.log.scrollTop = els.log.scrollHeight;
}

function renderSessions() {
  els.sessionList.replaceChildren(
    ...conversations
      .slice()
      .reverse()
      .map((conversation) => {
        const item = el("li");
        const button = el("button");
        button.type = "button";
        if (conversation === active) button.setAttribute("aria-current", "true");
        button.append(el("span", "name", conversation.title), el("span", "when", formatClock(conversation.startedAt)));
        button.addEventListener("click", () => select(conversation));
        item.append(button);
        return item;
      }),
  );
}

function select(conversation) {
  // Do not switch conversations while a turn is streaming; the in-flight reply belongs to the captured conversation.
  if (pending) return;
  active = conversation;
  els.title.textContent = conversation.title;
  renderLog();
  renderSessions();
}

function newConversation() {
  // Do not switch conversations while a turn is streaming.
  if (pending) return;
  const conversation = {
    id: conversations.length + 1,
    title: "New conversation",
    startedAt: new Date(),
    messages: [
      {
        role: "assistant",
        kind: "info",
        at: new Date(),
        text: "Hello. This is the NLT Coding Agent. Messages are checked by the ASFDK governance gate; agent turns run only when the owner enables them for this deployment. If a turn is unavailable, the page reports the governance check result instead.",
      },
    ],
  };
  conversations.push(conversation);
  select(conversation);
  els.prompt.focus();
}

function drawSpark() {
  const svg = els.spark;
  svg.replaceChildren();
  const base = document.createElementNS("http://www.w3.org/2000/svg", "line");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", "200");
  base.setAttribute("y1", "38");
  base.setAttribute("y2", "38");
  svg.append(base);
  if (latencies.length < 2) {
    svg.setAttribute("aria-label", "Governance check durations: not enough checks yet to draw a trend.");
    return;
  }
  svg.setAttribute(
    "aria-label",
    `Duration of the last ${latencies.length} governance checks in milliseconds: latest ${Math.round(latencies.at(-1))}, fastest ${Math.round(Math.min(...latencies))}, slowest ${Math.round(Math.max(...latencies))}.`,
  );
  const max = Math.max(...latencies, 1);
  const step = 200 / (latencies.length - 1);
  const points = latencies
    .map((value, index) => `${(index * step).toFixed(1)},${(36 - (value / max) * 32).toFixed(1)}`)
    .join(" ");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points);
  svg.append(line);
}

function showGate(view, latencyMs) {
  els.govResult.textContent = resultLabel(view);
  els.govLevel.textContent = view.crisisLevel ?? "—";
  els.govLevel.dataset.tone = levelTone(view.crisisLevel);
  els.govComponents.textContent = view.components.length > 0 ? view.components.join(", ") : "—";
  els.govReason.hidden = !view.reason;
  els.govReason.textContent = view.reason ? `Reason from gate: ${view.reason}` : "";
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    els.lastLatency.textContent = `${Math.round(latencyMs)} ms`;
    latencies.push(latencyMs);
    if (latencies.length > SPARK_POINTS) latencies.shift();
    drawSpark();
  }
}

async function askGate(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/govern", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
  } catch {
    return { networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries the agent route. Returns undefined when the route is off or unreachable (the caller falls back to the
 * gate check). Otherwise streams text into a live bubble and returns once the turn is done.
 */
async function runAgent(prompt, conversation) {
  let response;
  try {
    response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ prompt, model: modelToSend(els.modelSelect.value, loadedModels) }),
    });
  } catch {
    // The turn may have started before the connection failed; report it as an unavailable outcome rather than
    // falling back to the gate check (which would render stale "nothing was run" wording).
    return { text: "The agent could not be reached. The turn may have started, so check the sandbox before retrying.", kind: "unavailable" };
  }
  if (response.status === 404 || !response.body) return undefined;
  if (response.status === 401) {
    return { text: "Sign in with Vercel (top right) to use the agent.", kind: "unavailable" };
  }
  if (!response.ok) {
    return { text: "The agent is unavailable right now.", kind: "unavailable" };
  }
  const reply = { role: "assistant", kind: "allowed", text: "", at: new Date() };
  conversation.messages.push(reply);
  const node = renderMessage(reply);
  const bubble = node.querySelector(".bubble");
  if (conversation === active) {
    els.log.append(node);
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let done;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseNdjson(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "text" && typeof event.delta === "string") {
          reply.text += event.delta;
          bubble.textContent = reply.text;
        } else if (event.type === "tool" && typeof event.name === "string") {
          els.currentTask.textContent = `Running ${event.name}`;
        } else if (event.type === "done") {
          done = event;
        }
      }
      els.log.scrollTop = els.log.scrollHeight;
    }
  } catch {
    // fall through: a stream that ended without a done event is a failure
  }
  const note = agentDoneMessage(done);
  if (note) {
    reply.kind = done?.status === "blocked" ? "blocked" : "unavailable";
    reply.text = reply.text ? `${reply.text}\n\n${note}` : note;
    bubble.textContent = reply.text;
    bubble.dataset.kind = reply.kind;
  }
  return { streamed: true, status: done?.status, done };
}

function setPending(value) {
  pending = value;
  els.send.disabled = value;
  els.activityDot.dataset.state = value ? "busy" : "idle";
  els.currentTask.textContent = value ? "Governance check" : "Idle";
}

/** Handles a submitted prompt: validates it, tries the agent route, falls back to the governance check. */
async function submit(raw) {
  if (pending) return;
  const checked = validatePrompt(raw);
  if (!checked.ok) return;

  const conversation = active;
  const isFirst = conversation.messages.filter((message) => message.role === "user").length === 0;
  const userMessage = { role: "user", text: checked.prompt, at: new Date() };
  conversation.messages.push(userMessage);
  if (isFirst) {
    conversation.title = checked.prompt.length > 28 ? `${checked.prompt.slice(0, 28)}…` : checked.prompt;
    els.title.textContent = conversation.title;
  }
  els.prompt.value = "";
  autosize();
  appendMessage(userMessage);
  renderSessions();

  setPending(true);
  logEvent("Governance check sent", "busy");
  const started = performance.now();
  const agent = await runAgent(checked.prompt, conversation);
  if (agent) {
    setPending(false);
    if (agent.text) {
      const failure = { role: "assistant", kind: agent.kind, text: agent.text, at: new Date() };
      conversation.messages.push(failure);
      if (conversation === active) appendMessage(failure);
    }
    if (agent.done?.status === "completed" && typeof agent.done.model === "string") els.activityModel.textContent = agent.done.model;
    logEvent(`Agent turn: ${agent.status ?? "ended"}`, agent.status === "completed" ? "online" : "idle");
    // Refresh the governance card from the turn's final outcome.
    if (agent.done?.status === "blocked") {
      showGate(
        {
          kind: "blocked",
          components: [],
          reason: agent.done.reason,
          crisisLevel: agent.done.crisisLevel,
          failClosed: false,
        },
        performance.now() - started,
      );
    } else if (agent.done?.status === "completed" || agent.done?.status === "no_free_model") {
      showGate({ kind: "allowed", components: [], failClosed: false }, NaN);
    } else if (agent.done?.status) {
      showGate({ kind: "unavailable", components: [], failClosed: true }, NaN);
    }
    els.prompt.focus();
    return;
  }
  const result = await askGate(checked.prompt);
  const elapsed = performance.now() - started;
  const view = interpretGate(result);
  setPending(false);

  const reply = { role: "assistant", kind: view.kind, text: assistantMessage(view), at: new Date() };
  conversation.messages.push(reply);
  showGate(view, elapsed);
  logEvent(
    `Result: ${resultLabel(view)}`,
    view.kind === "allowed" ? "online" : view.kind === "blocked" ? "idle" : "offline",
  );
  if (conversation === active) appendMessage(reply);
  els.prompt.focus();
}

function autosize() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 160)}px`;
  els.counter.textContent = `${els.prompt.value.length} / ${MAX_PROMPT_LENGTH}`;
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(els.prompt.value);
});
els.prompt.addEventListener("input", autosize);
els.prompt.addEventListener("keydown", (event) => {
  // keyCode 229 is how some browsers (Safari) report the Enter that confirms IME text, after isComposing is false.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    submit(els.prompt.value);
  }
});
for (const chip of els.chips) {
  chip.addEventListener("click", () => {
    els.prompt.value = chip.dataset.fill ?? "";
    autosize();
    els.prompt.focus();
  });
}
els.newChat.addEventListener("click", newConversation);

async function loadStatus() {
  try {
    // Each request is judged on its own: a failing /api/status must not change what /api/health said.
    const readJson = (response) => (response.ok ? response.json() : undefined);
    const [healthResult, statusResult] = await Promise.allSettled([
      fetch("/api/health", { headers: { accept: "application/json" } }).then(readJson),
      fetch("/api/status", { headers: { accept: "application/json" } }).then(readJson),
    ]);
    const health = healthResult.status === "fulfilled" ? healthResult.value : undefined;
    const status = statusResult.status === "fulfilled" ? statusResult.value : undefined;
    const online = health?.status === "ok";
    els.healthDot.dataset.state = online ? "online" : "offline";
    els.healthLabel.textContent = online ? "Online" : "Unavailable";
    const verified = status?.governance === "verified";
    const governance = status ? (verified ? "Verified" : "Not verified") : "Unknown";
    els.govVerification.textContent = governance;
    els.governanceSummary.textContent = `ASFDK governance: ${governance}`;
    els.govExecution.textContent = status ? (status.executionEnabled === true ? "Enabled" : "Disabled") : "Unknown";
    logEvent(online ? "Application online" : "Application unavailable", online ? "online" : "offline");
  } catch {
    els.healthDot.dataset.state = "offline";
    els.healthLabel.textContent = "Unavailable";
    els.govVerification.textContent = "Unknown";
    els.governanceSummary.textContent = "ASFDK governance: unknown";
    els.govExecution.textContent = "Unknown";
    logEvent("Status unavailable", "offline");
  }
}

els.sessionId.textContent = tabSession.id;
els.sessionStarted.textContent = formatClock(tabSession.startedAt);
drawSpark();
autosize();
newConversation();
loadStatus();

/** Shows who is signed in, or the sign-in link. The server decides; this only displays. */
async function loadSession() {
  let result;
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    result = { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    result = { networkError: true };
  }
  const view = interpretSession(result);
  els.accountLabel.textContent = view.label;
  els.accountAvatar.textContent = view.state === "signed-in" ? view.label.slice(-1).toUpperCase() : "?";
  els.signinLink.hidden = view.state !== "signed-out";
  els.signout.hidden = view.state !== "signed-in";
  if (new URLSearchParams(location.search).get("signin") === "failed") {
    els.accountLabel.textContent = "Sign-in failed, or this Vercel account is not allowed";
  }
}

els.signout.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  await loadSession();
});
loadSession();

/** Models from the last successful /api/models call. Held in memory only. */
let loadedModels = [];

/** Fills the model selector with the free models the server lists. Any failure leaves it on automatic. */
async function loadModels() {
  let result;
  try {
    const response = await fetch("/api/models", { headers: { accept: "application/json" } });
    result = { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    result = { networkError: true };
  }
  const view = interpretModels(result);
  loadedModels = view.models;
  const previous = els.modelSelect.value;
  els.modelSelect.replaceChildren(new Option("Auto (best free)", ""));
  for (const model of view.models) els.modelSelect.append(new Option(model.label, model.id));
  els.modelSelect.value = modelToSend(previous, view.models) ?? "";
  els.modelSelect.disabled = view.state !== "ready";
  els.modelNote.textContent =
    view.state === "ready"
      ? `${view.models.length} free model${view.models.length === 1 ? "" : "s"} available`
      : view.state === "empty"
        ? "No free models listed right now"
        : "Model list unavailable; using automatic choice";
}
loadModels();
