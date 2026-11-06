import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, completion, conversationToMarkdown, enterAction, parseSlash, resolveModel, suggestCommands, tokenizeArgs, unquote } from "../public/lib/commands.js";

test("every entry has a name, a description and a source, and names are unique and lowercase", () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  for (const command of COMMANDS) {
    assert.match(command.name, /^[a-z][a-z-]*$/);
    assert.ok(command.description.length > 0);
    assert.equal(command.source, "page");
  }
  // The Pi command names this page mirrors.
  for (const pi of ["model", "new", "name", "session", "copy", "export", "reload"]) assert.ok(names.includes(pi), pi);
});

test("a known command is recognised, case-insensitively, with its arguments", () => {
  assert.deepEqual(parseSlash("/session"), { kind: "command", name: "session", args: "", argv: [] });
  assert.deepEqual(parseSlash("  /NEW  "), { kind: "command", name: "new", args: "", argv: [] });
  assert.deepEqual(parseSlash("/model nemotron free"), { kind: "command", name: "model", args: "nemotron free", argv: ["nemotron", "free"] });
  assert.deepEqual(parseSlash('/name "My session"'), { kind: "command", name: "name", args: '"My session"', argv: ["My session"] });
});

test("paths, prose and unknown words are ordinary messages and are sent as typed", () => {
  for (const text of ["/vercel/sandbox/nlt-pi", "/etc/passwd", "/foo", "/foo bar", "hello /new", "what does /model do?", "/", "/ new", "/1abc", ""]) {
    assert.equal(parseSlash(text).kind, "none", JSON.stringify(text));
  }
  assert.equal(parseSlash(undefined).kind, "none");
  assert.equal(parseSlash(42).kind, "none");
});

test("a lone word that only starts a command is a hint, not a message", () => {
  const parsed = parseSlash("/ex");
  assert.equal(parsed.kind, "partial");
  assert.deepEqual(parsed.matches.map((command) => command.name), ["export"]);
  assert.equal(parseSlash("/mo").kind, "partial");
  // With arguments it is not a lone word, so it is an ordinary message.
  assert.equal(parseSlash("/ex there").kind, "none");
});

test("a leading // escapes the command so its text can still be sent", () => {
  assert.deepEqual(parseSlash("//new session notes"), { kind: "escaped", text: "/new session notes" });
  assert.deepEqual(parseSlash("//new"), { kind: "escaped", text: "/new" });
});

test("argument tokenizing follows shell-like quoting", () => {
  assert.deepEqual(tokenizeArgs("a b  c"), ["a", "b", "c"]);
  assert.deepEqual(tokenizeArgs('"API compatibility" fast'), ["API compatibility", "fast"]);
  assert.deepEqual(tokenizeArgs("'two words' x"), ["two words", "x"]);
  assert.deepEqual(tokenizeArgs('""'), [""]);
  assert.deepEqual(tokenizeArgs('unterminated "quote here'), ["unterminated", "quote here"]);
  assert.deepEqual(tokenizeArgs(""), []);
  assert.deepEqual(tokenizeArgs(undefined), []);
  assert.equal(unquote('"My session"'), "My session");
  assert.equal(unquote("  plain  "), "plain");
  assert.equal(unquote("'mismatched\""), "'mismatched\"");
});

test("the menu shows names that start with the text first, then names that contain it, and never for paths", () => {
  assert.deepEqual(suggestCommands("/").map((c) => c.name), COMMANDS.map((c) => c.name));
  assert.deepEqual(suggestCommands("/m").map((c) => c.name), ["model", "name"]);
  assert.deepEqual(suggestCommands("/mo").map((c) => c.name), ["model"]);
  // Names that start with the text come before names that merely contain it.
  const e = suggestCommands("/e").map((c) => c.name);
  assert.equal(e[0], "export");
  assert.ok(e.includes("model") && e.includes("reload"));
  assert.ok(suggestCommands("/ess").map((c) => c.name).includes("session"));
  assert.deepEqual(suggestCommands("/ver"), []);
  assert.deepEqual(suggestCommands("/model "), []);
  assert.deepEqual(suggestCommands("/vercel/sandbox"), []);
  assert.deepEqual(suggestCommands("hello"), []);
  assert.deepEqual(suggestCommands(undefined), []);
  const custom = [{ name: "skill:review", description: "d", source: "project" }, { name: "review", description: "d", source: "project" }];
  assert.deepEqual(suggestCommands("/skill:", custom).map((c) => c.name), ["skill:review"]);
});

