
# Asking a Person {#flows lede="Flows and the Questions service: how running work waits for an answer from someone who may be on any tab, may reconnect, and may answer twice."}

A provider login asks for a pasted code, then an account choice. A dangerous tool call waits for the owner's
approval. The agent asks everyone present a question. In each case running work waits for a person, who may be on any
tab, may lose the connection halfway, may answer late or twice. Two patterns cover this: a **flow** kept as its
owner's state, and the **Questions** service, a shared store for questions.

## A flow is state, not a call

The tempting design is a long-held server call, `step()`, that blocks until the next step. A link drop fails it, and
the consumer cannot tell whether it missed a step. Chord's answer is that the owner keeps the flow as **state**, which
re-holds by itself after any drop:

```ts
// models/contract.ts (sketch from the design)
start:  method(obj({ provider: str() }), obj({ id: str() }))              // uuidv7
answer: method(obj({ id: str(), step: int(), value: str() }), Answered)   // ok | "step no longer active"
cancel: method(obj({ id: str() }))

// LoginFlow { id }: state
type FlowState =
  | { kind: "running"; step?: { id: number; prompt: LoginPrompt }; notices: Notice[] }
  | { kind: "done" | "failed" | "cancelled"; notices: Notice[] };
```

The UI watches the state and renders the current step. A late or second answer to a step that is gone is refused. A
promise-based callback inside the work (pi-ai's `prompt` during a login) stays **inside** the owner: its job keeps the
resolver, and nothing crosses an object boundary.

Imperative consumers (tests, scripts, a CLI, an agent tool) use a generic client helper over the same state, not a
second protocol:

```ts
async function* steps(flow: LoginFlowRef, ctx: Ctx) {
  let last = 0;
  for (;;) {
    const s = await until(flow.state, (v) => v.kind !== "running" || (v.step !== undefined && v.step.id > last), ctx);
    if (s.kind !== "running") return s.kind;
    last = s.step!.id;
    yield s.step!;
  }
}

for await (const step of steps(await ctx.get(LoginFlow, { id }), ctx))
  await login.answer({ id, step: step.id, value: answerFor(step) }, ctx);
```

`last` keeps steps from being lost or repeated across re-holds.

:::review | Review: where a flow lives (#11, deferred)
Decision #11, deferred until login is ported: (a) a keyed document of its owner, or (b) an object `LoginFlow { id }`
living until done; tied to #9 (jobs as objects). The `LoginFlow { id }` address above assumes (b). Also undecided is
how "leaving" ends a login (p2 cancels when the starting owner leaves everywhere); with presence it is a dropped
reference, never an unmount (chapter VIII).
:::

## The Questions service

The Questions service (`apps/p2/docs/questions.md`) is a p2 design, not a Chord feature, built from Chord's
primitives: a shared store with per-principal views. The asker gets `ask`; viewers get the open questions and
`answer`.

```ts
export type Question =
  | { kind: "text"; message: string; secret?: boolean; help?: string }
  | { kind: "select"; message: string; options: readonly { id: string; label: string }[] }
  | { kind: "confirm"; message: string; allow: string; deny: string };

type Policy = { mode: "first" } | { mode: "quorum"; count: number } | { mode: "all"; join?: "live" | "snapshot" };

ask(question, {
  audience,                // a readable or a list of principals
  policy,
  key?,                    // stable per asking flow: a re-ask reattaches to the pending question
  deadline?,               // then resolve with what is there; `missing` names who did not answer
}, ctx): Promise<Result>;
```

Its rules:

- **The store is the truth.** Pending questions and their resolvers live in the store; `open` is a readable over it,
  filtered per viewer. Nothing is a document, so a reload or migration cannot leave a ghost question.
- **One settlement point.** Register the waiter and the abort listener before publishing the question; an answer, an
  abort or the deadline atomically takes the entry out before resolving. A late or second answer gets "no longer
  active". Answers are validated against the stored question (a select id must be one of the options). Never await an
  answer inside a transaction.
- **Policies over a live audience.** `first` resolves with the first answer; `quorum(n)` after n answers; `all` when
  every member of the audience has answered. With `join: "live"` (the default), someone who joins becomes required and
  someone who leaves drops out.
- **Authorization.** The asker is stamped by the host (a worker asks only in its own session's scope; secret questions
  only from server askers). Each question stores who may answer it; a guest's send access does not imply approval
  rights. Secret answers never appear in `open`, documents or logs.
- **Link drops and crashes.** A rejected `ask` is not a denial. Askers retry with the same `key` until their own signal
  aborts; a pending `ask` counts as an active call for keep-alive.
- **Where it lives.** On the host where the asking work runs: session questions on the session's worker, login
  questions on the server. UIs reach both through the usual relay.

The store in Chord v2 terms:

```ts
host.serve(QuestionStore, ({ scope }, self) => {
  const pending = self.open(async () => new PendingQuestions(), (p) => p.rejectAll("store closed"));
  const open = self.derive("open", [pending.value.readable], ([all]) => all);   // data only, no resolvers
  return { open, ask: (args, ctx) => pending.value.ask(args, ctx), answer: (args, ctx) => pending.value.answer(args, ctx) };
});

host.serve(Questions, ({ scope }, principal, self) => {
  const store = self.get(QuestionStore, { scope });
  if (isHost(principal)) return { variant: "asker", ask: (args, ctx) => store.ask({ ...args, asker: principal }, ctx) };
  if (!mayView(principal, scope)) throw forbidden();
  return {
    variant: "viewer",
    open: self.derive("mine", [store.open], ([all]) => openFor(all, principal)),
    answer: ({ id, value }, ctx) => store.answer({ id, value, by: principal }, ctx),
  };
});
```

The pending map with its resolvers is in-process state with promises, so it is a native of the store (opened and
closed with it). Its `close` rejects every waiter; askers retry with their key against the new store after a reload.

:::review | Review: questions.md predates the v2 rules
`apps/p2/docs/questions.md` writes the store as `self.resource(...)` with a `replace` hand-over, which the design
rejected ("resources replaced in place"), and opens Chord call scopes in Durable hooks with `host.root`, which Q6
replaced with `chord(fn, context)` (chapter XIV). Design §20 says the Questions store "must live in an object (it
predates natives only in objects)". The sketch above is this guide's translation, with the derive per viewer; filtering
per viewer in the store, once per variant, may be cheaper for large audiences. The `ask` signature passes typed
objects as arguments, which is fine (data), but the `audience` readable form cannot cross a link: across links,
audience must be data (principals) or computed by the store.
:::

## Choosing

| Case | Use |
| --- | --- |
| a multi-step login in one owner | a flow: the owner's job keeps the resolver, state shows the steps |
| a tool needs the owner's approval | Questions, `first`, audience the owner |
| the agent asks everyone present | Questions, `all`, audience from presence |
| deploy needs 2 of 3 approvals | Questions, `quorum(2)` |
| a notice (auth URL, device code, progress) | not a question: the asking work's own progress state |
