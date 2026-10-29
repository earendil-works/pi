---
title: Chord v2: a guide to building apps that reload
cover: Chord v2 / A Guide
kicker: A guide · Chord v2 target design · 2026-10-20
subtitle: How to build an app like p2 from nothing on Chord v2 and pi-durable, one object at a time, so that new plugin code takes over while the agent keeps running
stats:
  - 11 | layers in the rebuild, L1 to L11
  - ~1,300 | lines built so far (L1 contracts)
  - 6–7k | target size of Chord v2, without tests
  - 0.004 ms | Delta's apply per small change
note: |
  This guide teaches the **designed** API of Chord v2 (`packages/chord/src/next`, export `@earendil-works/chord/next`)
  from `packages/chord/docs/next/design.md` and the newer decision log `packages/chord/docs/next/decisions.md`, which wins
  where the two differ. Most of it is **not built yet**: a first kernel of about 10k lines is frozen as a reference and
  Chord v2 is being rebuilt layer by layer; only the L1 contract layer exists (`src/next/contracts/`, commit
  `7d2bb8ea8`). Code in this guide is therefore the target, not something you can run today. Every chapter says what is
  built. API names are working names. Notes marked *review* are points that are undecided, or where the sources
  disagree; they name the files. The reader is assumed to know pi-durable; Chord is explained from the start.
colophon: Chord v2 · a guide · first edition · 2026-10-20 · based on design.md (target design v2), redesign-decisions.md (review rounds 2 and 3), chord-next-walkthrough.md, layer-1.md, contracts/README.md, the p3 functionality map, questions.md and the pi-durable README
---

# Before we begin {.preface}

It is late in the evening. Mario is on his phone, connected to his laptop at home through the Radius relay. In session
S1 the agent is twenty minutes into a refactoring; right now it is running a test suite through `bash`. A colleague,
Ann, follows the session read-only from her own browser. Mario notices that the notes panel sorts notes the wrong way
round. He fixes one line in the notes plugin on the laptop and presses **Reload**.

What should happen is easy to say. The notes panel on both screens shows the new order. The test run keeps running. The
agent's turn continues as if nothing happened. Ann's view does not flicker into an error. Nothing that was written is
lost, and no process restarts.

The obvious ways to get there fail. **Restarting the processes** loses the turn in flight, the open terminal and every
connection; pi-durable would resume the turn, but the test run and the connections are gone. **Hot-swapping modules**
in place, as front-end tooling does, leaves the old code alive in closures, timers, event listeners and sockets that
nobody knows about: the old sort function keeps running inside a callback someone stored, a file watcher opened by the
old code is never closed, and two versions of the plugin now write the same data without any order.

Chord v2 is the runtime that makes the first outcome normal. It does so by being strict about one thing: **every piece
of state, every open OS handle and every piece of running work has exactly one owner, an object, and objects only
declare what they need.** Chord itself activates, connects, reloads and ends them. Because Chord knows every timer,
watcher, transaction and reference an object has, it can swap the object's code while its data stays, restart only
what touches the operating system, and route calls between browser tabs, the server and per-session worker processes
without the plugin author writing any of that.

This guide teaches Chord v2 by building an app called **Studio**: a small version of p2 (Pi Mobile), with a server,
one worker process per session, browser tabs as clients, and an agent from pi-durable on each worker. The first
chapters grow one plugin, `@studio/notes`, until it uses every concept; the last three chapters assemble the rest of a
p2-like app from the same parts.

:::review | Review: what exists today
Nothing in this guide runs yet except the contract layer. `packages/chord/src/next/contracts/` (L1 part 1: `remote`,
`local`, `method`, `evolve`, `checkAccepts`, the schema helpers) is built and reviewed. The rest of L1 (inputs,
argument checks, principals, errors) is a draft spec (`packages/chord/docs/next/layer-1.md`). The frozen kernel in
`src/next/*.ts` implements an older version of the design (host values, a development freeze, JSONL storage,
descriptions on the wire); do not read it as the target. Build on the design, not on the frozen code.
:::

## Ten things to know

:::findings
1. **An app is a tree of hosts.** One server, any number of workers it starts on demand, any number of clients (tabs,
   TUIs) that connect to it. Clients reach workers only through the server, which relays.
2. **Objects are the unit of everything.** An object type is a contract (name, input, placement, members, version); an
   object is one instance per input and caller. The first `get` creates it, later gets share it, the last release ends
   it.
3. **Factories declare, Chord activates.** A factory is synchronous: it declares documents, references, derived
   values, OS handles, routines and jobs through `self`, and returns the members. Chord opens, binds and starts them,
   and undoes them in reverse.
4. **Links stamp who is calling.** A caller's data never says who it is; the link it arrived on does. Each caller gets
   its own object and the variant of members it may use.
5. **Shared data lives once, behind views.** A `local` shared store holds the data; per-caller `remote` views expose
   what each caller may see. Only stable identities persist documents.
6. **State changes only in transactions.** Documents are JSON values written in `self.tx`; commits are atomic for
   every viewer and travel as small operations, never as whole values.
7. **Failures look like disconnects.** A reference survives link drops, restarts and failures: calls park or fail,
   values stay readable, and Chord retries by itself. There are no request ids.
8. **Everything long-lived has a declared form.** Standing behaviour is a routine, work that outlives a call is a job,
   input from a person is a flow, behaviour from other plugins comes through a registry. Nothing else may hold a timer
   or a callback.
9. **Reload swaps pure objects in place and restarts native ones.** Objects without OS handles get the new code with
   their data and running work intact; objects with OS handles close and reopen them. A broken change leaves the whole
   host on its old code.
10. **pi-durable runs inside a core object.** The agent harness is a host-lifetime object on each worker; models,
    environments and tools reach it through registries, and tools reach Chord through `chord(fn, context)`.
:::

## Words used throughout

A **host** is one participant of the app: a process, a browser tab or a Durable Object, identified by a logical
identity and an **incarnation** that changes on every start. A **link** connects two hosts. The **server** is the one
addressable root host; a **worker** is a host the server starts for one session; a **client** is a tab or TUI, not
addressable. A **plugin** is a directory with a `package.json`; its code for one kind of host is a **facet**. **Base
code** is the app's own code (Chord calls its facet the core facet); it restarts the hosts when it changes, while
plugins reload. An **object type** (or **contract**) describes objects; an **object** is one instance; its **input** is
its key among objects of that type, and its **placement** computes from the input on which host it lives. A **factory** builds an
object; **`self`** is what a factory declares through. A **principal** is who calls, stamped by the link; a
**variant** is the set of members a principal gets. A **reference** is what `get` returns. A **readable** is a value
plus its ordered changes. A **document** is a named JSON value an object owns, written in a **transaction**. A
**derive** is a value computed from readables. A **native** is an OS-level value (a socket, a watcher, a process)
opened with `self.open`; an object with natives is a **native object**, one without is a **pure object**. A
**routine** is standing behaviour, a **job** is owned work that outlives its call, a **flow** is input into running
work. A **registry** is an owner's extension point, filled with **contributions**. **`ctx`** is what every call
receives: cancellation, caller, call-scoped references. A **reload** swaps a plugin's code inside running hosts; a
**restart** ends a process; a **revision** names the complete code set the hosts run.

:::note | Reading the code in this guide
Imports are shown once per file and then omitted. `obj`, `str`, `arr` and friends are Chord's schema helpers (they
return ordinary TypeBox schemas). Helper functions that belong to the app (`authenticate`, `watchDir`, `uuidv7`) are
named and not shown. Where the design gives no name, the guide says it uses a working name.
:::
