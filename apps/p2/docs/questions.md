# Questions: input into running work

Status: design (target). A p2 service, not a Chord or Durable feature. Referenced from `target-design.md` §17a.

## Problem

Running work sometimes needs an answer from a person:

- **login:** pi-ai's OAuth and API-key flows ask for a pasted code, a secret or an account selection (today a promise map
  inside `plugins/login/logins.ts`, `prompt`/`answer`);
- **tool approval:** before the agent runs a dangerous tool, the owner allows or denies it (p2 has none today);
- **a question tool:** the model asks everyone present and needs all their answers.

All three are the same shape: work waits for an answer from one or more people, who may join or leave meanwhile.

## Design

A **shared store** (a facet resource on the host where the asking work runs) plus **per-principal views** (Chord
objects are per type, input and principal, so asker and viewer get different objects; both delegate to the one store).

```ts
export type Question =
  | { kind: "text"; message: string; secret?: boolean; help?: string }
  | { kind: "select"; message: string; options: readonly { id: string; label: string }[] }
  | { kind: "confirm"; message: string; allow: string; deny: string };

type AnswerOf<Q> =
  Q extends { kind: "confirm" } ? boolean :
  Q extends { kind: "select"; options: readonly { id: infer I }[] } ? I :
  string;

type Who = { principal: P2Principal; name: string };
type Policy = { mode: "first" } | { mode: "quorum"; count: number } | { mode: "all"; join?: "live" | "snapshot" };
type ResultOf<Q, P extends Policy> =
  P extends { mode: "first" } ? { by: Who; answer: AnswerOf<Q> } :
  { answers: { by: Who; answer: AnswerOf<Q> }[]; missing: Who[] };

type Scope = { session: string } | { owner: P2Principal };   // typed, not a string

ask<const Q extends Question, const P extends Policy>(q: Q, opts: {
  audience: Readable<readonly P2Principal[]> | readonly P2Principal[];
  policy: P;
  key?: string;          // stable per asking flow (tool task id, login attempt): a re-ask reattaches
  deadline?: number;     // then resolve with what is there (`missing` names who did not answer)
}, ctx: Ctx): Promise<ResultOf<Q, P>>;
```

```ts
export default defineFacet((host, self) => {
  const pending = self.resource("questions", {
    version: 1,
    open: () => new PendingQuestions(),                 // entries + resolvers + change events; data only
    replace: (old) => old,                              // hand over on a container change (target-design §12)
    close: (p) => p.rejectAll("store closed"),
  });

  host.serve(Questions, ({ scope }, principal, self) => {
    if (isHost(principal)) {
      return { variant: "asker", ask: (q, opts, ctx) => askQuestion(pending.value, scope, principal, q, opts, ctx) };
    }
    if (!mayView(principal, scope)) throw forbidden();
    return {
      variant: "viewer",
      open: self.derive([pending.value.readable], (all) => openFor(all, scope, principal)),
      answer: ({ id, value }) => answerQuestion(pending.value, id, principal, value),
    };
  });
});
```

## Rules

- **The store is the truth.** Pending entries and resolvers live in the resource; `open` is a readable over it,
  filtered per viewer; nothing is a document, so a reload or migration cannot leave a ghost question. The logic
  (policies, validation) is plain code around the container, so logic changes are code reloads.
- **One settlement point:** register the waiter and the abort listener before publishing the question (and handle an
  already aborted signal); an answer, an abort or the deadline atomically takes the entry out before resolving. A late
  or second answer gets "no longer active". Answers are validated against the stored question (a select id from the
  options). Never await an answer inside a transaction.
- **Policies over a live audience:** `first` resolves with the first answer. `quorum(n)` resolves after `n` answers.
  `all` resolves when every member of the audience has answered; with `join: "live"` (default) someone who joins
  becomes required and someone who leaves drops out (their answer, if given, stays); with `"snapshot"` the audience is
  fixed when asking. If the audience becomes empty before anyone answered, `all` waits for the deadline.
