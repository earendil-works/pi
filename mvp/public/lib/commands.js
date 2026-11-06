/**
 * Slash commands for the chat box, modelled on Pi's command menu (packages/coding-agent/docs/slash-commands.md):
 * typing "/" opens a searchable menu of commands with a description and an argument hint; picking an entry
 * completes it in the box, and Enter runs it. No DOM access, so it can be unit-tested.
 *
 * These are page commands: they run entirely in the browser. A command is never sent to the governance gate, the
 * agent or any model, never saved to history, and never changes what the agent is allowed to do; it only drives
 * controls that already exist on the page or reads what the page already shows. (Pi's terminal-only commands, such
 * as /settings, /login or /hotkeys, have no equivalent here.)
 *
 * A message is a command only when its first word is exactly a command name. Anything else, such as a path
 * ("/vercel/sandbox") or other text starting with a slash, is an ordinary message. A message starting with "//" is
 * sent with one slash removed, so text that begins with a command name can still be sent.
 */

/** @typedef {{ name: string, description: string, argumentHint?: string, source: "page" | "project" }} CommandEntry */

/** @type {CommandEntry[]} */
export const COMMANDS = [
  { name: "model", argumentHint: "[model]", description: "Select a model for the next messages (this tab only)", source: "page" },
  { name: "new", description: "Start a new session", source: "page" },
  { name: "name", argumentHint: "[name]", description: "Set the session display name, or show it when omitted", source: "page" },
  { name: "session", description: "Show current session information: sign-in, governance, model and storage", source: "page" },
  { name: "copy", description: "Copy the last assistant message", source: "page" },
  { name: "export", description: "Download this session as a Markdown file", source: "page" },
  { name: "reload", description: "Reload the model list and the status shown on this page", source: "page" },
];

const COMMAND_LINE = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/;

/** Splits arguments the way Pi's templates do: whitespace separated, with single or double quotes grouping words. */
export function tokenizeArgs(text) {
  const tokens = [];
  let current = "";
  let quote = "";
  let started = false;
  for (const ch of String(text ?? "")) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Removes one pair of matching quotes around a whole argument, so /name "My session" and /name My session agree. */
export function unquote(text) {
  const value = String(text ?? "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
  return value;
}

/**
 * Classifies a composer message:
 * - { kind: "command", name, args, argv }  a known command
 * - { kind: "partial", matches }           a lone word that is only the start of a command (for example "/ex"), so it is
 *                                          answered with a hint and not sent as a message by mistake
 * - { kind: "escaped", text }              starts with "//": send the text with one slash removed
 * - { kind: "none" }                       an ordinary message
 * @param {unknown} input
 * @param {CommandEntry[]} [commands]
 */
export function parseSlash(input, commands = COMMANDS) {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.startsWith("//")) return { kind: "escaped", text: text.slice(1) };
  const match = COMMAND_LINE.exec(text);
  if (!match) return { kind: "none" };
  const word = match[1].toLowerCase();
  const known = commands.find((command) => command.name.toLowerCase() === word);
  if (known) {
    const args = (match[2] ?? "").trim();
    return { kind: "command", name: known.name, args, argv: tokenizeArgs(args) };
  }
  if (match[2] === undefined) {
    const matches = commands.filter((command) => command.name.toLowerCase().startsWith(word));
    if (matches.length > 0) return { kind: "partial", matches };
  }
  return { kind: "none" };
}

/**
 * Entries for the menu while the first word is still being typed ("/" or "/mo"): names that start with the text
 * first, then names that contain it. Empty once a space or another slash is typed, so paths never open the menu.
 * @param {unknown} input
 * @param {CommandEntry[]} [commands]
 */
export function suggestCommands(input, commands = COMMANDS) {
  if (typeof input !== "string") return [];
  const match = /^\/([\w:-]*)$/.exec(input);
  if (!match) return [];
  const word = match[1].toLowerCase();
  const starts = commands.filter((command) => command.name.toLowerCase().startsWith(word));
  const contains = word ? commands.filter((command) => !command.name.toLowerCase().startsWith(word) && command.name.toLowerCase().includes(word)) : [];
  return [...starts, ...contains];
}

/** The text a menu entry puts in the box: the command, a space, ready for its arguments. */
export function completion(command) {
  return `/${command.name} `;
}

/**
 * What Enter does while the menu is open: run the message when it already is exactly the highlighted command,
 * otherwise complete the highlighted command (like Tab).
 * @param {string} input
 * @param {CommandEntry | undefined} highlighted
 */
export function enterAction(input, highlighted) {
  if (!highlighted) return "submit";
  return input.trim().toLowerCase() === `/${highlighted.name.toLowerCase()}` ? "submit" : "complete";
}

/**
 * Picks a model for "/model <name>" from the list the server gave the page. "" or "auto" means automatic (id "").
 * Matches an id or label exactly (ignoring case), else a single id or label containing the text.
 * @param {string} arg
 * @param {{ id: string, label: string }[]} models
 */
export function resolveModel(arg, models) {
  const wanted = unquote(arg).toLowerCase();
  if (wanted === "" || wanted === "auto") return { ok: true, id: "" };
  const list = Array.isArray(models) ? models : [];
  const exact = list.filter((model) => model.id.toLowerCase() === wanted || String(model.label).toLowerCase() === wanted);
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  const partial = exact.length > 0 ? exact : list.filter((model) => model.id.toLowerCase().includes(wanted) || String(model.label).toLowerCase().includes(wanted));
  if (partial.length === 1) return { ok: true, id: partial[0].id };
  return { ok: false, reason: partial.length === 0 ? "none" : "ambiguous", matches: partial.map((model) => model.id) };
}

/**
 * The /export file: the conversation as Markdown, exactly as shown on the page. Notices that were never stored in the
 * conversation (command output) are not part of it.
 * @param {{ title: string, startedAt: Date, messages: { role: string, text: string, kind?: string, at: Date }[] }} conversation
 */
export function conversationToMarkdown(conversation) {
  // One line only: a title with line breaks must not start a second heading in the file.
  const title = String(conversation.title ?? "").replace(/\s+/g, " ").trim() || "Session";
  const lines = [`# ${title}`, "", `Started ${new Date(conversation.startedAt).toISOString()}`, ""];
  for (const message of conversation.messages) {
    if (message.kind === "info") continue;
    // A blocked or unavailable reply is a page notice, possibly after partial model text: say so in the heading.
    const status = ["blocked", "unavailable", "not-deployed", "invalid"].includes(message.kind) ? ` [${message.kind}]` : "";
    const who = message.role === "user" ? "You" : `Assistant${status}`;
    lines.push(`## ${who} (${new Date(message.at).toISOString()})`, "", message.text, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
