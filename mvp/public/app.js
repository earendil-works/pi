import {
  MAX_PROMPT_LENGTH,
  assistantMessage,
  formatClock,
  interpretGate,
  levelTone,
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
  active = conversation;
  els.title.textContent = conversation.title;
  renderLog();
  renderSessions();
}

function newConversation() {
  const conversation = {
    id: conversations.length + 1,
    title: "New conversation",
    startedAt: new Date(),
    messages: [
      {
        role: "assistant",
        kind: "info",
        at: new Date(),
        text: "Hello. This is a preview of the NLT Coding Agent. Messages are checked by the ASFDK governance gate; no model is connected yet, so I can’t answer them. You can still try the check.",
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
  els.lastLatency.textContent = `${Math.round(latencyMs)} ms`;
  latencies.push(latencyMs);
  if (latencies.length > SPARK_POINTS) latencies.shift();
  drawSpark();
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

function setPending(value) {
  pending = value;
  els.send.disabled = value;
  els.activityDot.dataset.state = value ? "busy" : "idle";
  els.currentTask.textContent = value ? "Governance check" : "Idle";
}

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