- **Authorization:** the asker is stamped by the host (a worker may ask only in its own session's scope; secret
  questions only from server askers). Each question stores who may answer it (the audience); a guest's send access does
  not imply approval rights. Viewing and answering are checked separately. The answering principal is the one Chord
  stamped on the connection. Secret answers are never put into `open`, documents or logs; redaction happens in
  `answer`.
- **Link drops and crashes:** a rejected `ask` (link blip, store replaced, server restart) is not a denial. Askers retry
  with the same `key` until their own signal aborts; a re-ask with a known key reattaches to the pending entry. A
  pending `ask` counts as an active call (keep-alive, relocation fence); a deadline lets idle work end.
- **Where the store lives:** on the host where the asking work runs, so asking crosses no link: session questions (tool
  approval, the question tool) in the session's worker (placement `sessionHost`), login questions on the server. UIs
  reach both through the usual relay.

## Scenarios

**Tool approval (first answer wins).** A Durable hook gets Durable's `Context`, not a Chord `ctx`; it opens a Chord call
scope with `host.root`. The decision is stored in a Durable task memo, so a hook rerun before the consuming commit does
not ask again.

```ts
hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (!needsApproval(call)) return undefined;
    const decided = await api.memo<boolean>("approval", context);
    if (decided !== undefined) return decided ? undefined : { block: "Denied" };
    const allowed = await host.root(async (ctx) => {
      const q = await ctx.get(Questions, { scope: { session } });
      for (;;) {
        try {
          const r = await q.ask(
            { kind: "confirm", message: `Run ${call.name}?`, allow: "Allow", deny: "Deny" },
            { audience: approvers, policy: { mode: "first" }, key: api.taskId },
            ctx,
          );
          return r.answer;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          await backoff(ctx);
        }
      }
    }, { signal: context.abortSignal });
    await api.memo("approval", allowed, context);
    return allowed ? undefined : { block: "Denied by the user" };
  },
});
```

Durable runs `beforeTool` in the tool task's `call` phase; after the `execute` checkpoint a crash retries execution
without hooks. The approval therefore covers that retry, and it must cover the **final** arguments: an approval hook
runs after hooks that rewrite arguments.

**Quorum (2 of 3).**

```ts
const r = await q.ask(
  { kind: "confirm", message: "Deploy to production?", allow: "Deploy", deny: "Stop" },
  { audience: [owner, alice, bob], policy: { mode: "quorum", count: 2 } },
  ctx,
);
const go = r.answers.every((a) => a.answer);
```

**Question tool (everyone present answers).**

```ts
const present = self.derive([host.references(Chat)], (refs) =>
  refs.filter((r) => !r.lingering && r.input.conversation === conversation).map((r) => r.principal));

execute: async ({ question, options }, ctx) => {
  const q = await ctx.get(Questions, { scope: { session } });
  const r = await q.ask(
    { kind: "select", message: question, options },
    { audience: present, policy: { mode: "all" }, deadline: Date.now() + 5 * 60_000, key: ctx.toolCallId },
    ctx,
  );
  return { answers: r.answers.map((a) => `${a.by.name}: ${a.answer}`), noAnswer: r.missing.map((w) => w.name) };
},
```

**Login.** The login flow is a job (target-design §10); pi-ai's `prompt` callback asks the owner-scoped store, which
replaces the promise map in `Logins`:

```ts
run: async ({ providerId, owner }, ctx) => {
  const q = await ctx.get(Questions, { scope: { owner } });
  await models.login(providerId, {
    signal: ctx.signal,
    prompt: (p) => q.ask(toQuestion(p), { audience: [owner], policy: { mode: "first" }, key: ctx.jobId }, ctx)
      .then((r) => r.answer),
    notify: (event) => ctx.progress({ event }),          // auth URL, device code: notices, not questions
  });
},
```

## Not covered here

- **Notices** (auth URL, device code, progress) are one-way and go through the asking work's own progress state.
- **Withdrawing one question** without ending the asking flow (an OAuth callback that wins against a pasted-code
  prompt): the asker aborts that `ask` through its own signal (one `AbortController` per prompt).
- Remote device-code auto-selection stays in the login flow.
