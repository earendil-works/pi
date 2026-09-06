# Worked Example: `bash` End to End

One tool through every layer. `execute` is simplified — timeout validation,
cancellation and exit-code branches are elided. Everything on the output path is
shown.

Layers: exec env → `ToolOutput` sink → harness events → durable storage → lane
state → facet → wire → consumer.

---

## 1. The tool

```ts
// packages/agent/src/harness/tools/bash.ts
export interface BashToolDetails { spillPath?: string; truncation?: ShellOutputTruncation }

export function createBashTool(): AgentHarnessTool<ExecutionToolContext, typeof bashSchema, BashToolDetails> {
  return {
    name: "bash",
    parameters: bashSchema,
    output: { retain: "tail", maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },

    async execute(_id, { command, timeout }, signal, out, context) {
      const env = context.env;
      let view: ShellOutputView | undefined;

      const result = getOrThrow(await env.exec(command, {
        cwd: env.cwd,
        inheritEnv: true,
        timeout,
        capture: { limits: this.output, spill: true },
        onUpdate: (u) => {
          view = applyShellOutputUpdate(view, u);
          if (u.kind === "append") out.write(u.text);
          else out.replace(view.text);
          out.details.truncation = view.truncation;
          if (view.spillPath) out.details.spillPath = view.spillPath;
        },
      }, context));

      if (result.spillPath) out.details.spillPath = result.spillPath;
      if (result.truncation.truncated) out.write(`\n\n[${describe(result.truncation)}]`);
      if (result.exitCode) throw new Error(`Command exited with code ${result.exitCode}`);
    },
  };
}
```

What is gone from today's implementation: the rolling `tailOutput` buffer,
`truncateTail`, `ensureFullOutputFile`, `createTempFile`,
`BASH_UPDATE_THROTTLE_MS`, `BASH_CHECKPOINT_INTERVAL_MS`, `updateDirty`,
`lastCheckpoint`, `scheduleOutputUpdate`, `emitOutputUpdate`,
`clearUpdateTimer`. About 40 lines of tool-local machinery, replaced by a capture
policy every tool gets.

`execute` returns `void`. `details` is one field, set once — and note the tool no
longer computes `truncation`, because the env owns the window and the tool no
longer knows what was dropped.

## 2. The exec env caps at the source

`env.exec` applies `ShellOutputLimits` where the bytes originate. For a sandbox host
that means `cat 1gb.txt` never ships 1 GB to the agent machine, and the spill
lands where the model's own `read` and `grep` run. See [`execenv.md`](../03-execenv/execenv.md).

The initial state is a bounded `replace`. Growth emits `append`; a moving tail emits `slide { drop, text }`; complete turnover falls back to a bounded `replace`; metadata moves totals and spill paths without resending text. The adaptive publisher keeps small slides responsive and spaces cap-sized turnovers according to their encoded size.

## 3. The sink

`ToolOutput` folds those into `ToolOutputState`:

```ts
{
  content: [{ type: "text", text: "…the retained window…" }],
  details: { spillPath: "/tmp/pi-session-x/bash-8f2.log" },
  usage: undefined,
  addedTools: undefined,
  terminate: false,
  truncation: { truncated: true, truncatedBy: "bytes", totalLines: 8123, totalBytes: 262144 },
}
```

`out.write(text)` appends to `content[0].text`; `out.replace(text)` assigns
the whole retained view when the env sends a `snapshot`, because an append cannot
express eviction. The tracker (`delta.md`) records intent either way: an append is
an `a`, and a window slide assigned wholesale becomes `t` + `a` via verified
overlap detection.

## 4. Ops

A 256 KB build over ~20 flushes, 50 KB window:

The first batch is a base batch — it begins with `r`, carrying the initial state. Everything
after is deltas. The repeated content path is interned on its second use, and
consecutive ops on it omit the id entirely:

```jsonc
[["r",{"content":[{"type":"text","text":""}],"details":{},"terminate":false,"truncation":{…}}]]

[["a",["content",0,"text"],"make: Entering directory …\n"]]
[["#",0,["content",0,"text"]],["a",0,"cc -c src/a.c …\n"]]
[["a",0,"cc -c src/b.c …\n"]]
…
[["s",["details","spillPath"],"/tmp/pi-session-x/bash-8f2.log"]]
…
[["t",0,4096],["a","cc -c src/z.c\n"],["s",["truncation","totalBytes"],262144]]
```

