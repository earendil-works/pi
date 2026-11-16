# p3 efficiency: findings from p2 and what p3 does about them

Requirement (owner, 2026-11-09, `decisions.md` "Efficiency is a requirement"): dozens to hundreds of session workers on
one reasonably beefy machine, and a super snappy UI. Findings below are from p2's perf work (session 80ee9c44 "fucked
up perf" and its subagent `worker-mem`, 2026-11-09, measured on the phone, Node 26.3.1); `worker-mem`'s full report is
still to come and will be added here.

## 1. Memory per worker

Measured: live p2 workers use 170-290 MiB RSS; about 85% is private anonymous memory (V8 heap). The base cost is about
170 MiB whatever the session's size; a large session (875 MB store) adds 45-90 MiB. An empty worker: 215 MiB RSS, a
109 MiB live heap, made of:

| What | MiB | Cause |
| --- | --- | --- |
| arrays (inferred: parsed source-map mappings) | about 56 | workers run with `--enable-source-maps` (chord `workers.ts`) on a base bundled with `sourcemap: "inline"` (chord `workers/base.ts`); Node decodes the map into one small array per mapping once a stack is formatted |
| the bundle's source text | 13.7 | a 7.2 MB file held as a two-byte string |
| the inline map and its decoded mappings string | 5.4 | |
| the program itself (objects, code) | about 34 | |
| outside the JS heap (young generation, code space, malloc, sqlite) | about 65 | being split by `worker-mem` |

What p3 does (kit changes in `packages/chord/src/node/workers/`, each measured):

1. **No source maps loaded in workers by default** (about -60 MiB per worker): stacks name bundle positions; a map file
   beside the bundle is read only when a developer asks for it (an option of the workers component, off by default).
2. **A smaller worker base:** lazy chunks for everything a fresh worker does not need at start (providers, code mode,
   esbuild never), and a one-byte (ASCII) source, so the text costs half.
3. **Heap settings per worker kind** (young-generation cap, `--max-old-space-size`, possibly `--optimize-for-size`),
   chosen from measurements, not guessed.
4. **A memory and startup budget per worker,** measured by a test on slayer and on the phone, and reported in each
   step's spec.

## 2. UI snappiness and bytes on the wire

Measured switching between a main conversation and a subagent in p2, through ngrok to the phone: the view is ready
after 0.9-1.2 s (the owner sees about 2 s). Each switch receives one frame of 1,560 KiB. On loopback the same objects
are live in under 150 ms. What a fresh hold costs: `Subagents` 1,109 KiB (all children of all sessions, archived and
one-shot ones included, each with its tool list), `Models` 339 KiB, `Sessions` 49 KiB, `Envs` 12 KiB; a chat window of
98 entries 150-290 KiB.

Causes: the page-wide objects were held inside a component keyed by conversation, so every switch released and held
them again; two holds of one object on one host are two wire holds, each with a full snapshot and its own delta
stream; compression at the origin was off (p2 never passed `compression` to `createHost`); lists were global instead of
per session.

Rules for p3:

1. **Page-wide objects are held once, outside every keyed subtree** (a page-level holder; components read from it).
   Switching a session or a conversation holds only what that view shows.
2. **Lists are per session or paged.** No object returns all children of all sessions; a view's state is bounded (a
   window or a live query with a limit).
3. **Compression at the origin on every Node host** (`createHost({ compression })`). The test flake first suspected
   in it is unrelated: the same p2 test fails under load on a clean checkout too (perf session, 2026-11-09).
4. **A byte budget per common action** (switching sessions, switching conversations, opening the page), measured in
   tests through a real page.

## 3. A Chord change under discussion: references sharing one wire hold

Proposed by the perf session, not yet written up. The kernel shares one wire hold and one replica among a host's
references with the same address, principal, incarnation, type, version and fingerprint. Every `host.hold` and `get`
still returns its own reference (its own release, state, watches and calls); only the remote object underneath is
shared, and the wire hold ends when its last reference does. Holds made by an activating object (`self.get`, carrying
its activation chain) are not shared.

What it fixes: N components showing one object cost one snapshot and one delta stream, not N. What it changes: the
provider sees one holder per host per (address, principal) instead of one per reference, which changes design §3
("every reference is a request with one holder") and §19 (presence). It is different from step 0a's rejected UI table
(decision "A reloaded UI part shows its loading state"): components keep their own references, so no leases or
borrowed references are needed.

Not part of it: keeping the hold after the last reference ends. That would be a consumer-side linger, rejected by
decision D8 and design §19/§31. Hoisting page-wide holds (section 2, rule 1) covers the remount case instead.

The owner agreed to design it (2026-11-09: "sounds ok"). Next: a design note, the full review (one reviewer adversarial, one
against design.md), and a build with the reference, recovery, revocation, retry, too-large and reload cases tested.
