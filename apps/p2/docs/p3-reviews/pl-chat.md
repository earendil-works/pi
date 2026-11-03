# pl-chat: target design, reload, Chord v2 and p3 reviews

This records the reviews, findings, questions and recommendations produced in this conversation, excluding the functionality map. The two review reports below are preserved verbatim apart from their heading levels. They are historical reports, not a claim that every proposal still applies. Additional review points from the discussion follow them.

## Decision and open-status index

Known owner decisions come from `packages/chord/docs/decisions.md` at `5abe3f6d6`. Proposed object boundaries and fixes below are recommendations, not owner decisions.

| Point | Known status |
|---|---|
| Build p3 next to p2, isolated data, no legacy migration; Chord v2 inside p3 initially | Owner decided |
| Pure facet, natives only in served objects through `self.open`; no resources, replace or deps | Owner decided; supersedes the first report's resource proposals |
| Native objects restart and abort running work on reload; expensive natives split into separate plugins | Owner decided |
| Whole-host rollback for load/staging errors, including live-object factories | Owner decided; resolves first report F1's setup-throw version mix |
| Named derive with its previous value retained across factory re-runs | Owner decided; resolves F3's missing mechanism |
| Jobs retain intent/run/finish and add awaitable `outcome(ctx)` | Owner decided; job lifetime and dedupe-retention questions remain open |
| Ownership principle; methods return data, objects passed as addresses; no cross-plugin natives | Owner decided |
| Conversation policy written in the creating commit; remove external read-only/cwd-following policy registries | Owner decided |
| Registries remain behaviour extension points, including send routers and input gates | Owner decided |
| Single-shot Durable watches | Mechanism changes resolve retained-watch reuse; proposed split into a separate feed object/plugin remains a recommendation |
| Draft live representation, withdrawal/restoration atomicity and retention | Open recommendations; no known owner decision adopting this review's particular design |
| SessionDeleted, file formats, optional references, UI renderer reload versus leaving, shared Durable docs | Explicitly open in redesign-decisions.md |
| Keep-alive calculated by worker; presence/link-drop/linger details | Explicitly open in redesign-decisions.md |
| Proposed Catalog, Session, Conversation, Composer, Downloads and Artifacts boundaries | Review recommendations, not adopted decisions |
| Cross-owner chat digest concurrency, byte transfer overhead, relocation environment addresses | Open review questions/recommendations |
| Precise migration estimates in report 1 | Historical only: superseded by the decision to build p3 without legacy migration |

## Original review against target-design.md and plugin-loading.md, 6559589bd

I read target-design.md, plugin-loading.md and questions.md in full on origin/private `6559589bd`, all 31 files of the six plugins, and the runtime they use (`worker.ts`, `durable.ts`, `commits.ts`, `contribute.ts`, `chord.ts`, `tui.ts`). I also checked pi-durable's `WatchHandle`. Nothing was edited; the only scratch files are under /tmp/plrev.

**Verdict:** the design holds for these six plugins, but five gaps need fixing first. conversations, send-file and the artifacts server, web and TUI facets port almost unchanged. The problems are all in chat, chat-mode, drafts and the artifacts worker.

### Sketches in the new design

```ts
// chat/worker.ts
export default defineFacet((host, self) => {
  const harness = host.value(HarnessKey), envs = host.value(EnvironmentsKey), liveness = host.value(LivenessKey);
  host.serve(Conversation, ({ conversation }, _p, self) => {
    const id = conversation as ConversationId;
    const conv = self.resource("conversation", { version: 1,
      open: async ({ signal }) => (await harness.conversation(id, durableContext(signal))) ?? fail(`Unknown ${id}`) });
    const view = self.source("view", { deps: [conv],                      // MISSING API, F2
      open: ({ signal }) => watchSource(conv.value.watch(durableContext(signal))) });
    const window = self.derive([view], (v, prev) => v && windowView(v, prev)); // needs prev, F3
    const model = self.derive([view, host.registry(HarnessConfig).table], (v, t) => modelMeta(v, t));
    const last = self.state(LastShell);                                   // singleton: {id, data} | null
    const shell = self.job(ShellJob, { concurrency: 1,
      run: async ({ command, includeInContext, author }, ctx) => {
        const agent = await conv.value.agent(durableContext(ctx));
        const out = new OutputBuffer({ maxBytes: SHELL_MAX_BYTES, maxLines: SHELL_MAX_LINES, retain: "tail" });
        const r = await envs.at(agent.cwd).exec(command, { ...opts,
          onOutput: (t, _c, i) => { out.push(t, i.skipped); ctx.progress({ output: out.snapshot(), truncated: out.truncated }); } },
          durableContext(ctx.signal));
        const data = shellData(command, author, includeInContext, out, r, ctx.signal.aborted);
        await conv.value.submit({ type: "write", entry: shellEntry(data), requestId: `${author.id}:shell:${ctx.jobId}` },
          durableContext(ctx));                                            // admission only, no .wait (F4)
        return data;
      },
      finish: async (done, tx) => { (await tx.draft(last)).value = { id: done.id, data: done.ok ? done.result : errorData(done) }; },
    });
    self.routines.on(view, (v, ctx) => last.value && placed(v, last.value.id) && last.change(ctx, (d) => { d.value = null; }));
    return {
      view, window, model,
      shell: self.derive([shell.running, last], liveShellOf),            // ShellState | null, as Chat v5
      runShell: async ({ requestId, author, ...a }, ctx) => {
        for (const gate of host.registry(InputGates).table.value.values()) await gate(ctx);
        return { shellId: (await shell.start({ ...a, author }, ctx, { key: `${author.id}:${requestId}` })).id };
      },
      abortShell: ({ shellId }) => ({ aborted: shell.abort(shellId) }),
      submit, write, stop, dequeue, dequeueOwn, history, configure, compact, reset, abortCompaction, costs, // unchanged
    };
  }, { linger: 30_000 });
  host.serve(Chat, (input, principal, self) => { /* as today, minus the "viewer" resource (-> host.references);
                                                   call = liveness.call */ });
  host.serve(ChatCosts, /* unchanged */);
});
// chat/contract.ts: SendRouters / TranscriptEntries get { version: 1 }; Conversation unchanged.
// chat/web.tsx:     self.register(Slots, "main", Main)
// chat/tui.ts:      self.register(TuiSlots, "chat", (rt) => new ChatSurface(rt));
//                   for (const [k, c] of Object.entries(CHAT_COMMANDS)) self.register(TuiCommands, k, c);
//                   ChatSurfaceKey = defineSurface<ChatApi>("chat")   (14.3)
```

