import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKED_PLACEHOLDER,
  HISTORY_NOTICE,
  MAX_SAVE_BATCH,
  MAX_SAVED_TEXT,
  TRUNCATED,
  createSaver,
  interpretConversation,
  interpretHistoryList,
  mergePending,
  saveTitle,
  shortTitle,
  toStoredMessages,
} from "../public/lib/history.js";

// Synthetic ids only.
const C = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const at = new Date("2026-11-05T12:00:00.000Z");

test("the notice is the spec's exact copy", () => {
  assert.equal(
    HISTORY_NOTICE,
    "Your conversations are saved to this project's Neon database until you delete them. Messages the safety check blocks are saved only as a 'blocked' marker, without their text.",
  );
  assert.equal(BLOCKED_PLACEHOLDER, "This message was blocked by the safety check.");
});

test("history is on only for a 200 with a conversation list", () => {
  const on = interpretHistoryList({
    status: 200,
    body: { conversations: [{ id: C, title: "T", createdAt: "x", updatedAt: "y" }, { id: 5 }, { title: "no id" }] },
  });
  assert.deepEqual(on, { state: "on", conversations: [{ id: C, title: "T", createdAt: "x", updatedAt: "y" }] });
  for (const result of [
    undefined,
    { networkError: true },
    { status: 404, body: { conversations: [] } },
    { status: 401 },
    { status: 503, body: { error: "History unavailable" } },
    { status: 200, body: null },
    { status: 200, body: { conversations: "nope" } },
  ]) {
    assert.deepEqual(interpretHistoryList(result), { state: "off" });
  }
});

test("a saved conversation is read only from a well-formed 200", () => {
  const body = { conversation: { id: C, title: "T" }, messages: [{ id: U, role: "user", kind: "normal", text: "hi", createdAt: "z" }, { bad: true }] };
  const read = interpretConversation({ status: 200, body });
  assert.equal(read?.conversation.id, C);
  assert.deepEqual(read?.messages.map((m) => m.id), [U]);
  for (const result of [undefined, { status: 404 }, { status: 200, body: {} }, { networkError: true }]) {
    assert.equal(interpretConversation(result), undefined);
  }
});

const NOW = at.getTime() + 60_000;

test("an exchange is stored without the welcome message, with page kinds mapped", () => {
  const stored = toStoredMessages(
    [
      { kind: "info", role: "assistant", text: "Hello.", at }, // no id: the page's welcome
      { id: U, role: "user", text: "list files", at },
      { id: A, role: "assistant", kind: "allowed", text: "done", at, model: "synthetic/free" },
    ],
    NOW,
  );
  assert.deepEqual(stored, [
    { id: U, role: "user", kind: "normal", text: "list files", createdAt: at.toISOString() },
    { id: A, role: "assistant", kind: "normal", text: "done", createdAt: at.toISOString(), model: "synthetic/free" },
  ]);
  assert.deepEqual(toStoredMessages([{ id: U, kind: "info", role: "assistant", text: "Hello.", at }], NOW), []);
});

test("a blocked exchange is stored with no text for both messages", () => {
  const stored = toStoredMessages(
    [
      { id: U, role: "user", text: "possibly sensitive words", at },
      { id: A, role: "assistant", kind: "blocked", text: "The governance gate stopped this message.", at },
    ],
    NOW,
  );
  assert.deepEqual(
    stored.map((m) => [m.kind, m.text]),
    [
      ["blocked", ""],
      ["blocked", ""],
    ],
  );
});

test("an unavailable reply keeps its kind and the user's text", () => {
  const stored = toStoredMessages(
    [
      { id: U, role: "user", text: "hi", at },
      { id: A, role: "assistant", kind: "unavailable", text: "The agent is unavailable right now.", at },
    ],
    NOW,
  );
  assert.deepEqual(
    stored.map((m) => [m.kind, m.text]),
    [
      ["normal", "hi"],
      ["unavailable", "The agent is unavailable right now."],
    ],
  );
});

test("the server's limits are applied: long text is cut with a marker, a future time becomes now", () => {
  const [long, ahead] = toStoredMessages(
    [
      { id: U, role: "assistant", text: "x".repeat(30_000), at },
      { id: A, role: "assistant", text: "fine", at: new Date(NOW + 10 * 60_000) },
    ],
    NOW,
  );
  assert.equal(long.text.length, MAX_SAVED_TEXT);
  assert.ok(long.text.endsWith(TRUNCATED));
  const [emoji] = toStoredMessages([{ id: U, role: "assistant", text: "😀".repeat(15_000), at }], NOW);
  assert.ok(emoji.text.length <= MAX_SAVED_TEXT);
  assert.equal(emoji.text.isWellFormed(), true);
  assert.equal(ahead.createdAt, new Date(NOW).toISOString());
});