test("picking a menu entry completes it with a trailing space", () => {
  assert.equal(completion({ name: "model" }), "/model ");
});

test("Enter completes the highlighted entry unless the message already is that command", () => {
  const model = COMMANDS.find((c) => c.name === "model");
  assert.equal(enterAction("/mod", model), "complete");
  assert.equal(enterAction("/", model), "complete");
  assert.equal(enterAction("/model", model), "submit");
  assert.equal(enterAction("/MODEL", model), "submit");
  assert.equal(enterAction("/mod", undefined), "submit");
});

test("/model resolves auto, exact, unique partial, quoted, ambiguous and unknown names", () => {
  const models = [
    { id: "nvidia/nemotron-3.5-lightning-free", label: "Nemotron Lightning" },
    { id: "nvidia/nemotron-ultra-free", label: "Nemotron Ultra" },
    { id: "stealth/glyph-cluster", label: "Glyph" },
  ];
  assert.deepEqual(resolveModel("", models), { ok: true, id: "" });
  assert.deepEqual(resolveModel("AUTO", models), { ok: true, id: "" });
  assert.deepEqual(resolveModel("stealth/glyph-cluster", models), { ok: true, id: "stealth/glyph-cluster" });
  assert.deepEqual(resolveModel("glyph", models), { ok: true, id: "stealth/glyph-cluster" });
  assert.deepEqual(resolveModel('"nemotron lightning"', models), { ok: true, id: "nvidia/nemotron-3.5-lightning-free" });
  const ambiguous = resolveModel("nemotron", models);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.matches.length, 2);
  assert.deepEqual(resolveModel("nope", models), { ok: false, reason: "none", matches: [] });
  assert.deepEqual(resolveModel("x", undefined), { ok: false, reason: "none", matches: [] });
});

test("an id chosen with /model can only be one the server listed", () => {
  assert.equal(resolveModel("evil/paid-model", [{ id: "a/b-free", label: "B" }]).ok, false);
});

test("the export is the conversation as shown, without page notices", () => {
  const text = conversationToMarkdown({
    title: "Look through nlt-pi",
    startedAt: new Date("2026-11-06T20:00:00Z"),
    messages: [
      { role: "assistant", kind: "info", text: "Hello. This is the NLT Coding Agent.", at: new Date("2026-11-06T20:00:00Z") },
      { role: "user", kind: "normal", text: "Look through nlt-pi", at: new Date("2026-11-06T20:01:00Z") },
      { role: "assistant", kind: "allowed", text: "**nlt-pi** is the repo.", at: new Date("2026-11-06T20:01:05Z") },
    ],
  });
  assert.match(text, /^# Look through nlt-pi\n/);
  assert.match(text, /## You \(2026-11-06T20:01:00.000Z\)\n\nLook through nlt-pi/);
  assert.match(text, /## Assistant \(2026-11-06T20:01:05.000Z\)\n\n\*\*nlt-pi\*\* is the repo\./);
  assert.equal(text.includes("Hello. This is"), false);
  assert.ok(text.endsWith("\n"));
});

test("the export keeps a multi-line title in one heading", () => {
  const text = conversationToMarkdown({ title: "Topic\n## Other\n  more", startedAt: new Date("2026-11-06T20:00:00Z"), messages: [] });
  assert.equal(text.split("\n").filter((line) => line.startsWith("#")).length, 1);
  assert.match(text, /^# Topic ## Other more\n/);
  assert.match(conversationToMarkdown({ title: "   ", startedAt: new Date("2026-11-06T20:00:00Z"), messages: [] }), /^# Session\n/);
});

test("the export labels blocked and unavailable replies instead of presenting them as model output", () => {
  const at = new Date("2026-11-06T20:01:00Z");
  const text = conversationToMarkdown({
    title: "t",
    startedAt: at,
    messages: [
      { role: "assistant", kind: "allowed", text: "partial answer", at },
      { role: "assistant", kind: "unavailable", text: "partial answer\n\nThe agent could not finish this turn.", at },
      { role: "assistant", kind: "blocked", text: "This message was blocked.", at },
    ],
  });
  assert.match(text, /## Assistant \(2026/);
  assert.match(text, /## Assistant \[unavailable\] \(2026/);
  assert.match(text, /## Assistant \[blocked\] \(2026/);
  // Partial model text is kept.
  assert.ok(text.includes("partial answer\n\nThe agent could not finish this turn."));
});