```ts
// chat-mode/worker.ts
export default defineFacet((host, self) => {
  const harness = host.value(HarnessKey);
  host.serve(ChatModeSetting, ({ conversation }, _p, self) => {
    const doc = self.source("doc", { open: ({ signal }) =>
      watchSource(harness.watchDoc(ChatModeDoc, conversation, durableContext(signal))) });  // replaces CommitSignal + task
    const view = self.get(Conversation, { conversation }).view;
    return {
      enabled: self.derive([doc], (d) => d?.enabled ?? false),
      waiting: self.derive([view], waiting),                              // once per conversation, F8
      set: ({ enabled }, ctx) => commitChatMode(harness, conversation, enabled, ctx),  // Durable doc, as today
    };
  }, { linger: 30_000 });
  self.register(SendRouters, "chat-mode", routeChatMode);                 // body unchanged
  host.serve(ChatMode, (i, p, self) => { const s = self.get(ChatModeSetting, i);
    return isOwner(p) ? { variant: "owner", enabled: s.enabled, waiting: s.waiting, set: s.set }
                      : { variant: "reader", enabled: s.enabled, waiting: s.waiting }; });
});
// web: self.register(Slots, "composer:chat-mode", ChatModeChip); self.register(TranscriptEntries, k, v) for each display
// tui: same registrations; chat.setCanReply via ctx.surface(ChatSurfaceKey)

// drafts/worker.ts: one persisted singleton (F5), not keyed
const DraftsDoc = defineState("drafts", { version: 1, persist: true, schema: Type.Object({ next: Type.Number(), byKey: DraftsByKeySchema }),
  initial: () => ({ next: 1, byKey: {} }) });
host.serve(DraftStore, (_i, _p, self) => {
  const doc = self.state(DraftsDoc);
  return {
    drafts: self.derive([doc], (d) => d.byKey),
    add: ({ conversation, items }, ctx) => self.tx(ctx, async (tx) => { const d = await tx.draft(doc);
      for (const { author, text } of items) (d.byKey[draftKey(conversation, author.id)] ??= []).push({ id: d.next++, text }); }),
    claim: ({ conversation, authorId, ids }, ctx) => self.tx(ctx, async (tx) => { /* filter, delete key when empty, return texts */ }),
  };
}, { lifetime: "host" });
// Drafts (per author): self.derive([store.drafts], (all) => all[key] ?? [])   unchanged

// conversations: server unchanged (Hosts -> host value); worker: self.register(Extensions, "p2-conversations", extension);
//   PeerConversation uses host.value(LivenessKey).call; web: self.register(Slots, "chat-attribution", Attribution)
// send-file/worker: self.register(Extensions, "p2-downloads", createSendFileExtension(host.value(WorkerInitKey).dataDir, session))
//   (the template-plus-late-execute trick goes away); SentFiles unchanged; tui: renderers + command, tool views via ChatSurfaceKey
// artifacts/worker: Extensions as send-file; ArtifactList: self.derive([self.source("doc", watchDoc(ArtifactDoc, id))], d => d?.artifacts ?? [])
// artifacts/server: const dir = host.value(ServerInfoKey).dataDir;
//   self.register(Routes, "GET /artifact", serve); self.register(Routes, "HEAD /artifact", serve)
//   (the "artifacts" resource is not a native: drop it)
```

### Findings, most severe first