test("titles are cut by characters, never splitting an emoji, and are never blank", () => {
  const emoji = "😀".repeat(50);
  for (const title of [shortTitle(emoji, 28), saveTitle(emoji)]) {
    assert.equal(title.isWellFormed(), true);
  }
  assert.equal(Array.from(shortTitle(emoji, 28)).length, 29); // 28 characters plus the ellipsis
  assert.equal(shortTitle("short", 28), "short");
  assert.ok(Array.from(saveTitle("y".repeat(200))).length <= 80);
  assert.equal(saveTitle("   "), "Conversation");
  assert.equal(saveTitle("a\ud83db").isWellFormed(), true);
});

/** A fake POST /api/conversations whose answers the test controls. */
function fakeSend(statuses) {
  const bodies = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const send = async (body) => {
    bodies.push(structuredClone(body));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { status: statuses.length > 0 ? statuses.shift() : 200 };
  };
  return { send, bodies, maxInFlight: () => maxInFlight };
}

const exchange = (n, kind) => [
  { id: `u${n}aaaaa-1111-4111-8111-111111111111`, role: "user", text: `prompt ${n}`, at },
  { id: `a${n}aaaaa-1111-4111-8111-111111111111`, role: "assistant", kind, text: `reply ${n}`, at },
];

test("a blocked exchange never erases an earlier queued one", async () => {
  const fake = fakeSend([503, 200]);
  const saver = createSaver(fake.send);
  const conversation = { id: C, title: "T" };
  await saver.enqueue(conversation, exchange(1, "allowed"), NOW);
  await saver.enqueue(conversation, exchange(2, "blocked"), NOW);
  assert.deepEqual(
    fake.bodies[1].messages.map((m) => [m.kind, m.text]),
    [
      ["normal", "prompt 1"],
      ["normal", "reply 1"],
      ["blocked", ""],
      ["blocked", ""],
    ],
  );
  assert.equal(conversation.saveState, "saved");
  assert.deepEqual(conversation.unsaved, []);
});

test("saves never overlap, and a failure while another waits loses nothing", async () => {
  const fake = fakeSend([503, 503, 200]);
  const saver = createSaver(fake.send);
  const conversation = { id: C, title: "T" };
  const first = saver.enqueue(conversation, exchange(1, "allowed"), NOW);
  const second = saver.enqueue(conversation, exchange(2, "allowed"), NOW);
  await Promise.all([first, second]);
  assert.equal(fake.maxInFlight(), 1);
  assert.equal(conversation.unsaved.length, 4);
  assert.equal(conversation.saveState, "unsaved");
  await saver.enqueue(conversation, exchange(3, "allowed"), NOW);
  assert.equal(fake.bodies.at(-1).messages.length, 6);
  assert.equal(conversation.saveState, "saved");
  await saver.idle(conversation);
});

test("a long queue is sent oldest first in batches of at most 20", async () => {
  const fake = fakeSend([503]);
  const saver = createSaver(fake.send);
  const conversation = { id: C, title: "T" };
  for (let n = 0; n < 11; n += 1) {
    if (n === 0) await saver.enqueue(conversation, exchange(n, "allowed"), NOW);
    else conversation.unsaved = mergePending(conversation.unsaved, toStoredMessages(exchange(n, "allowed"), NOW));
  }
  await saver.enqueue(conversation, exchange(11, "allowed"), NOW);
  const sizes = fake.bodies.slice(1).map((b) => b.messages.length);
  assert.deepEqual(sizes, [MAX_SAVE_BATCH, 4]);
  assert.equal(fake.bodies[1].messages[0].text, "prompt 0");
  assert.equal(conversation.saveState, "saved");
});

test("a rejected batch (400) is dropped instead of blocking later saves", async () => {
  const fake = fakeSend([400, 200]);
  const saver = createSaver(fake.send);
  const conversation = { id: C, title: "T" };
  await saver.enqueue(conversation, exchange(1, "allowed"), NOW);
  assert.deepEqual(conversation.unsaved, []);
  assert.equal(conversation.saveState, "unsaved");
  await saver.enqueue(conversation, exchange(2, "allowed"), NOW);
  assert.equal(fake.bodies[1].messages[0].text, "prompt 2");
});

test("the pending queue never duplicates a message", () => {
  const first = [{ id: U }, { id: A }];
  const merged = mergePending(first, [{ id: A }, { id: "x" }]);
  assert.deepEqual(merged.map((m) => m.id), [U, A, "x"]);
  assert.deepEqual(mergePending([], []), []);
});

test("idle waits for a running save, so a delete cannot race it", async () => {
  const fake = fakeSend([200]);
  const saver = createSaver(fake.send);
  const conversation = { id: C, title: "T" };
  const order = [];
  saver.enqueue(conversation, exchange(1, "allowed"), NOW).then(() => order.push("saved"));
  await saver.idle(conversation);
  order.push("delete");
  assert.deepEqual(order, ["saved", "delete"]);
});
