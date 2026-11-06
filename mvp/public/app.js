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
import { completion, conversationToMarkdown, enterAction, parseSlash, resolveModel, suggestCommands, unquote } from "./lib/commands.js";
import { renderMarkdown } from "./lib/markdown.js";
import { BLOCKED_PLACEHOLDER, HISTORY_NOTICE, createSaver, interpretConversation, interpretHistoryList, shortTitle } from "./lib/history.js";

/**
 * Chat page for the nlt-pi MVP.
 *
 * What it does: sends each message to POST /api/govern (the ASFDK governance gate) and shows the verdict.
 * What it does not do: call a model, run a tool or sign anyone in. Conversations live in memory for this tab,
 * unless the owner turned on saved history (NLT_HISTORY_ENABLED): then each exchange is also saved through
 * /api/conversations, and saved conversations can be reopened and deleted. User text is only ever written with textContent; the model's replies go through lib/markdown.js, which builds DOM nodes
 * and never uses innerHTML.
 */

const REQUEST_TIMEOUT_MS = 20000;
const SPARK_POINTS = 20;

const $ = (id) => document.getElementById(id);
const els = {
  log: $("log"),
  form: $("composer"),
  prompt: $("prompt"),
  picker: $("command-picker"),
  send: $("send"),
  counter: $("counter"),
  chips: document.querySelectorAll(".chip"),
  newChat: $("new-chat"),
  sessionList: $("session-list"),
  sessionFine: $("session-fine"),
  saveNotice: $("save-notice"),
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
  memoriesSection: $("memories-section"),
  memoryList: $("memory-list"),
  memoryFine: $("memory-fine"),
};

const tabSession = { id: crypto.randomUUID().slice(0, 8), startedAt: new Date() };
/**
 * @type {{ id: string, title: string, startedAt: Date, messages: { id?: string, role: string, text: string, kind?: string, at: Date }[],
 *   stored?: boolean, loaded?: boolean, saveState?: "saved" | "unsaved", unsaved?: object[] }[]}
 */
const conversations = [];
/** True only after GET /api/conversations answered 200 for this tab. */
let historyOn = false;
/** True only after GET /api/memories answered 200 for this tab. */
let memoryOn = false;
/** One save at a time per conversation; see lib/history.js. */
const saver = createSaver((body) => historyRequest("POST", { body }));
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

/**
 * Sets a bubble's content. Only the model's own allowed replies are rendered as Markdown (built from DOM nodes,
 * never innerHTML; see lib/markdown.js). The user's text and the page's own notices (blocked, unavailable) stay
 * plain text.
 */
function setBubble(bubble, message) {
  if (message.role === "assistant" && message.kind === "allowed") {
    bubble.classList.add("md");
    bubble.replaceChildren(renderMarkdown(document, message.text));
  } else {
    bubble.classList.remove("md");
    bubble.textContent = message.text;
  }
}

function renderMessage(message) {
  const wrap = el("div", `msg ${message.role}`);
  const who = el("span", `who ${message.role === "user" ? "avatar" : "mark-sm"}`, message.role === "user" ? "You" : "");
  who.setAttribute("aria-hidden", "true");
  const body = el("div");
  const speaker = el("span", "sr-only", message.role === "user" ? "You: " : "Assistant: ");
  const bubble = el("div", "bubble");
  if (message.kind) bubble.dataset.kind = message.kind;
  setBubble(bubble, message);
  body.append(speaker, bubble, el("span", "meta", formatClock(message.at)));
  wrap.append(who, body);
  if (message.role === "user" && message.kind === "normal") {
    const remember = el("button", "remember", "Remember this");
    remember.type = "button";
    remember.setAttribute("aria-label", `Remember this message: ${message.text}`);
    remember.addEventListener("click", () => rememberMessage(message.text, message.id));
    body.append(remember);
  }
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
        if (historyOn && conversation.saveState) {
          button.append(el("span", `save-state ${conversation.saveState}`, conversation.saveState === "saved" ? "Saved" : "Not saved"));
        }
        button.addEventListener("click", () => select(conversation));
        item.append(button);
        if (historyOn && conversation.stored) {
          const remove = el("button", "delete", "✕");
          remove.type = "button";
          remove.setAttribute("aria-label", `Delete conversation: ${conversation.title}`);
          remove.addEventListener("click", () => deleteConversation(conversation));
          item.append(remove);
        }
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
  if (conversation.stored && !conversation.loaded) loadSaved(conversation);
}