**F1. Two plugins on different versions in one host can write wrong history; I challenge the decision on this.** The decision assumes "mixed versions within a host are the same situation as during a rollout". That is not true for `local` types: they never cross hosts, and they are not validated.
- Trace: commit `e16667441` added `maxImages` to `Conversation.submit` and chat-mode's use of it in one change, with no version bump (`chat/contract.ts:170`, `chat-mode/digest.ts:173`). Commit `79c5e20d5` added `entry` the same way (`contract.ts:166`).
- Suppose chat's worker setup throws on such a reload. Chat keeps its old code; chat-mode moves on, and its router calls the old `Conversation.submit` with `entry: chat.mention` (`chat-mode/worker.ts:164`).
- The coverage check admits it: an extra optional property is "covered" by an open TypeBox object. Old `submit` drops `entry` and writes a `p2.input` entry whose text is the digest, without `included`.
- Durable entries are permanent. `unmentioned` (`digest.ts:68-84`) never finds a boundary again, so every later mention re-quotes up to 100 messages. With `maxImages` dropped, every image of the digest is inlined.
- Fix: for a facet setup that throws, also reject the facets that hold that plugin's local types in the same revision on that host. Alternatively, make the coverage check require the provider to declare every property the caller's arguments declare, so this fails with `contract_mismatch` instead of being dropped silently.

**F2. There is no declaration for a source backed by a subscription, and Durable watches work only once.**
- A Durable `WatchHandle` has one `start` and a terminal `stop` (`durable/src/types.ts:902-904`). `watchSource` allows one subscription (`runtime/durable.ts:112-121`).
- Chat holds the watch as a resource and subscribes to it (`chat/worker.ts:158-176`). Under §12/§15, a reload keeps the resource (same version) and re-runs the factory and routines.
- The new subscription throws "supports one subscription", or the old unsubscribe has already called `watch.stop()`. Either way every transcript freezes after a chat reload.
- The pattern `CommitSignal` uses in chat-mode and artifacts (`chat-mode/worker.ts:88`, `artifacts/worker.ts:62`) attaches a handler inside resource `open`, which 14.5 forbids. §8 names "source readables via derive" but gives no API for one.
- Fix: add `self.source(name, { deps, open })`. It acquires the native per subscription and is restarted with routines. The derive keeps its last value until the new source delivers. Add a p2 `watchDoc` helper on top of it.

**F3. Derives have no previous value, and a reload resets the chat window for every viewer.**
- `windowStart` keeps the previous start within a 1.5× slack (`chat/window.ts:32-44`, using the `shown` memo at `worker.ts:167`). That is why new entries are small appends rather than a window shift on every commit.
- A pure `derive(sources, fn)` cannot express this. A closure memo is lost on every factory re-run, and so is the module-level `entrySizes` cache (`window.ts:17`).
- After a reload, each live conversation re-stringifies its whole active range (MBs on long sessions), possibly inside the one-tick publish. Every viewer then gets a window that may have moved, up to 512 KiB each.
- Fix: `self.derive(sources, (values, previous) => …)`, keyed by derive name so `previous` survives factory re-runs.

**F4. Shell as a job: object lifetime, output display and deduplication are unspecified.**
- **Lifetime:** `Conversation` is a referenced object with `linger: 30_000` (`chat/worker.ts:505`). Today, closing the object aborts the shell (`:186-195`). The design does not say whether a running job keeps its object alive. If it does not, `finish` has no object once the last tab has been closed for 2 min plus 30 s.
- **Display:** today the finished output stays visible until the `p2.shell` entry is placed (`:290-322`). When the agent is busy, that happens at the run's next boundary, which can be minutes away. If `run` waits for placement, `concurrency: 1` refuses the next `!cmd` with SHELL_BUSY. If it does not wait (§10's example), the output disappears until the entry appears.
- **Deduplication:** today the dedupe map keeps 100 keys (`:333-341`). The design does not say how long a finished run's key is kept, and §21 asks for "shell dedupe survives".
- Fix: running or finishing runs count as a reference to their object. Add `dedupe: { keep: N }` to `defineJob`. `liveShell` derives from `running` plus a singleton `LastShell` document, which a routine on `view` clears once the entry is placed (sketch above).

**F5. The drafts plan in §21 contradicts §7, and Stop is not atomic across Durable and Chord.**
- §21 says drafts are "persisted, keyed `conversation:authorId`". But keyed documents have no live readable, and `Drafts.drafts` must be live: web (`chat/web.tsx:362-370`), TUI (`tui.ts:340-348`), derive (`drafts/worker.ts:49`).
- Stop withdraws inputs in a Durable commit (`chat/worker.ts:435-441`), then writes other authors' texts in a separate Chord commit (`:537-541`). A crash in between loses exactly the text that persistence was meant to keep.
- Fix: a persisted singleton map (sketch above, a 1:1 port), plus a retention routine. Guests' unclaimed drafts otherwise grow forever. Optionally record the restore intent first, as a job (intent, then abort, then finish).

**F6. Session delete leaves plugin files behind.**
- Artifacts are stored under `<data>/artifacts/<session>` (`artifacts/store.ts:111`) and sent files under `<data>/downloads/<session>` (`files/downloads.ts:57-60`).
- Clone already has to hard-code these directories, plus uploads (`sessions/copy.ts:32`). §7's delete covers only tagged documents, the session database, the document storage and the catalog entry, so these files, which may contain secrets, stay on disk.
- Fix: a versioned server registry `SessionData`, where plugins declare per-session directories or cleanup. Both clone and delete use it.

