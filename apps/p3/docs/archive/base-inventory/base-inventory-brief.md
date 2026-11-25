# Brief: what must the p3 (Pi Roam) base enable?

## The guiding principle (owner, 2026-11-09)

"Does the base offer everything to implement the thing as a plugin?" is the guiding light. We want the MINIMAL set of
base pieces (services, objects, registries, hooks, observable state, Chord/kit features) that lets third-party plugins
build REALLY EVERYTHING below, without changing the base. Restrictions, permissions, ACLs, automations, stats, chat
integrations, bespoke apps: all plugins.

## Context to read first

- Direction notes: /home/badlogic/pi/apps/p3/docs/direction-pi-roam.md (your own Pi instance, fully extensible UI,
  session and server side; backups and remote access through Radius; a one-click cloud machine for a team instance; the
  instance is the trust boundary; multiplayer rarely used).
- The harness discussion so far (owner and me, today): plugins never see Durable's extension type directly; p3's
  harness offers one registry per part: tools, prompt sections, models, environments, input (what enters a
  conversation), tasks (Durable task definitions). Each part can be limited in three shapes: filter (what is offered
  before anything runs), chain (hooks that see and may change or block, e.g. Durable's beforeTool/afterTool,
  beforeRequest, afterResponse, afterRun), wrap (around the whole thing, e.g. wrap a tool or the ExecutionEnv). Durable
  API: packages/durable/src/harness/types.ts (Extension, AgentState selection, hooks, HarnessOptions env/models/onWake).
  Server-side: a session service any plugin can call (create/configure/archive sessions). Automations as plugins need
  a tasks registry, the harness's wake time as observable state, starting a worker by holding its object, inbound HTTP
  routes (kit Http registry), the session service. Stats (like dsh-context, https://github.com/bowenliang123/dsh-context)
  need harness observation (entries, documents, commit signals) and the hooks public to plugins.
- The old coding agent's extension API as a catalogue of what users wanted (ad hoc, not a model):
  packages/coding-agent/src/core/extensions/types.ts and docs/extensions.md.
- Chord: packages/chord/docs/design.md (§3-§7 hosts, principals, objects, references; §9-§11 documents, store, tables;
  §14-§15 routines, jobs; §17 registries; §23 kit, web/TUI surfaces). p2's plugins in apps/p2/plugins/* (what exists).
- UX proposals: Armin's Home-first walkthrough (text: /tmp/armin.txt): one Home conversation (an orchestrator) that
  spawns sessions in the background, cards, a "needs you" inbox, projects that become bespoke screens, lending a machine
  on request. The coding walkthrough: /home/badlogic/pi/apps/p3/docs/coding-flow/index.html. Cristina's sharing proposal:
  /tmp/cristina.md (shares through Radius, guests, the UI served to viewers). The resource model spec (permissions
  design, now one possible plugin among others): /home/badlogic/pi/apps/p3/docs/resource-model/book.md.
- The owner's examples: a personal assistant (like OpenClaw / Muse style) with almost no UI that he talks to through
  iMessage, WhatsApp, Discord, Slack; a bespoke app for a daily task, e.g. what Earendil's triage agent does (find it in
  the earendil-works GitHub org: `gh repo list earendil-works --limit 200 | grep -i tri`, read its README and how it
  works) built inside Pi Roam as its own UI, where he can pull an issue analysis into a new session and work on it with
  an agent, or accept the proposed fix directly; the Discord integration (connect the instance to a server; the first
  message from a channel creates a session from a template; it starts closed until he opens it; a policy plugin limits
  its tools with filters/hooks/wraps); usage and cost statistics across sessions.

## Your task

Go broad. Produce an extensive list of use cases and products people may want to build on Pi Roam (the owner wants
"really everything": personal assistants over chat apps, orchestrators and inboxes, bespoke apps like triage,
dashboards, automations on timers/webhooks/events, stats, sharing, team instances, coding workflows, voice, mobile,
TUI, browsers, sandboxes, MCP, backups/restore, multi-device, search, memory, scheduled reports, approvals, human in
the loop, ...). Add your own. For EACH use case write:

1. what the user experiences (two or three sentences);
2. how a plugin would build it, concretely: which hosts (server, session worker, page, terminal) and what it
   contributes or calls;
3. the base pieces it needs, named concretely and typed where you can (a registry and its contribution shape, a
   service with its methods, an object with its state, a hook with its signature, observable state, a kit or Chord
   feature); mark each as EXISTS (cite file) or NEEDED.

Then end with:
- the merged list of base pieces, deduplicated, each with the use cases that need it, ranked by how many need it;
- the minimal set you propose (what to cut or merge), and anything that cannot be a plugin and why;
- open questions.

Be concrete, no fluff, no marketing. Read the sources you cite. Write ONLY your output file (named in your message);
do not edit the repo, do not commit. Reply with a 5-line summary.