Details are one `s`, in one flush out of twenty. The `t` + `a` pair is the window slide. The current tracker recovers it by verified overlap; production remeasurement shows the generic path is already negligible, so no explicit append/truncate producer API is added ([decision](../01-delta/append-decision.md)).

## 5. Harness events

```ts
{ type: "tool_start",  toolCallId: "call_7", toolName: "bash",
  args: { command: "make -j8" } }

{ type: "tool_update", toolCallId: "call_7", ops: [ … ] }

{ type: "tool_end",    toolCallId: "call_7", isError: false }
```

`tool_start` is identity only — no `caps`, no `initial`. The first batch is a base
batch, so the initial state arrives on the update channel, and the caps are
already inside it as `truncation.maxBytes` / `maxLines`.

`tool_end` carries no content and no details. Every byte already went out;
re-sending would duplicate any images.

## 6. Durable storage

`pendingToolOutput(operationId, "call_7")`, **ephemeral-scoped** to the operation,
so it lives in `<session>.op_….jsonl` and is retired on settle rather than
persisting in the main log forever. Retirement is a main-log `retireScope` record,
so it commits atomically with the settle writes; the unlink is a consequence of
replaying that record, not part of the transaction ([scopes.md §5](../02-scopes/scopes.md)).

A `list<WireOp[]>`, one encoded batch appended per flush, base batches tagged `"base"` so recovery reads backwards with `stopAtTag` and stops there ([scopes.md §11](../02-scopes/scopes.md#11-list-tags-and-stop-conditions)). The tracker emits structural ops; the producer calls `rebase()` periodically to write a capped root replacement and bound recovery replay. The durable interval is a sink policy. Shell capture controls only source-state and transport publication; memo, terminal, and recovery-base flushes are forced by `ToolOutput`.

Recovery seeds a fresh `ToolOutput` from that state — it does **not** delete it,
which is what `clearReplayCheckpoint` does today and is a bug
(`harness-tools.md` §7.4). If bash memoised "spilled to /tmp/…" and crashed, a
replay that discarded the state would create a second spill file and lose the
first.

The memo write and this checkpoint commit in the same transaction. Both are
ephemeral-scoped, so both land in the same sidecar — and the type system rejects a
commit that mixes scopes, so this cannot regress silently.

## 7. Lane state and the facet

```ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void {
  switch (event.type) {
    case "tool_start":
      view.operation.tools.push({ id: event.toolCallId, name: event.toolName,
                                  args: event.args, output: undefined });
      return;
    case "tool_update": {
      const tool = view.operation.tools.find((t) => t.id === event.toolCallId);
      if (tool === undefined) return;                  // host will send a base batch
      tool.output = apply(tool.output, event.ops);
      return;
    }
    case "tool_end": {
      const i = view.operation.tools.findIndex(t => t.id === event.toolCallId);
      if (i >= 0) view.operation.tools.splice(i, 1);
      return;
    }
  }
}
```

Plain mutation, no Immer, no return value. An event for a tool the view has never
seen simply does nothing; the host sends a `replace`.

A lane facet runs this same function under the tracker, so the facet's own ops
fall out against **its** shape — which need not be `LaneView` and generally is
not. The facet never writes an op.

## 8. Wire and consumer

```jsonc
{ "seq": 0, "ops": [["r",{"transcript":[],"operation":null}]] }
{ "seq": 1, "ops": [ … ] }
```

One shape: a batch of ops. The first is a base batch — it begins with `r` —
and everything after is deltas. A gap, a reconnect, a provider
reload, or a fold that could not apply all take one path: send a fresh `replace`.

The consumer is `apply` — six verbs, no domain knowledge, no library, no tool
code, against a plain mutable object it owns.

## 9. What this run costs

256 KB of output, ~20 flushes, 50 KB window:

| | today | this design |
|---|---|---|
| durable writes | full `AgentToolResult` per checkpoint | structural ops plus explicit periodic capped base batches |
| durable location | main log, forever | sidecar, unlinked on settle |
| wire per flush | whole snapshot | one `truncate` + one `append` |
| details written | rebuilt whole, every flush | one `set`, once |
| truncation logic | in `bash.ts` | in the exec env, shared by all tools |
| spill location | `/tmp`, OS-cleaned | exec env, session-scoped |

The details row is the one worth dwelling on. Nothing about bash's details
changed — they were always small. What changed is that they stopped riding inside
a container replaced wholesale on every update, which is why no tool anywhere
currently bothers to mutate them incrementally.