**F7. A TUI facet reload drops chat state and closes unrelated overlays.**
- A `TuiSlots` swap disposes and recreates the surface (`runtime/tui.ts:473-478`). `ChatSurface` keeps uploaded `attachments` (`chat/tui.ts:376`), `replyTo`/`canReply` (`:87-89`) and `sending`/`waiting` on itself.
- After a chat TUI reload, the next send goes without the uploaded file. It may even reuse the same `requestId` from `runtime.submissions`, so the server deduplicates it as the earlier message.
- Any reload that changes the TUI command table also closes every overlay (`tui.ts:463-466`).
- Fix: move attachments and reply state into `TuiRuntime` and its swap snapshot, like drafts. Close only overlays opened by entries that changed.

**F8. Performance: chat-mode's waiting count is recomputed per viewer.**
- `ChatMode` is remote, so there is one object per principal, and each has `derive([chat.view], waiting)` (`chat-mode/worker.ts:173`). Each run reverses the whole view and scans it (`digest.ts:110`).
- That means viewers × entries work on every streaming commit. `CommitSignal` also runs its filter for every object on every harness commit.
- Fix: compute `waiting` once in the per-conversation `ChatModeSetting` (sketch above) and replace `CommitSignal` with `watchDoc` sources.

Checked with no issue found: conversations (broker retry, Durable request-ID dedupe, rollout parking), keep-alive and presence (the viewer resource becomes `host.references` plus the linger bit), Durable phases pinning `Extensions` tables, and natives (all become host values). The `instanceof` surfaces are already covered by 14.3.

### Migration cost

About 17 plugin files.
- **chat:** `worker.ts` about 150 lines touched (shell becomes a job, net about −40), `contract.ts` about 5, `tui.ts` about 25, `tui-commands.ts` about 5, `web.tsx` about 3.
- **chat-mode:** `worker.ts` about −50/+20; `tui.ts` and `web.tsx` about 10.
- **drafts:** `worker.ts` about 35.
- **conversations:** about 15 across three files.
- **send-file:** about 20.
- **artifacts:** about 40 across four files.
- **Total:** roughly 350–450 lines touched, net about −100.
- **Runtime:** about 80 lines for `self.source`/`watchDoc` and `TuiRuntime` attachments, plus whatever Chord needs for F2, F3 and F4.

**Does the design hold?** For these plugins, yes, once F1 (the setup-throw rule or the coverage check), F2 (`self.source`), F3 (`previous` in derive) and F4 (job ↔ object lifetime and key retention) are added, and §21's drafts entry is fixed. F6 is a privacy gap in §7, not a design flaw.

## Original ownership review after redesign-decisions.md, 5abe3f6d6

### p3 objects for chat, chat-mode, drafts, conversations, send-file and artifacts

I read `redesign-decisions.md` at `5abe3f6d6`. Two things change the shape of these plugins. First, a native object restarts on reload, which aborts the work running in it. Second, the ownership principle removes three things: the drafts plugin, the Durable chat-mode document, and files that two processes share on disk.

### Core objects