function newConversation() {
  // Do not switch conversations while a turn is streaming.
  if (pending) return;
  const conversation = {
    id: crypto.randomUUID(),
    title: "New conversation",
    startedAt: new Date(),
    // Started in this tab, so everything it holds is already here.
    loaded: true,
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
      body: JSON.stringify({ prompt, model: modelToSend(els.modelSelect.value, loadedModels), conversationId: conversation.id }),
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
  const reply = { id: crypto.randomUUID(), role: "assistant", kind: "allowed", text: "", at: new Date() };
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
          setBubble(bubble, reply);
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
    bubble.dataset.kind = reply.kind;
    setBubble(bubble, reply);
  }
  return { streamed: true, status: done?.status, done, access: Array.isArray(done?.access) ? done.access : undefined };
}

function setPending(value) {
  pending = value;
  els.send.disabled = value;
  els.activityDot.dataset.state = value ? "busy" : "idle";
  els.currentTask.textContent = value ? "Governance check" : "Idle";
}

/** Shows a page-only notice. It is not stored in the conversation, not saved, and never sent anywhere. */
function localNotice(text) {
  appendMessage({ role: "assistant", kind: "info", text, at: new Date() });
}

function currentModelLabel() {
  const option = els.modelSelect.selectedOptions[0];
  return option ? option.textContent : "Auto (best free)";
}

