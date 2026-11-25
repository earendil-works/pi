# Sharing in p3 when the UI is apps (synthesis)

Status: synthesis for the owner, 2026-11-10, by the p3 session (8b6ab5cc) from a two-round discussion of three
designers: product (claude-opus-5-5), security (gpt-6-astra), architecture (gpt-6.1-sol). Their proposals and critiques:
`/tmp/share-{opus,astra,sol}.md` and `-r2.md`. Context: `views.md` (apps, views, view principals), `decisions.md`.
Nothing here is decided until the owner says so; section 3 lists the decisions.

## 1. What all three agree on

- **A share is a server record:** the session, the app it was shared from, a mode, an audience (a link for anyone, or
  named people), an expiry, and a revision. Each person gets their own guest principal per share, set by the server,
  so changing one share never cuts a guest off from another.
- **Access lives in objects, never in the page.** Every object behind a view gives guests a variant or nothing. A
  view whose objects give a guest nothing is not shown. Hiding a pane is presentation, not protection.
- **The guest's layout is projected by the server** from the source app's recipe: standard views that declare they
  can be shared stay, views of other sessions and of the owner's accounts are absent, an app may supply its own guest
  layout, and a share made outside any app falls back to a minimal session app. A view's params alone never decide
  what is safe to show (`Files({ session, path: "~/.ssh" })` is session-shaped and still private); no private params
  reach a guest page.
- **The guest page is the instance's own UI,** relayed (through Radius when remote) on its own origin; agent sketches
  stay sandboxed; Cristina's Radius-built viewer bundle (Option C) is not the guest UI, though a vetted transcript-only
  viewer could be a later, separate product.
- **Full participation reaches what the session's agent reaches** (its machines, tools, other sessions through tools).
  The share sheet says so before such a share is made.
- **Approvals stay the owner's.** A participant may talk to the agent and answer ordinary questions addressed to them,
  but never approves the owner's approval requests, shares further, installs or manages accounts.
- **Ending a share** revokes the grant everywhere: pages, view frames (their view principals are bound to the grant
  and its revision), HTTP downloads and streams, and new token issuance, with concurrent admissions fenced against the
  current revision. Ending a share does not stop work the guest already started ("End share" and "Stop run" are two
  controls), and nothing can recall what was already delivered.
- **The owner going offline ends nothing; archiving the session does,** and restoring it needs a new share.
- **The owner sees what is shared:** a "Shared · 63 watching" indicator in the fixed bar, a global Shares view, and a
  preview of what a guest will see, rendered with a real restricted grant.
- **The meetup (70 guests):** the sockets are fine; the risk is fan-out (every update encoded per guest view). Bound
  each guest's subscriptions, keep rooms quiet for large audiences (presence counts, not lists), budget the join burst.
  No Chord kernel change is needed.
- **Sharing a whole app: not yet.** It needs explicit membership, rules for what guests may create in it, and guest
  variants for its global views; start with session shares.

## 2. Where they still differ

1. **Playing without talking to the agent.** Opus wanted a third mode, Play, so a guest can move a Pong paddle without
   commanding the agent. Astra and Sol agree play must not need agent access, but would not make it a generic mode:
   a view's own room declares a "player" variant, admitted per view, so an observer cannot drive a robot's motors or
   flood other phones just because it can watch.
2. **Expiry.** Astra and Sol: every share expires by default. Opus: anyone-links expire by default, named shares may
   run without expiry but are always listed in the Shares view.
3. **What freezes at share time.** Astra freezes the guest's layout recipe; Opus freezes only the scope, so views the
   agent opens in that session during a talk (a diff) appear for the audience.
4. **Deep links.** Opus keeps the share in the guest's connection, so a URL the owner copies also works for a guest;
   the others put the share in the link.

## 3. Decisions for the owner (with the synthesis's recommendation)

1. **Modes:** Watch (read-only, the default for links) and Join (talks to the agent; named, signed-in people only,
   after the reach warning); playing in a view is a per-view player variant, not a third mode. Recommended.
2. **Approvals are never a guest's.** Recommended.
3. **Expiry:** links expire by default (for example 24 hours); named shares may be open-ended but always listed.
4. **Freeze the scope, not the layout:** new views of the shared session appear for guests; nothing outside it does.
5. **Whole-app sharing:** deferred.

## 4. Open problems (owner, 2026-11-10: to think through later; the goal is a simple system)

The owner's direction: keep it simple. Whoever shares accepts that everything shown for that session (or that app,
for an app shared whole) is accessible to the guest. What a guest sees follows from what the objects give the
guest's principal; nothing else needs per-view rules.

1. **Do views need the principal?** Direction: no. Objects already decide per principal through variants, and a view
   renders the variant its reference got: the approvals object gives the owner a variant with Allow and Deny, and a
   guest a variant without them (or nothing). The page knows who you are only for wording and presence (your name).
   Possible solutions: (a) views read only `ref.variant` and the members it has (recommended: one rule, no
   principal checks in UI code); (b) the workbench also passes the principal for wording only.
2. **Who picks the views a guest's layout shows?** Direction: the app, per principal, may choose which of its views it
   shows; each view then shows what its objects give. Possible solutions: (a) the server projects the layout: a view
   whose objects give the guest nothing is dropped, and the app may list views it never shows to guests (recommended);
   (b) the app supplies a whole guest layout per mode; (c) every view declares the principal kinds it is for (a hint
   so no empty pane opens first, never the protection).
3. **Sharing a whole app for real use** (the family app shared read-write with the owner's wife, who then has full
   control of it). The designers deferred whole-app sharing (membership, what a guest may create, global views).
   Possible solutions: (a) an app share is a grant over the app's slice: its sessions, its machines and accounts, with
   guests able to create sessions inside it (needs the slice as server data the share can check); (b) the wife is a
   user of the instance rather than a guest, and the family app is hers or shared by membership (a users plugin);
   (c) start with sharing the app's one long-running session and its views, which covers the family app's main use.
4. **Modes:** Watch (read-only) and Join (talks to the agent), with a per-view player role in rooms; or only two modes
   and rooms decide themselves. See section 3, decision 1.
5. **Expiry and what freezes:** section 3, decisions 3 and 4.

### Owner's direction on the open problems (2026-11-10)

- **Views know who is there.** A view (a game above all) gets presence: who has this view instance open, on which
  page and device, with their name and role (owner, user, guest). An ad hoc view (a sketch) has no server objects of
  its own and no variants, so presence comes from its room; that is enough, since a sketch cannot reach remote objects
  anyway. What a sketch shows is visible to whoever may see the session, which the sharer accepts.
- **Sharing an app with another person: they are a user of the instance.** The owner's wife is a user, not a guest;
  the app is shared with her as a user. Which of the app's sessions she sees is the app's decision: the app already
  tags the sessions it creates as its own and records who created each and whether it is private or public (or
  shared with named users), and enforces that in its own objects' variants. No access-control lists in the base.
- **No per-user environments.** A session in any app may use every environment of the instance; an app may lock its
  sessions to one environment it chooses. Separation of machines, accounts or people beyond that means a separate Pi
  instance, not a resource model (the resource-model plugin stays shelved).
