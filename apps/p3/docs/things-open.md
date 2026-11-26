# Things: what is still open (for Mario and Armin, 2026-11-24)

The two reviews of the things model (by Fable and Astra, 2026-11-23), merged, as
they stand after the decisions of the night of 2026-11-23 (`follow.md`; `apps/p3/docs/base.md`, "Things"). Then a
ninth point: how a session gets things without anyone adding them by hand.

Each point: the problem, an example, the choices with what each costs, and a recommendation. Nothing here is built;
the builders were told not to make any of it worse.

## Settled last night (no longer open)

- **Anyone could make a thing of any kind** (Fable 1, Astra 1): a write guest or the agent added a second
  `tools.coding` with `shell: true`. Settled: a kind says how its things come to exist (`content`, `person`,
  `plugin`); the store refuses the rest.
- **The agent making things for people, and keeping them** (Fable 4, Astra 1): gone. The agent makes only content,
  with one tool (now the things plugin's `make_thing`). Each kind keeps its own list tool (decided).
- **Apps could not name "the Pi's coding tools"** (Fable 6): `ensureThing`, `things.ofKind`, and following.
- **Adding a thing by knowing its id** (Astra 4): `add` takes only a thing the caller manages; a second add of the
  same thing is refused, so it cannot change who linked it or its options.
- **`base.md` contradicted the model** (Fable 7): rewritten; the checklist example is corrected (the agent can read
  items, 500 items is a stated limit, a tick of an unknown item says so).

## 1. Content's options limit no writer, and "keep" takes content over (Fable 2, Astra 6)

**Problem:** every writer of a session manages its content, so options on content stop nobody who writes.

**Example:** a club chat has a "Plan" checklist made for nobody, with `check: false` for players. A player changes
their own options to `check: true`. Or keeps the Plan: now they own it, can link it elsewhere, and can delete it.

| Choice | Cost |
| --- | --- |
| A. Say it: "only an owned thing limits writers"; apps make what they limit for a group or the Pi (`base.md` says so now) | easy to forget; nothing stops a kind's options form from promising a limit that is none |
| B. A plus: options for one member exist only on owned things; content has one options object for everyone and one for the agent | Anna cannot make the agent's notes read-only for Leo until she keeps them |
| C. Keep copies the content instead of handing over the original | every kind needs a copy hook; two things drift apart; does not fix the options |

**Recommendation: B.** It turns the sentence into something the store checks, and "keep it first, then limit" is one
rule people can learn.

## 2. "Remove" deletes content without saying so (Fable 3)

**Problem:** removing content from its session deletes it for good; removing an owned thing only unlinks it. One
verb, two outcomes.

**Example:** the agent drew on a canvas for two hours. A writer clicks "Remove". Nobody owns it: it is gone.

| Choice | Cost |
| --- | --- |
| A. `remove` refuses content; `delete` is the only way; the page shows "Delete" for content, "Remove" for owned things | one more refusal for callers to handle |
| B. As now, with a confirmation in the page | apps and scripts still delete through "remove" |
| C. Removed content stays restorable for some days | a new state, a sweeper, storage |

**Recommendation: A.** Also say plainly that content lives in exactly one session (`add` already refuses to link it
into a second; `SessionsStore.create` with `usingThing` should too). Then "gone with its last link" becomes "gone
with its session, or when deleted".

## 3. Add, the last remove, keep, and follow with keep at the same moment (Astra 2, and round 2)

**Problem:** who may act is checked first (`things.ts`), the write happens after (`store.ts`); between the two the
thing may have changed.

**Example:** Ann and Ben both click "Keep" on the same canvas. Both pass the check "nobody owns it". Ann's write
lands, then Ben's: Ben owns it, and it vanishes from Ann's things. Likewise: a remove of the last link beside an add.

**A second case, the same shape (Astra, round 2):** `follow` with `keep` reads the old party's things first
(`followedNow` in `store.ts`), then links them in a later transaction. Ann is the followed party; her inbox is "in
all my sessions". The owner stops following her with keep. Between the read and the write Ann is removed from the
session. Keep still writes a link for her inbox: the session has the inbox of someone who left, for good.

| Choice | Cost |
| --- | --- |
| A. Each store write names what it expects (`keepThing({ thing, owner, from })`) and refuses inside its transaction when that no longer holds | each caller handles one more refusal |
| B. Move the whole check into the store's transaction | the check reads the people plugin, which a transaction may not call |
| C. Leave it: the last write wins | rare, but a keeper silently loses a thing |

**Recommendation: A**, for `keepThing` first. For add beside the last remove: both run inside the one store, and we
believe Chord runs one object's transactions one after another; write the test before changing anything. For
`follow` with keep: choose the things and check that the party still writes inside the transaction that links them
(the members and the things are the store's own tables; the party's owner flag and groups are read before it, and
the transaction links nothing if the membership it relied on is gone).

## 4. A thing exists before its kind has finished with it (Astra 3)

**Problem:** the base commits the thing, then calls the kind's `create`; it deletes the thing, then calls the kind's
`delete`. A crash or an error in between leaves the two apart.

**Example:** a login's `create` stores its token after the commit. The server stops in between: a login that lists
fine and has no token. Or a checklist's `delete` throws: its 400 items stay forever (the error is only reported).

| Choice | Cost |
| --- | --- |
| A. A state on the thing (`creating`, `ready`, `deleting`); only ready things show; a routine finishes or cleans up after a restart | a state machine in the base; every hook must be safe to run twice |
| B. Kinds treat a thing with nothing in it as empty ("not signed in"), so `create` may fail safely; the base keeps a durable list of things whose `delete` has not succeeded and tries again at start | `delete` must be safe to run twice; a half-made login needs the person to sign in again |
| C. Leave it | orphaned items, half-made logins |

**Recommendation: B.** It is the smaller change, and a `person` kind's creation view already runs its sign-in with
the plugin's own objects before the thing is made.

## 5. What stays when someone leaves (Fable 5, Astra 5)

**Problem:** a linked thing stays in a session after its owner can no longer work there.

**Example:** Anna is in the family session through the group Parents and adds her inbox. She is taken out of
Parents. Only a direct member's removal unlinks their things, so the inbox stays readable there, and "My things"
offers her no way to take it out. (Followed things do not have this problem: they stop the moment the party stops
writing.)

| Choice | Cost |
| --- | --- |
| A. Unlink on every loss of access, through groups too | a fan-out from the people plugin into every session on each group change; things vanish from sessions as a side effect |
| B. Nothing automatic; whoever manages a thing can take it out of any session from "where it is used" | a leak until they notice and act |
| C. One rule for linked and followed alike: a session has an owned thing only while its owner writes in it (the Pi's always). The link stays and shows as paused | one more read per thing's admission; a coach cannot put the coaches' inbox into a session the coaches' group is not in |

**Recommendation: C, plus B's button.** No cleanup jobs, a stale link stops admitting at once, and it is the rule
following already has.

## 6. What "where it is used" shows (Astra 7)

**Problem:** whoever manages a thing sees every session it is in, also sessions they may not enter. (The paging and
the index Astra asked for are in the contracts: `things.owned`, `links.ofThing`.)

**Example:** the owner adds Anna's notebook to one of his sessions. Anna's "where it is used" shows that session's
id and who linked it.

| Choice | Cost |
| --- | --- |
| A. Show every use: it is their thing, they should know | tells a non-member that a session exists |
| B. Show the sessions the caller may enter, and "and 3 more" with "remove from all" | they cannot see where exactly |
| C. With point 5's rule C the others are paused links anyway: show them as a count | depends on point 5 |

**Recommendation: B** (it becomes C if point 5 goes that way).

## 7. A kind can forget that a reader only reads (Fable 8)

**Problem:** "a reader is always a reader" is one line each kind writes by hand; the types do not ask for it.

**Example:** a kind writes `if (!options.check) return reader` and leaves out `access === "read"`. A read guest
gets the variant with `tick`.

| Choice | Cost |
| --- | --- |
| A. The admission value is tagged: `{ access: "read" }` or `{ access: "write", options }`. A reader has no options, so the code cannot skip the check | a contract change for three kinds; a reader's view cannot show what the options would allow |
| B. A helper, `writerIf(admitted, (o) => o.check)` | a kind can still not call it |
| C. A test helper every kind's tests call: a reader's object has only the reader's methods | catches it only when the author runs it |

**Recommendation: A.** It is the only point where the type system can carry the rule.

## 8. Tools made from an old list (Astra 8)

**Problem:** a kind builds its tools from the session's things as they were; a call must be judged by the thing as
it is now.

**Example:** checklists A and B both allow ticking. A is removed; `checklist_tick` stays for B. A call naming A must
fail. Or A's options change to `check: false` while a call runs.

| Choice | Cost |
| --- | --- |
| A. The rule and a test in every kind: each call asks the thing's object, as the agent (the checklist does) | each kind has to remember; three kinds repeat the same lines |
| B. A helper of the base, `agent.thing(Contract, id)`: the object for that id, with the same errors everywhere | one more name in the API |
| C. One list tool of the base for all things, so kinds keep no list | a kind still needs the list to decide whether to offer its write tool |

**Recommendation: A now**, with the two-checklists test as the model for notes and canvas. Consider C later for
another reason: every kind adds a list tool to the prompt.

## 9. How a session gets things without adding them by hand (Mario)

**Last night's answer:** a session follows one party, or nobody. It has, live, every thing that party marked "in all
my sessions", while the party writes in it. A new coding session follows the owner who made it, so it has the Pi's
coding tools and his login.

**Its problems, plainly:**

- **It is live inheritance**, which Mario ruled out on 2026-11-22 ("no live inheritance tricks"), taken back for
  this one case.
- **What a session has changes under it.** Mario marks a new inbox "in all my sessions". At the next message every
  session that follows him has mail tools, also the one he shared with a guest who writes: the guest's agent reads
  his mail. Turning the switch off takes tools away from running work.
- **One party only.** A club chat that follows the coaches has the club's login, and cannot also follow Mario for
  the coding tools. A coding session that follows Mario cannot also follow a project's group.
- **Lock-down means detaching.** A locked-down session follows nobody, so it also gets no login; that has to be
  linked by hand again. Following is all of a party's things or none.
- **Options are still by hand.** A followed thing arrives with its kind's initial options (`shell: true`) in every
  session. "Everywhere, but without the shell" cannot be said once; options chosen for a followed thing stay behind
  when the session stops following.
- **A project's things have no party.** What should come with a folder (its MCP servers, its instructions) is only a
  sketch; a location is not something a session can follow.

| Choice | Cost |
| --- | --- |
| A. Following, as built | the six problems above |
| B. Copies at creation: a new session gets the links its app or its maker lists; installing a plugin or adding a login asks "add to my 14 sessions?" | copies drift; the question is asked again and again; a forgotten session lacks the new login (story 2) |
| C. Things per app: each app has things all its sessions have, live; the owner edits them per app | still live, now per app; a person's own things (Anna's inbox in her family sessions) need a second rule; a session cannot opt out |
| D. The thing lists its apps: "in all my coding sessions", not "in all my sessions" | finer, and more to choose; the same change under running sessions; every installed app shows up in every thing's list |

**Recommendation: keep A for now, and blunt its sharpest edge before it ships.** It is one rule, it is built, and
it serves the single-owner coding app well. Two small changes:

1. **"In all my sessions" starts off for what a person makes** (an inbox), on for what a plugin makes (the coding
   tools); a kind may say its things start on (a login). The switch says what it will do before it does it: "14
   sessions, 2 of them with other people".
2. **Default options travel with the thing:** the owner chooses once what a followed thing allows where nothing else
   was chosen, instead of the kind's initial options in every session.

Leave "one party" and a project's things open until the file and terminal views
([ERNDL-796 Earendil-provided views](https://linear.app/earendil/issue/ERNDL-796)) show what a project needs. If two parties are needed before that, prefer D over following two: it keeps one answer to "why does this
session have this thing".

## Added after the round-2 fixes (2026-11-23, server builder)

- **Followed things are not counted.** The 1000-thing cap counts links only. A followed party with more than 1000
  "in all my sessions" things pushes every following session past the read limit, and no session write can refuse
  it (they grow from My things). Choices: cap "in all my sessions" per owner (refused at `setEverywhere`/`create`);
  page `SessionHas`; count followed things in the cap and refuse the switch when a follower would overflow (a fan-out
  read per switch).
- **Options left behind.** After `follow` with `keep: false`, options set for things the session no longer has stay
  stored and apply again if it follows again. Choices: drop them with the follow; keep them on purpose and say so.