/** Runs a page command. Browser-only: no request is made to the gate, the agent or a model, and nothing is saved. */
async function runSlash(parsed) {
  els.prompt.value = "";
  autosize();
  if (parsed.kind === "partial") {
    localNotice(`Unknown command. Did you mean ${parsed.matches.map((command) => `/${command.name}`).join(" or ")}? To send this as a message, start it with //.`);
    return;
  }
  if (parsed.name === "new") {
    if (pending) localNotice("Wait for the current turn to finish before starting a new session.");
    else newConversation();
  } else if (parsed.name === "model") {
    if (parsed.args === "") {
      const names = loadedModels.map((model) => model.label).join(", ");
      localNotice(`Model: ${currentModelLabel()}. ${names ? `Free models listed: ${names}.` : "No model list is available, so the choice is automatic."} Use /model auto or /model <name>.`);
    } else if (els.modelSelect.disabled) {
      localNotice("The model list is not available right now, so the choice stays automatic.");
    } else {
      const choice = resolveModel(parsed.args, loadedModels);
      if (choice.ok) {
        els.modelSelect.value = choice.id;
        localNotice(`Model set to ${currentModelLabel()} for the next messages (this tab only).`);
      } else if (choice.reason === "ambiguous") {
        localNotice(`More than one model matches: ${choice.matches.join(", ")}. Type more of the name.`);
      } else {
        localNotice(`No listed free model matches "${unquote(parsed.args)}". Use /model to see the list.`);
      }
    }
  } else if (parsed.name === "name") {
    const wanted = unquote(parsed.args);
    if (wanted === "") {
      localNotice(`Session name: ${active.title}`);
    } else {
      active.title = shortTitle(wanted, 28);
      active.renamed = true;
      els.title.textContent = active.title;
      renderSessions();
      localNotice(`Session renamed to "${active.title}".`);
    }
  } else if (parsed.name === "session") {
    const sent = active.messages.filter((message) => message.role === "user").length;
    localNotice(
      [
        `Session: ${active.title} (${active.id.slice(0, 8)}), started ${formatClock(active.startedAt)}`,
        `Messages sent: ${sent}`,
        `Sign-in: ${els.accountLabel.textContent}`,
        `ASFDK governance: ${els.govVerification.textContent}`,
        `Agent execution: ${els.govExecution.textContent}`,
        `Model: ${currentModelLabel()}`,
        `Saved history: ${historyOn ? "on" : "off"}. Memory: ${memoryOn ? "on" : "off"}.`,
        `Current task: ${els.currentTask.textContent}`,
      ].join("\n"),
    );
  } else if (parsed.name === "copy") {
    const last = [...active.messages].reverse().find((message) => message.role === "assistant" && message.kind === "allowed");
    if (!last) {
      localNotice("There is no assistant reply to copy yet.");
    } else {
      try {
        await navigator.clipboard.writeText(last.text);
        localNotice("Copied the last assistant message.");
      } catch {
        localNotice("The browser did not allow copying. Select the text and copy it instead.");
      }
    }
  } else if (parsed.name === "export") {
    const blob = new Blob([conversationToMarkdown(active)], { type: "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${active.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "session"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    localNotice("Downloaded this session as Markdown. Review it before sharing: it can contain prompts, command output and file contents.");
  } else if (parsed.name === "reload") {
    await loadModels();
    await loadStatus();
    localNotice("Reloaded the model list and the status shown on this page.");
  }
}

let pickerEntries = [];
let pickerIndex = 0;

/** Picking an entry completes it in the box, like Pi's menu; Enter then runs it. */
function completeEntry(entry) {
  els.prompt.value = completion(entry);
  autosize();
  els.prompt.focus();
}

/** Shows the command menu while the first word after a leading "/" is being typed. */
function renderPicker() {
  pickerEntries = suggestCommands(els.prompt.value);
  pickerIndex = Math.min(pickerIndex, Math.max(0, pickerEntries.length - 1));
  els.picker.hidden = pickerEntries.length === 0;
  els.prompt.setAttribute("aria-expanded", String(pickerEntries.length > 0));
  els.picker.replaceChildren(
    ...pickerEntries.map((entry, index) => {
      const option = el("button", "command-option");
      option.type = "button";
      option.id = `command-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === pickerIndex));
      const head = el("span", "command-head");
      head.append(el("strong", "command-name", `/${entry.name}`), ...(entry.argumentHint ? [el("span", "command-hint", entry.argumentHint)] : []), el("span", "command-source", `(${entry.source})`));
      option.append(head, el("span", "command-desc", entry.description));
      option.addEventListener("click", () => completeEntry(entry));
      return option;
    }),
  );
}

function movePicker(step) {
  if (pickerEntries.length === 0) return;
  pickerIndex = (pickerIndex + step + pickerEntries.length) % pickerEntries.length;
  renderPicker();
  els.picker.children[pickerIndex]?.scrollIntoView({ block: "nearest" });
}

/** Handles a submitted prompt: validates it, tries the agent route, falls back to the governance check. */
async function submit(raw) {
  // Page commands are handled here in the browser and never reach the gate, the agent or a model.
  const slash = parseSlash(raw);
  if (slash.kind === "command" || slash.kind === "partial") {
    runSlash(slash);
    return;
  }
  if (slash.kind === "escaped") raw = slash.text;
  if (pending) return;
  const checked = validatePrompt(raw);
  if (!checked.ok) return;

  const conversation = active;
  // A saved conversation is not ready until its messages have loaded: sending earlier would mix the new exchange with
  // the loading one. Keep the prompt and (re)try the load instead.
  if (conversation.stored && !conversation.loaded) {
    logEvent("Loading the saved conversation first", "busy");
    loadSaved(conversation);
    return;
  }
  const isFirst = conversation.messages.filter((message) => message.role === "user").length === 0;
  const exchangeStart = conversation.messages.length;
  const userMessage = { id: crypto.randomUUID(), role: "user", text: checked.prompt, at: new Date() };
  conversation.messages.push(userMessage);
  // A name chosen with /name is kept; otherwise the first message titles the conversation.
  if (isFirst && !conversation.renamed) {
    conversation.title = shortTitle(checked.prompt, 28);
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
      const failure = { id: crypto.randomUUID(), role: "assistant", kind: agent.kind, text: agent.text, at: new Date() };
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
    } else if (agent.done?.status === "needs_access" && Array.isArray(agent.access)) {
      renderAccessCards(conversation, checked.prompt, agent.access);
      logEvent("Agent requested network access", "idle");
    } else if (agent.done?.status) {
      showGate({ kind: "unavailable", components: [], failClosed: true }, NaN);
    }
    saveExchange(conversation, conversation.messages.slice(exchangeStart));
    els.prompt.focus();
    return;
  }
  const result = await askGate(checked.prompt);
  const elapsed = performance.now() - started;
  const view = interpretGate(result);
  setPending(false);

  const reply = { id: crypto.randomUUID(), role: "assistant", kind: view.kind, text: assistantMessage(view), at: new Date() };
  conversation.messages.push(reply);
  showGate(view, elapsed);
  logEvent(
    `Result: ${resultLabel(view)}`,
    view.kind === "allowed" ? "online" : view.kind === "blocked" ? "idle" : "offline",
  );
  if (conversation === active) appendMessage(reply);
  saveExchange(conversation, conversation.messages.slice(exchangeStart));
  els.prompt.focus();
}

/** GET/POST/DELETE /api/conversations. Never throws: a failure is `{ networkError: true }`. */
async function historyRequest(method, { id, body } = {}) {
  try {
    const response = await fetch(`/api/conversations${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    return { networkError: true };
  }
}

/** Saves a finished exchange (one save at a time per conversation). Chat never waits on it. */
function saveExchange(conversation, exchange) {
  if (!historyOn) return;
  saver.enqueue(conversation, exchange).then(renderSessions);
  renderSessions();
}

/** Loads a saved conversation's messages the first time it is opened. */
async function loadSaved(conversation) {
  if (conversation.loading) return;
  conversation.loading = true;
  const read = interpretConversation(await historyRequest("GET", { id: conversation.id }));
  conversation.loading = false;
  if (!read) {
    // Stays not loaded, so opening it again or sending in it retries the load.
    logEvent("Could not load the saved conversation", "offline");
    return;
  }
  conversation.loaded = true;
  conversation.messages = read.messages.map((m) => ({
    id: m.id,
    role: m.role,
    kind: m.kind === "blocked" ? "blocked" : m.kind === "unavailable" ? "unavailable" : m.role === "assistant" ? "allowed" : undefined,
    text: m.kind === "blocked" && m.text === "" ? BLOCKED_PLACEHOLDER : m.text,
    at: new Date(m.createdAt),
  }));
  if (conversation === active) renderLog();
}

/** Deletes a saved conversation after confirmation; removes it from the sidebar only when the server agreed. */
async function deleteConversation(conversation) {
  if (pending || !window.confirm("Delete this conversation?")) return;
  // Let a save that is still running finish first, so it cannot re-create the conversation after the delete.
  await saver.idle(conversation);
  const result = await historyRequest("DELETE", { id: conversation.id });
  if (result.status !== 200) {
    logEvent("Could not delete the conversation", "offline");
    return;
  }
  conversation.unsaved = [];
  conversations.splice(conversations.indexOf(conversation), 1);
  logEvent("Conversation deleted", "idle");
  if (conversation === active) newConversation();
  else renderSessions();
}

/** Turns saved history on for this tab when the server lists conversations; anything else leaves the page as it was. */
async function loadHistory() {
  const view = interpretHistoryList(await historyRequest("GET"));
  if (view.state !== "on") return;
  historyOn = true;
  els.saveNotice.textContent = HISTORY_NOTICE;
  els.sessionFine.textContent = "Saved until you delete them (✕).";
  // The sidebar shows the array newest-last; the server lists newest-first.
  const saved = view.conversations.map((c) => ({
    id: c.id,
    title: c.title,
    startedAt: new Date(c.updatedAt ?? c.createdAt ?? Date.now()),
    messages: [],
    stored: true,
    loaded: false,
    saveState: "saved",
  }));
  conversations.unshift(...saved.reverse());
  renderSessions();
}

/** GET/POST/DELETE /api/memories. Never throws: a failure is `{ networkError: true }`. */
async function memoryRequest(method, { id, body } = {}) {
  try {
    const response = await fetch(`/api/memories${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch {
    return { networkError: true };
  }
}

/** Loads the owner's memories when memory is on; anything else leaves the page as it was. */
async function loadMemories() {
  const read = await memoryRequest("GET");
  if (!read || read.status !== 200 || !Array.isArray(read.body.memories)) return;
  memoryOn = true;
  els.memoriesSection.hidden = false;
  renderMemories(read.body.memories);
  els.memoryFine.textContent = "Owner-approved facts only. Each turn may recall relevant memories as untrusted background.";
}

function renderMemories(memories) {
  els.memoryList.replaceChildren(
    ...memories.map((m) => {
      const item = el("li", "memory-item");
      item.append(
        el("span", "memory-text", m.text),
        el("span", "memory-bucket", m.bucket),
        el("button", "memory-delete", "✕")
      );
      const deleteButton = item.querySelector(".memory-delete");
      deleteButton.type = "button";
      deleteButton.setAttribute("aria-label", `Delete memory: ${m.text}`);
      deleteButton.addEventListener("click", () => deleteMemory(m.id));
      return item;
    }),
  );
}

/** Saves one memory: POST /api/memories with { text, bucket, sourceMessageId }. */
async function saveMemory(text, bucket, sourceMessageId) {
  const result = await memoryRequest("POST", { body: { text, bucket, sourceMessageId } });
  if (result.status === 200) {
    await loadMemories();
    return true;
  }
  logEvent("Could not save the memory", "offline");
  return false;
}

/** Deletes one memory: DELETE /api/memories?id=... */
async function deleteMemory(id) {
  if (!window.confirm("Delete this memory?")) return;
  const result = await memoryRequest("DELETE", { id });
  if (result.status === 200) {
    await loadMemories();
    logEvent("Memory deleted", "idle");
  } else {
    logEvent("Could not delete the memory", "offline");
  }
}

/** Prompts the owner to approve a message as a memory, then saves it. */
async function rememberMessage(text, sourceMessageId) {
  const bucket = prompt('Bucket for this memory ("owner" or "project"):', "owner");
  if (bucket !== "owner" && bucket !== "project") return;
  const edited = prompt("Edit the memory text:", text);
  if (edited === null || edited.trim().length === 0) return;
  await saveMemory(edited.trim(), bucket, sourceMessageId);
}

function autosize() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 160)}px`;
  els.counter.textContent = `${els.prompt.value.length} / ${MAX_PROMPT_LENGTH}`;
  renderPicker();
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(els.prompt.value);
});
els.prompt.addEventListener("input", autosize);
els.prompt.addEventListener("keydown", (event) => {
  if (!els.picker.hidden) {
    if (event.key === "Escape") {
      els.picker.hidden = true;
      els.prompt.setAttribute("aria-expanded", "false");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      movePicker(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      completeEntry(pickerEntries[pickerIndex]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && enterAction(els.prompt.value, pickerEntries[pickerIndex]) === "complete") {
      event.preventDefault();
      completeEntry(pickerEntries[pickerIndex]);
      return;
    }
  }
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
  if (view.state === "signed-in") {
    if (!historyOn) await loadHistory();
    if (!memoryOn) await loadMemories();
  }
}

els.signout.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  await loadSession();
loadAllowedSites();
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
// --- sandbox access requests (NLTPI-MVP-007) ---
let accessOn = false;
let pendingNonces = new Map(); // requestId -> nonce (memory only)

async function accessRequest(method, opts = {}) {
  try {
    const r = await fetch("/api/access" + (opts.query ? `?${new URLSearchParams(opts.query)}` : ""), {
      method,
      headers: opts.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 404) { accessOn = false; return { off: true }; }
    accessOn = true;
    return { status: r.status, body: await r.json().catch(() => undefined) };
  } catch { return { networkError: true }; }
}

async function loadAllowedSites() {
  const r = await accessRequest("GET");
  const sec = document.getElementById("access-section");
  const list = document.getElementById("access-list");
  if (!sec || !list) return;
  if (r?.off || r?.networkError || r?.status !== 200 || !Array.isArray(r?.body?.hosts)) { sec.hidden = true; return; }
  accessOn = true;
  sec.hidden = false;
  list.replaceChildren();
  for (const item of r.body.hosts) {
    const host = item?.host;
    if (typeof host !== "string") continue;
    const li = el("li", "access-item");
    li.append(el("code", "", host));
    const rm = el("button", "delete", "Remove");
    rm.type = "button";
    rm.addEventListener("click", async () => {
      await accessRequest("DELETE", { query: { host } });
      loadAllowedSites();
    });
    li.append(rm);
    list.append(li);
  }
}

function renderAccessCards(conversation, originalPrompt, requests) {
  for (const req of requests) {
    if (!req || typeof req.id !== "string" || typeof req.host !== "string") continue;
    const card = el("div", "msg assistant access-card-msg");
    const body = el("div");
    const cardBox = el("div", "access-card");
    cardBox.append(el("div", "access-host", req.host));
    if (typeof req.reason === "string" && req.reason) cardBox.append(el("div", "access-reason", req.reason));
    cardBox.append(el("div", "access-warn", "Anything in the workspace can be sent to this site."));
    const actions = el("div", "access-actions");
    const mk = (label, cls) => { const b = el("button", cls, label); b.type="button"; return b; };
    const turnBtn = mk("Allow for this turn", "chip");
    const alwaysBtn = mk("Always allow", "chip");
    const denyBtn = mk("Deny", "chip");
    const status = el("div", "meta", "");
    actions.append(turnBtn, alwaysBtn, denyBtn);
    cardBox.append(actions, status);
    body.append(el("span","sr-only","Assistant: "), cardBox);
    card.append(el("span","mark-sm",""), body);

    async function decide(decision) {
      turnBtn.disabled = alwaysBtn.disabled = denyBtn.disabled = true;
      const r = await accessRequest("POST", { body: { id: req.id, decision } });
      if (r?.status !== 200) { status.textContent = "Could not record the decision."; turnBtn.disabled=alwaysBtn.disabled=denyBtn.disabled=false; return; }
      if (decision === "deny") { status.textContent = "Denied."; return; }
      if (decision === "allow_turn" && typeof r.body?.nonce === "string") {
        pendingNonces.set(req.id, r.body.nonce);
        status.textContent = "Allowed for this turn. Continuing…";
        await continueAfterAccess(conversation, originalPrompt, [{ id: req.id, nonce: r.body.nonce }]);
        pendingNonces.delete(req.id);
        return;
      }
      if (decision === "allow_always") {
        status.textContent = "Always allowed. Continuing…";
        loadAllowedSites();
        await continueAfterAccess(conversation, originalPrompt, undefined);
      }
    }
    turnBtn.addEventListener("click", () => decide("allow_turn"));
    alwaysBtn.addEventListener("click", () => decide("allow_always"));
    denyBtn.addEventListener("click", () => decide("deny"));
    if (conversation === active) { els.log.append(card); els.log.scrollTop = els.log.scrollHeight; }
  }
}

async function continueAfterAccess(conversation, originalTask, grants) {
  // Resend the task because a resumed turn has no earlier context. Grants carry nonce in memory only.
  const note = grants ? " (The requested site is now allowed for this turn.)" : " (The requested site is now always allowed.)";
  const prompt = originalTask + note;
  await runContinuation(conversation, prompt, originalTask, grants);
}

async function runContinuation(conversation, prompt, resumeTask, grants) {
  els.currentTask.textContent = "Continuing after access decision…";
  setPending(true);
  try {
    let response;
    const body = { prompt, model: modelToSend(els.modelSelect.value, loadedModels), conversationId: conversation.id };
    if (Array.isArray(grants) && grants.length) body.resume = { task: resumeTask, grants };
    try {
      response = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(body) });
    } catch { return; }
    if (!response.ok || !response.body) return;
    const reply = { id: crypto.randomUUID(), role: "assistant", kind: "allowed", text: "", at: new Date() };
    conversation.messages.push(reply);
    const node = renderMessage(reply);
    const bubble = node.querySelector(".bubble");
    if (conversation === active) els.log.append(node);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = ""; let done;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseNdjson(buffer); buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === "text" && typeof event.delta === "string") { reply.text += event.delta; setBubble(bubble, reply); }
          else if (event.type === "tool" && typeof event.name === "string") els.currentTask.textContent = `Running ${event.name}`;
          else if (event.type === "done") done = event;
        }
        els.log.scrollTop = els.log.scrollHeight;
      }
    } catch {}
    if (done?.status === "needs_access" && Array.isArray(done.access)) renderAccessCards(conversation, resumeTask, done.access);
    const note = agentDoneMessage(done);
    if (note) { reply.text = reply.text ? `${reply.text}\n\n${note}` : note; reply.kind = "unavailable"; bubble.dataset.kind = "unavailable"; setBubble(bubble, reply); }
  } finally { setPending(false); els.currentTask.textContent = "Idle"; }
}
// --- end access requests ---