| Object `{address}` · host · kind | Owns · rules | API · used by |
|---|---|---|
| `Catalog {}` · server · pure | Session rows as persisted docs (title, env, cwd, archivedAt, a copy of the root model, scope). Rules: lifecycle order; relocate only under the worker fence; clone and delete call the owners' copy/delete hooks | `sessions`, `get`, `create`, `archive`, `restore`, `relocate`, `fork`, `clone`, `delete`, `rootChanged` (reported by Session) · `Sessions` views, broker, routes, chat web |
| `Sessions {}` · server · pure, one per principal | Nothing. Shows the catalog filtered for owner, guest or worker | session list, owner actions · web, TUI |
| `Access {}` · server · pure, one per principal | The grant (shares plugin) | `grant` · chat web, TUI |
| `Hosts {}` · server · native (worker processes) | Worker processes and their generations. Rule: one current generation per session | `current(session)`, start, stop · broker, status |
| `Session {session}` · worker · native (Durable harness, sqlite, scheduler) | The Durable store, the set of conversations, the location, the admission fence. Rules: a conversation's policy doc (`readOnly`, `followsSessionCwd`) is written in its creating commit; relocate only when fenced | `location`, `createConversation(init)`, `prepare`/`cancel`/`relocate`, `inspect` · Conversation, subagents, server lifecycle |
| `SessionEnv {session, location}` · worker · native (daemon or SSH connection) | Execution environments by cwd. Rule: never swapped; a relocation means a new address | `exec`, `at(cwd)` (local type, may take callbacks) · Session (Durable's env), Conversation shell, file index |
| `ConversationFeed {session, conversation}` · worker · native (Durable watch) | Nothing | `view` (complete) · Conversation only |
| `Conversation {session, conversation}` · worker · pure, local, `storeKey` | Its Durable content (entries, inbox, `pi.*` docs) through Session; the policy doc; a restored-drafts doc (persisted, by author); `ShellJob` runs plus a `LastShell` doc. Rules: input gates; read-only refusal; one request per author `requestId`; one shell at a time; only known models; withdrawn text goes back to its author | state: `view`, `window` (derive with `previous`), `model`, `liveShell`, `canReply`. methods: `submit`, `write`, `stop`, `dequeue`, `dequeueOwn`, `history`, `scan`, `entry`, `queued`, `latestAnswer`, `configure`, `compact`, `reset`, `abortCompaction`, `runShell`, `abortShell`, `costs`, `claimRestored` · Chat, chat-mode router, PeerInbox |
| `Chat {session, conversation}` · worker · pure, remote, one per principal | Nothing. Rules: canView/canSend; only the owner configures or resets; only the author or owner aborts a shell; stamps the author; runs `SendRouters` | v5 state plus `restored` (own texts only) and `canReply`; v5 methods plus `claim`, `costs` · web and TUI chat |
| `Composer {session, conversation}` · client · pure | Draft text, attachments, `replyTo`, pending request ID | get/set · chat surface, chat-mode chip |

### Plugin objects

| Object · host · kind | Owns · rules | API · used by |
|---|---|---|---|
| `ChatMode {session, conversation}` · worker · pure, local (chat-mode) | The switch as a persisted Chord doc (it is not tied to the transcript). Rules: only the owner switches; how a mention is composed | `enabled`, `waiting` (computed once per conversation), `set`. Registers the `SendRouters` entry "chat-mode", which also declares reply support. Remote face per principal: reader or owner |
| `ConversationBroker {}` · server · pure (conversations) | Nothing. Rules: sender and recipient not archived, no sending to yourself, current generation (asks `Hosts`), one retry | `query` · `Conversations` (worker face) |
| `PeerInbox {session}` · worker · pure (conversations) | Nothing. Rule: callable only by the server's broker | `send` (calls `Conversation(1).submit` with author `{kind:"peer"}`), `answer` (calls `latestAnswer`). Registers the `conversations` tool |
| `Downloads {session}` · server · pure (files) | `<data>/downloads/<session>` plus an index by conversation. Rules: 25 MiB cap, immutable IDs, viewers only | `save` (chunked), `list({conversation})`, `preview`, `GET /download`, `copy`, `delete` · send_file tool, route, TUI `/downloads`, web card |
| `Artifacts {session}` · server · pure (artifacts) | `<data>/artifacts/<session>` plus a per-conversation index doc. Rules: name, type and size checks, numbered immutable versions, CSP | `save` (writes file and index in one owner step), `list({conversation})`, `read`, `/artifact` route, `copy`, `delete`. Remote face `ArtifactList` · tool, web, TUI |

Keeping `Downloads` and `Artifacts` on the server means listing, previews and routes no longer start a worker.

### (a) Where today's code reaches past an owner

| Today | Replacement |
|---|---|
| chat-mode reads `ChatModeDoc`, the inbox and entries straight from the harness (`chat-mode/worker.ts:78-100,135-151`) | `ChatMode` doc; `Conversation.scan`, `entry`, `queued` |
| `PeerConversation` submits to the root itself and copies the gate loop (`conversations/worker.ts:133-149`); `answer` scans entries itself (`:152-183`) | `Conversation.submit` with a peer author; `latestAnswer` |
| Peer attribution is a `<mobile-conversation>` text prefix that `originOf` parses (`origin.ts:47-60`) | Peer input written as `p2.input` with a peer author, a format core owns (`input.ts`) |
| `DraftStore` is a separate plugin that Chat writes into (`chat/worker.ts:537-541`) | Restored-drafts doc in `Conversation` |
| send-file and artifacts write data files directly through the copied `files/downloads.ts` and `store.ts`, using the opaque `worker.init.dataDir` (`send-file/worker.ts:33,45`, `artifacts/worker.ts:25,37`) | `Downloads.save` and `Artifacts.save` methods |
| Clone copies a hard-coded list of plugin directories (`sessions/copy.ts:32`); delete has nothing | The owners' `copy`/`delete` hooks (registry `SessionData`) |
| chat-mode sets chat's UI state: `setCanReply`, `instanceof ChatSurface` (`chat-mode/web.tsx:636-642`, `tui.ts:62-63`) | `Chat.canReply` plus the `Composer` object |
| `/downloads` reads ChatSurface's tool views (`send-file/tui.ts:93-103`) | `Downloads.list` |
| chat calls `Sessions.configureSelf` for the root model (`chat/worker.ts:622-629`); `ConversationConfigured` registry | Session reports root agent changes to `Catalog.rootChanged` |
| Opaque natives used by chat: `HarnessConfig.models()` (`worker.ts:101,135`), `harness.environments`, `liveness` | `WorkerModels.model(ref)` (data), `SessionEnv`, Session's fence |
| `ReadOnlyConversations`, the `viewer` liveness resource | Policy doc (already decided); `host.references` |

### (b) Natives to split into their own object

| Native | Why |
|---|---|
| Durable watch, as `ConversationFeed` | If it stays inside `Conversation`, a chat reload restarts the object and aborts a running `!cmd` (a ShellJob). Split out, `Conversation` stays pure and its jobs and docs survive. |
| Harness and `SessionEnv` | A restart aborts every task and the SSH connection. They stay in core; only a base change (host restart) touches them. |
| Durable `ChatModeDoc`, `ArtifactDoc` watches | Not split: the data moves to Chord docs, so no watch is needed. |

### (c) What the principle cannot express or makes worse

1. **A rule whose data has another owner.** Two people send `@pi` at the same time. Both routers compute the same unmentioned set (`chat-mode/worker.ts:150-151`) before either mention is in the inbox, so both digests quote the same messages. chat-mode owns the rule, but `Conversation` owns the inbox. Fix: `Conversation.submit({ expect: inboxSeq })` as a compare-and-set, or let routers run on the conversation's line.
2. **Bytes through methods.** Today the tool writes the download directory directly. With one owner, the 25 MiB snapshot (`send-file/tool.ts:68-78`) travels from worker to server in 1 MiB chunks: base64 adds a third and needs memory on the phone. The wire size limit is still open.
3. **One owner, two stores.** `Conversation` owns both the inbox (Durable) and the restored drafts (Chord). Stop's abort and the drafts write are still two commits (`chat/worker.ts:435-441`, then `:537-541`); a crash in between loses the text. Fix: write an intent in a Chord tx first, then abort, then finish, as a job.
4. **Durable tools cannot use Chord objects.** `originOf` runs inside a Durable tool and must read Conversation entries itself (`origin.ts:31-71`). The core-owned input format keeps this to reading one shared format.
5. **Relocation swaps a native in place today** (`Execution.switch`, `runtime/worker.ts:431-451`), and the new rules forbid that. It becomes a new `SessionEnv` address per location, which works only because relocation requires that nothing is running.

### (d) Earlier findings

| Finding | Status |
|---|---|
| F1 mixed versions after a setup throw | Resolved: rollback is all-or-nothing per host |
| F2 one-shot watches, no source declaration | Resolved: `self.open`. It costs a restart, so the watch moves into `ConversationFeed` (b) |
| F3 derive without `previous` | Resolved. Still open: the module-level `entrySizes` cache (`window.ts:17`) is rebuilt on every reload (minor perf) |
| F4 jobs | Partly. `outcome()` was added. Still open: a job keeping its referenced object alive (`linger: 30_000`), how long dedupe keys are kept, and keeping the output visible until the entry lands (`LastShell` doc) |
| F5 drafts | The keyed-document conflict is gone (restored drafts become a doc in `Conversation`); atomicity remains, see (c)3 |
| F6 session delete leaves files | Open, listed in Open as `SessionDeleted`; proposed owners' hooks above |
| F7 TUI surface state lost on reload | Fixed by the client `Composer` object; the overlay closing stays open as "renderer reload" |
| F8 waiting computed per viewer | Resolved: `ChatMode` is per conversation |

## Additional discussion points and qualifications

These points were raised while investigating or sketching the reports above. They are retained here so the record includes recommendations and questions that did not become one of the final numbered findings. Where an item overlaps a report, the report gives the main trace. All are open recommendations unless their status is explicitly stated otherwise.

### Reload, subscriptions and derived values

- Original watch alternatives considered: acquire the watch inside `self.routines.custom`, or add a lifecycle-aware source helper that reacquires on every subscription. Opening a fresh watch after the old handler settles can catch up from the latest snapshot while readers keep the previous value. A permanently kept single-shot watch cannot be restarted merely by giving it a new wrapper. Status: superseded by `self.open` and native-object restart, both owner decisions; a separate feed remains a proposed boundary.
- The `CommitSignal` container subscribes to harness commits in its constructor, called inside resource `open`. That is behaviour inside a retained native. Logic changes to its predicate would otherwise stay in the old generation. Status: old resource concern superseded; prefer Durable document watches or move the app state into Chord docs where appropriate.
- Chat-mode's `enabled` and `waiting` are derived from separate readables, so a client may briefly see inconsistent values if their updates are not one atomic publication. This was considered a minor chip flicker, not a new blocking finding. Status: open wire/publication consideration.
- A fallback for window hysteresis was an in-memory document holding the window start rather than a reducer-style derive. Status: owner chose named derives retaining the previous value.
- Even with previous-value derives, rebuilding `entrySizes` on reload can still cause work proportional to the active transcript size. The original concern was JSON serialization and a possible large window diff for every viewer; not every derive necessarily runs during publish, so the synchronous timing needs measurement. Status: remaining performance question.
- Module-level caches, such as entry-size caches, must not be used for cross-facet identity. Copied pure modules are fine if their state is only a disposable optimization. Status: loader-D contract/pure-module restrictions were already decided in plugin-loading.md.

### Shell jobs, crash handling and lifetime

- The job's raw `running` array is not the old `ShellState | null` contract. An adapter derive must preserve the old UI fields (author, command, output, truncated, running, exitCode, cancelled, error). This is implementation work, not a reason to expose internal job records directly.
- A command and its subsequent Durable placement wait are different kinds of busy. Holding the concurrency slot through `submission.wait()` closes a race but changes today's ability to start another command as soon as execution ends. Preserve the UI semantics explicitly rather than treating every unsettled run as an executing process.
- The original design's keyed `ShellResult` documents can accumulate indefinitely: in-memory docs belong to an identity rather than just a live instance, and the example never retires them. Either retire results after placement or keep only a bounded singleton result plus a bounded dedupe history. Status: open retention policy.
- Persistent job keys must remain scoped to the stamped author (`${author.id}:${requestId}`), not only the client-supplied request id. The dedupe record must outlive a lost admission response sufficiently to stop a retry from rerunning a destructive command. Status: open lifetime/retention policy, existing author attribution remains required.
- The prototype sketch used a single `LastShell`. It was a recommendation for bridging the gap until transcript placement, not a completed design for arbitrarily many finished-but-unplaced commands. Status: open implementation detail.
- The existing shell catches execution errors and keeps partial output, strips one trailing newline, writes speaker attribution when output joins context, and clears live output only after entry placement. These behaviours need to survive a job rewrite.
- In-memory shell jobs disappearing after a worker crash match the previous process-local behaviour. `persist: true` can instead report `lost`; it cannot discover whether an unkeyed external command ran before the crash. Do not silently retry non-idempotent effects. Status: job sandwich/crash semantics were already decided in target-design.md.
- Keeping a running job alive and preventing relocation are distinct from counting viewers. A job should retain its owner until it settles; ending the type or explicitly stopping work may abort it. Status: proposed job-lifetime rule, not a known owner decision.

### Drafts and storage

- If drafts remain keyed by conversation and author, a readable/watch for one keyed document is missing from the original API. The storage eviction wording referring to documents that are "not watched" suggests such watching, but does not define it. A singleton live map is an alternative already allowed by the design. Status: open API question; the later per-conversation draft document is a recommendation.
- The next numeric draft id and additions must be committed together. A singleton `{ next, byKey }` is a small way to avoid a second counter transaction. Claims must choose and remove items within the transaction, not decide from a stale outside read.
- Long-lived in-memory keyed drafts need explicit retirement. Persisted unclaimed drafts for guests who never return need a retention policy too. No automatic garbage collection based only on reference disappearance was proposed.
- Tags for data inside a worker's per-session document store may be redundant for session deletion, because deleting that store removes all of it. Server-side per-session docs still need tagging or owner cleanup. Status: cleanup design remains open.
- A recorded restore intent before aborting a Durable submission is a proposed recovery protocol, not proof of cross-store atomicity. Recovery must distinguish an input that was actually withdrawn from one that raced into the transcript, or it can restore duplicate text. Status: open; shared Durable docs were explicitly left open by the owner.

### UI reload and cross-plugin interaction

- Replacing the web `Main` component identity remounts its subtree. Composer state and retained history survive only because their providers/caches are in host code. Local scroll/focus and artifact iframe execution state can still reset. An unrelated wrapper change can destroy a user's running HTML preview. Status: UI renderer reload versus leaving is explicitly open.
- `TuiRuntime` already keeps drafts, submissions and anchors outside `ChatSurface`; attachments, reply targets and in-flight view flags are exceptions. A proposed `Composer` is another way to move them outside replaceable renderers, not a claim that p3 must use that exact object or API.
- Closing the entire TUI overlay stack on every `TuiCommands` table change affects unrelated `/reply`, `/fork`, `/downloads` and `/artifacts` overlays. Track which entry opened each overlay and close only ones whose implementation changed. Status: open UI lifecycle recommendation.
- A `ChatSurfaceKey` typed surface was the old loader-D fix for cross-plugin `instanceof`. The ownership review instead proposed a downloads list API and `Chat.canReply` so those consumers need not reach into the surface at all. Status: avoiding cross-plugin class identity was already decided; the exact replacement is proposed.
- For reply support, alternatives considered included a client `ComposerFeatures` behaviour registry and a send-router contribution declaring reply support. In both alternatives, chat-mode should not mutate chat's private surface or composer flags directly. Status: proposed extension-point shape.
- A web activation failure currently replaces the view with a retry screen, and Retry uses `WorkerControl.retry()` to restart the worker. Retrying just the failed object reference may be sufficient under object backoff/retry semantics. Restarting the whole worker is a potential unnecessary disruption. Status: open low-priority recommendation.

### Ownership and core boundaries

- The shared conversation must not be instantiated separately for each viewer's principal if that would duplicate its owned data. The proposal was a stable shared local owner plus per-principal remote faces that authorize and filter; alternatively the contract system needs an explicit shared-data identity. Status: proposed boundary, not an owner decision.
- Rules on conversation data belong at its owner, including read-only and cwd-following policy. An authorized remote face may stamp the principal, but other entry points, including peer input, must not bypass the owner's checks. Status: ownership and creation-time policy are owner decisions; exact face/owner layering remains a recommendation.
- A session's catalog model should be a reported mirror of the root conversation's actual model, not a second independent authority updated only by one UI path. Session should report the change so plugin-originated changes also update the catalog. Status: proposed reconciliation.
- A server broker should check current worker generation through the worker-process owner, not inspect a private workers map. Likewise archive status is obtained through session/catalog operations and rechecked after startup. Status: ownership principle decided, exact methods proposed.
- Cross-session input should use structured core-owned author data. Parsing a model-facing text prefix leaks the input format into rendering and authorization code. A guest message must not inherit an earlier owner's authorization, and nested calls must inherit the initiating turn rather than the latest racing input. Status: proposed format; current security behaviour must be preserved.
- `originOf` doing a Durable commit-time scan is a boundary case: a persisted tool phase needs data from the transcript even though p3 must not hand Durable Chord v2 objects. A core-owned plain-data format or an execution API offering the appropriate read keeps that boundary narrow. Status: open shared-Durable-document/API question.
- A full Durable harness cannot simply be passed as a host value to every plugin under the new ownership principle. The first report's host-value sketch is superseded. Plugins need owner methods or narrowly scoped local callbacks returning data; Durable receives its own plain types. Status: owner decided no cross-plugin natives and p3/Durable type separation.
- Model metadata can be returned as plain data by a model owner, but the harness needs streaming and synchronous model-access APIs as well. Replacing `HarnessConfig.models()` with only `model(ref)` does not yet solve the whole integration. A worker-side adapter around owner methods or a stable facade is still needed. Status: open interaction with models, not resolved by the object table.
- The catalog, session and conversation proposals must not create a core god object. Session owns its conversation set and location; each conversation enforces its own content policy. Small operation-specific methods are preferable to exposing the harness and bypassing the owner. Status: owner explicitly warned against a core god object.

### Blobs, copy/delete and native placement

- Keeping file bytes under one server owner avoids starting a worker for HTTP downloads, artifact lists or previews. Workers can upload snapshot chunks using the owner API. An index by conversation also removes the TUI downloads dependency on the loaded transcript. Status: recommendation, with transfer trade-off still open.
- Conversely, putting blob ownership on the worker makes HTTP reads depend on worker startup and transporting the bytes back to the server. The owner location must account for both producers and readers, not simply follow the current plugin location.
- The server-owned artifact proposal moved the per-conversation index out of Durable because it is independent of compaction/rewind. Preserve its special fork semantics explicitly: forks start with an empty index, while a whole-session clone copies retained files/index data. Status: proposed design; the ownership decision alone does not settle persistence semantics.
- Saving an artifact file and index through one owner narrows the protocol but does not automatically make filesystem publication and document commit atomic. The earlier discussion noted the crash after `Artifacts.save` and before `api.commit` (`artifacts/tool.ts:44-53`); publication/recovery still needs a deliberate protocol. Status: open file-format/storage transaction issue.
- A `SessionData` registry should be an extension point invoking owners' copy/delete operations, not a way for core to write into plugin-private directories. This distinction follows the ownership principle. Status: SessionDeleted remains explicitly open.
- Artifacts/Downloads wrappers holding only a directory path are not expensive long-lived natives. File handles opened inside a request can be closed in `finally`; a path-only class need not turn the whole owner into a native object. Status: implementation recommendation; classification of transient operations must remain consistent with the factory principle.
- Splitting native objects inside the same reloaded plugin is insufficient: the new design restarts every native object of that plugin. A watch/feed that must survive chat reloads must live in a separately loaded core/plugin boundary. Status: splitting expensive natives into separate plugins is owner-decided; this is its application to chat.
- Environment identity changes on relocation rather than swapping a native value. Existing connections for another cwd may be retained only as their own owners. The old environment can end once references and fenced work are gone. Status: proposed address/lifetime arrangement under the owner's immutable-native rule.

### Checks that did not become new findings

- Existing peer-send dedupe uses source session plus the Durable task/call request id. The broker can retry once after a recipient worker disappears without duplicating an admitted send. Registry snapshots pinned per Durable phase preserve the old tool implementation through a reload. No additional problem was found in that trace.
- Registry versions/adapters remain necessary for tools, routes, renderers, commands and send routers. Under the first design, `SendRouters` and `TranscriptEntries` needed an explicit version. Their behaviour remains an extension point, not a policy registry for someone else's data. Status: versioned immutable registries already decided.
- The original `viewer` resource should disappear in favour of reference-based presence, filtering lingering holds for viewer counts but still counting them for worker keep-alive. Status: reference-based direction already in target-design.md; link-drop/linger/count-per-origin details remain open in redesign-decisions.md.
- Routine serialization prevents old and new handlers both reconciling the same pending action during reload. Commit-wait loops should exit when their signal aborts. Status: serialized routines were already decided; overlap/latest policy remains open in redesign-decisions.md.
- No additional issue was found with transcript entry display registrations shared between web and TUI, server route authorization during an already running request, or attributed shell input when model context is included.
- The initial migration estimate assumed porting p2 in place. The owner later explicitly chose isolated p3 with no migration. The subsequent object list was itself a proposal, not a requirement to preserve p2's plugin layout; the functionality-map step was requested to rethink those boundaries from behaviour instead.
