---
title: p3: groupings show, one list equips
cover: Groupings Show / One List Equips
kicker: An explainer for the owner · p3 resource model · 2026-11-08
subtitle: What a session may use, who decides, and what you will see on screen, with the code behind each piece
stats:
  - 1 | field decides what a session may use
  - 1 | policy, asked at one guarded step
  - 39 | p2 plugins checked against it by two reviewers
  - 4 | decisions left for you
note: |
  For Mario. The model you agreed on in the car (decision "Resource model direction", 2026-11-08), specified with typed
  APIs in `apps/p3/docs/resource-model/book.md` (the spec, second edition) and reviewed by Astra and Sol against every
  p2 plugin. This explainer shows it: mockups of the screens, the code each plugin writes, and the sequences that run.
  Mockups are illustrations, not designs. Nothing is built.
colophon: p3 resource model · explainer, first edition · 2026-11-08 · from the spec and the Astra and Sol reviews
---

# Before we begin {.preface}

You open p3 on the laptop. Your sessions have your models, your MCP servers, your machines and every tool the installed
plugins bring; you never configured any of it. At Earendil, Colin, Cristina and Charlotta share a project; its sessions
use exactly what the three brought, with each owner's own login. A Discord channel's session may read the answers of
one other session for an hour and nothing else. Engineering may create MCP servers; research may not, yet researchers
use the one Colin brought into their project.

All of that comes from a few pieces. This book shows each piece three ways: what you would see, the code a plugin
writes, and what runs when something changes.

## Seven things to know

:::findings
1. **Groupings show; one list equips.** A session appears in any number of groupings (recent, folders, projects,
   Discord) and uses exactly one list.
2. **That list comes from one field**, the session's resource source: your defaults, its own list, or one grouping
   with resources such as a project or a Discord channel.
3. **Every resource has one owner forever,** and with it one login. Users create resources for themselves; admins for
   the instance user, which owns company resources and every plugin's built-in tools.
4. **Your defaults are a rule, not a list:** everything you own plus every instance resource you may use. A new
   plugin's tool appears in your next turn by itself.
5. **One policy decides,** asked by core at the moment something happens. Plugins never know about ACL, SAML or
   Radius; pages never check anything, they show what the server's views say.
6. **The worker follows its list,** and checks it at every tool call; server views check it at every call too.
7. **Anything can draw anything:** creators per resource kind, renderers per form, detail views assembled from several
   plugins' panels; layouts are plugins.
:::

## Words used throughout

A **resource** is something a session can use: a model provider, an MCP server, a machine, a drive, a tool, access to
another session. Its **owner** is a user, or the **instance user** for company resources and **built-ins** (tools that
need no setup). A **grouping** is a plugin's object that shows things; a **grouping with resources** also keeps a list.
A session's **resource source** names where its list comes from; the **effective list** is what its worker gets. The
**policy** is the one plugin that answers typed **requests**; a **creator** is a resource kind's "new ..." sheet; a
**renderer** draws a thing in a **form** (row, card, detail); a **panel** is one plugin's part of a detail view.
:::raw
<style>
.mk{font:13px/1.45 'Avenir Next','Helvetica Neue',Helvetica,Arial,sans-serif;color:#2a2723;background:#fff;border:1px solid #dcd3c1;border-radius:9px;box-shadow:0 18px 40px -28px rgba(60,40,10,.45);overflow:hidden;text-align:left}
.mk *{box-sizing:border-box}
.mk-bar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#f1ece2;border-bottom:1px solid #e3dbcc;font-size:11px;color:#7b7468}
.mk-bar i{width:9px;height:9px;border-radius:50%;background:#d9cfbd;display:inline-block}
.mk-bar span{margin-left:8px}
.mk-cols{display:flex;min-height:300px}
.mk-side{width:232px;flex:none;background:#f8f5ee;border-right:1px solid #e8e0d0;padding:8px 0}
.mk-main{flex:1;padding:12px 16px;min-width:0}
.mk-panel{width:250px;flex:none;border-left:1px solid #e8e0d0;padding:10px 12px;background:#fdfbf7}
.mk-sec{margin:6px 0 10px}
.mk-sec h5{margin:0;padding:3px 12px;font:600 10.5px/1.6 'Avenir Next','Helvetica Neue',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7b7468;display:flex;justify-content:space-between;align-items:center}
.mk-row{display:flex;align-items:center;gap:7px;padding:3px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-row.in{padding-left:26px}
.mk-row.in2{padding-left:40px}
.mk-row.sel{background:#efe6d6;border-left:3px solid #b4472f;padding-left:9px}
.mk-row.in.sel{padding-left:23px}
.mk-row small{color:#9a9182;margin-left:auto;font-size:11px}
.mk-ico{width:16px;height:16px;border-radius:4px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:#fff;background:#a89d88}
.mk-ico.mcp{background:#6b5ca5}.mk-ico.env{background:#2e6a8a}.mk-ico.model{background:#b4472f}.mk-ico.tool{background:#8a7f6a}
.mk-ico.drive{background:#4f8a5b}.mk-ico.access{background:#c08a2e}.mk-ico.user{background:#c2b18c;border-radius:50%}.mk-ico.group{background:#7b7468;border-radius:50%}
.mk-ico.sess{background:transparent;border:1.5px solid #a89d88;color:#a89d88}
.mk-by{font:600 9px/1 'Avenir Next','Helvetica Neue',sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#2e6a8a;border:1px solid #9fc0d2;border-radius:9px;padding:2px 6px;background:#f2f8fb;white-space:nowrap}
.mk-by.core{color:#b4472f;border-color:#e2b2a6;background:#fcf3f0}
.mk-h{font-size:15px;font-weight:600;margin:0 0 2px}
.mk-sub{color:#7b7468;font-size:12px;margin-bottom:10px}
.mk-msg{background:#f6f2ea;border-radius:8px;padding:7px 10px;margin:6px 0;max-width:90%}
.mk-msg.me{background:#e9f1f5;margin-left:auto}
.mk-msg b{font-size:11px;color:#7b7468;display:block;font-weight:600}
.mk-tool{font:11.5px/1.4 'SF Mono',Menlo,monospace;color:#5a544a;border-left:2px solid #c2b18c;padding:2px 8px;margin:6px 0}
.mk-tool.err{border-color:#b4472f;color:#b4472f}
.mk-list{border:1px solid #ece4d4;border-radius:7px;overflow:hidden;margin:6px 0 10px}
.mk-li{display:flex;align-items:center;gap:8px;padding:6px 9px;border-bottom:1px solid #f1ebdf}
.mk-li:last-child{border-bottom:none}
.mk-li .t{flex:1;min-width:0}
.mk-li .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mk-li .t small{color:#9a9182;font-size:11px;display:block}
.mk-li .x{color:#b9b0a0;font-size:14px}
.mk-li.off{opacity:.45}
.mk-btn{display:inline-block;border:1px solid #d5ccb9;border-radius:6px;padding:4px 10px;font-size:12px;background:#fff;color:#2a2723}
.mk-btn.pri{background:#b4472f;border-color:#b4472f;color:#fff}
.mk-btn.ghost{border-style:dashed;color:#7b7468}
.mk-pill{font-size:10.5px;border-radius:9px;padding:1px 7px;background:#f1ebde;color:#7b7468;white-space:nowrap}
.mk-pill.warn{background:#fbecd7;color:#a0661c}
.mk-pill.inst{background:#ece7f6;color:#5a4c94}
.mk-src{display:flex;align-items:center;gap:6px;background:#f6f2ea;border-radius:7px;padding:6px 9px;margin:4px 0 10px;font-size:12px}
.mk-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mk-card{border:1px solid #ece4d4;border-radius:8px;padding:9px 10px;display:flex;gap:9px;align-items:flex-start;background:#fff}
.mk-card .t{flex:1}
.mk-card .t b{display:block;font-size:12.5px}
.mk-card .t small{color:#7b7468;font-size:11px;line-height:1.35;display:block}
.mk-tabs{display:flex;gap:2px;border-bottom:1px solid #e3dbcc;margin:4px 0 0}
.mk-tab{padding:6px 12px;font-size:12px;color:#7b7468;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;display:flex;gap:6px;align-items:center}
.mk-tab.on{color:#2a2723;background:#fff;border-color:#e3dbcc;margin-bottom:-1px;font-weight:600}
.mk-term{background:#22201d;color:#e8e2d4;font:11.5px/1.5 'SF Mono',Menlo,monospace;padding:10px 12px;border-radius:0 0 7px 7px;min-height:120px}
.mk-term .p{color:#d58a6f}
.mk-files{display:grid;grid-template-columns:1fr 70px 90px;font-size:12px}
.mk-files div{padding:4px 8px;border-bottom:1px solid #f1ebdf}
.mk-files .hd{font-size:10px;color:#9a9182;text-transform:uppercase;letter-spacing:.08em}
.mk-rules{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0}
.mk-rules td,.mk-rules th{padding:7px 8px;border-bottom:1px solid #f1ebdf;text-align:left;vertical-align:middle}
.mk-rules th{font-size:10px;color:#9a9182;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid #e3dbcc}
.mk-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #e3dbcc;border-radius:12px;padding:2px 8px 2px 3px;margin:2px 3px 2px 0;font-size:11.5px;background:#fff}
.mk-note{font-size:11px;color:#9a9182;margin-top:8px}
.mk-split{display:grid;grid-template-columns:1fr 1fr;gap:0}
.mk-split > div{padding:12px 14px}
.mk-split > div + div{border-left:1px solid #e8e0d0}
.mk-who{font:600 10.5px/1 'Avenir Next','Helvetica Neue',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7b7468;margin-bottom:8px;display:flex;gap:6px;align-items:center}
.mk-search{border:1px solid #e3dbcc;border-radius:6px;padding:5px 9px;color:#b9b0a0;font-size:12px;margin-bottom:8px}
</style>
:::
# Two Questions {#two-questions lede="The idea the whole model rests on: groupings show things, one list equips a session."}

Every model we tried before asked groupings to decide what a session may use. Folders, projects, Discord servers and
SAML groups each wanted a say, and each say needed a rule for combining it with the others: include, restrict,
precedence, which login wins. Astra and Sol, designing independently, both cut the knot the same way. There are two
questions, and they get two answers.

:::flow wide animate | Where something appears (top) and what a session may use (bottom) are separate. A session appears in any number of groupings; one field names its one list.
row "Groupings: show" blue
box recent "Recent" "per user, from activity" blue
box folders "Folders" "computed from locations" blue
box project "Project pi" "curated: members, resources" accent
box discord "#support" "a Discord channel" accent
row "Session"
gap
box s1 "Session S1" "source: project pi" accent
box s2 "Session S2" "source: #support" accent
gap
row "Lists: equip" accent
gap
box l1 "pi's list" "Linear · gpu · Anthropic" accent
box l2 "#support's list" "company key · access to X" accent
gap
arrow recent -> s1 "shows" dashed
arrow folders -> s1 "shows" dashed
arrow project -> s1 "shows" dashed
arrow discord -> s2 "shows" dashed
arrow s1 -> l1 "uses"
arrow s2 -> l2 "uses"
note "Dashed: appearing, any number. Solid: the one resource source, one field in the session catalog."
:::

The second answer is one field in the session catalog, the session's **resource source**: its owner's defaults, its own
list, or one grouping with resources. One field means one source, by construction. Nothing checks across groupings,
nothing needs precedence. Moving a session into another project replaces the field.

# Who Owns What {#owners lede="Users, the instance user, and resources that keep their owner and their login forever."}

Every person is a user. One more user exists from the start: the **instance user**. It owns what belongs to the
company rather than to a person (the company's Claude key, the build machine, the Discord bot) and every tool the
installed plugins bring. Nobody signs in as it; admins act for it.

A **resource** is anything a session can use: a model provider, an MCP server, a machine, a drive, a tool, access to
one other session. Each is an ordinary Chord object of a **resource kind**, and its owner is one of its params, so it
can never change:

```ts
// plugins/mcp/contract.ts: the kind is declared once; server, worker and page import it from here
export const McpServer = remote("mcp.server", {
	version: 1,
	params: { owner: str(), id: str() },
	hostAddress: () => Server(),
	variants: { user: { state: { info: McpInfo }, methods: { configure: method(McpConfig), signIn: method() } } },
});
export const McpKind = resourceKind(McpServer, (p) => userId(p.owner));
```

Three rules follow, and none of them is configurable:

- **A resource's login never changes.** Colin's Linear server is always signed in as Colin, whoever uses it. Cristina
  wanting her own Linear login means a second resource, hers.
- **Users create resources only for themselves; admins create them for the instance user.**
- **Installing a plugin creates its built-ins.** A tool that needs no setup is a resource owned by the instance user,
  created when an admin installs the plugin. One Durable extension is one resource; a plugin that wants bash pickable
  apart from read and write splits them into two extensions.

```ts
// plugins/coding-tools/contract.ts
export const FileTools = builtin("coding-tools.files");    // read, write, edit
export const Bash = builtin("coding-tools.bash");

// plugins/coding-tools/server.ts: core creates them for the instance user when the plugin loads
self.contribute(Builtins, [
	describe(FileTools, { label: t.message("fileTools"), description: t.message("fileToolsAbout") }),
	describe(Bash, { label: t.message("bash"), description: t.message("bashAbout") }),
]);
```

# The One List {#one-list lede="Defaults, an own list, or a grouping's list: what a session uses, and what you see of it."}

A session's resource source is one of three:

```ts
export const ResourceSource = union([
	obj({ kind: lit("defaults") }),                          // a rule: everything I own + every instance resource I may use
	obj({ kind: lit("own") }),                               // the session's own list
	obj({ kind: lit("grouping"), grouping: ObjectAddress }), // one grouping with resources: a project, a Discord channel
]);
```

**Defaults** is what Mario lives in and never sees. It is not a list anyone keeps; it is the rule *everything I own,
plus every instance resource I may use*. Install a plugin with a new tool and the rule includes it: the tool is in the
next turn of every normal session. Someone who wants code mode off everywhere adds it to their **exclusions** (a
proposal, decision 3 at the end). **Own** is what "Lock down this session" makes: a snapshot of the current list the
user then trims; from a project, only what the user may bring themselves is kept, so Cristina cannot walk off with
Colin's server. **Grouping** is a project or a Discord channel; its plugin keeps the list.

Everyone who may send in a session uses its whole list. That is the owner's decision of 2026-11-08: prompt injection
cannot be prevented, so what is brought into a session is the control.

The default layout shows a session's list in its side panel, with where it comes from at the top:

:::figure wide | The default layout: groupings in the sidebar (each section from its own plugin), session S1 in the middle, its list on the right. S1's source is project pi; Charlotta's question uses Colin's Linear login, Cristina's machine and Charlotta's key.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>p3 · pi / Fix flaky upload test</span></div>
<div class="mk-cols">
<div class="mk-side">
 <div class="mk-sec"><h5>Recent <span class="mk-by">recent</span></h5>
  <div class="mk-row sel"><span class="mk-ico sess">S</span>Fix flaky upload test<small>2m</small></div>
  <div class="mk-row"><span class="mk-ico sess">S</span>Release notes draft<small>1h</small></div>
 </div>
 <div class="mk-sec"><h5>Folders <span class="mk-by">folders</span></h5>
  <div class="mk-row"><span class="mk-ico env">M</span>gpu:~/pi<small>2</small></div>
  <div class="mk-row"><span class="mk-ico env">M</span>this machine:~/notes<small>5</small></div>
 </div>
 <div class="mk-sec"><h5>Projects <span class="mk-by">projects</span></h5>
  <div class="mk-row">▾ <b>pi</b><small>3 people</small></div>
  <div class="mk-row in sel"><span class="mk-ico sess">S</span>Fix flaky upload test</div>
  <div class="mk-row in"><span class="mk-ico sess">S</span>GPU benchmark</div>
  <div class="mk-row">▸ research-notes</div>
 </div>
 <div class="mk-sec"><h5>Discord <span class="mk-by">discord</span></h5>
  <div class="mk-row">▾ Earendil</div>
  <div class="mk-row in"># support<small>Support bot</small></div>
 </div>
 <div class="mk-sec"><h5>engineering <span class="mk-by">saml</span></h5>
  <div class="mk-row"><span class="mk-ico user">C</span>Colin, Ada, +10</div>
 </div>
</div>
<div class="mk-main">
 <div class="mk-h">Fix flaky upload test</div>
 <div class="mk-sub">gpu:~/pi · project pi · owner Cristina</div>
 <div class="mk-msg"><b>Charlotta</b>Why does the upload test flake on gpu? There is a Linear issue about it.</div>
 <div class="mk-tool">linear.search "upload flaky"  → PI-412</div>
 <div class="mk-tool">bash  npm test -- upload --repeat 20</div>
 <div class="mk-msg"><b>Pi</b>PI-412 matches: the test races the temp-dir cleanup. 3 of 20 runs fail; a fix is ready in <code>upload.test.ts</code>.</div>
</div>
<div class="mk-panel">
 <div class="mk-h" style="font-size:13px">Resources <span class="mk-by core">core</span></div>
 <div class="mk-src"><span class="mk-ico sess">P</span>from project <b>pi</b></div>
 <div class="mk-list">
  <div class="mk-li"><span class="mk-ico mcp">L</span><div class="t"><div>Linear</div><small>MCP server · Colin</small></div></div>
  <div class="mk-li"><span class="mk-ico env">G</span><div class="t"><div>gpu</div><small>machine · Cristina</small></div></div>
  <div class="mk-li"><span class="mk-ico model">A</span><div class="t"><div>Anthropic</div><small>model provider · Charlotta</small></div></div>
  <div class="mk-li"><span class="mk-ico tool">T</span><div class="t"><div>Built-in tools · 14</div><small>instance</small></div><span class="mk-pill inst">instance</span></div>
 </div>
 <span class="mk-btn">Add resource</span> <span class="mk-btn ghost">Change source</span>
 <div class="mk-note">Each row is drawn by its kind's plugin (its <code>Row</code> renderer); the panel only lists addresses.</div>
</div>
</div>
</div>
:::

# Groupings {#groupings lede="Computed and curated groupings, the few that carry resources, and a project from the inside."}

A grouping is any plugin's object that shows other objects. **Folders** are computed from where sessions work: nobody
puts a session there. **Recent** is per user, from what each user opened. **Projects** are curated by people. A
mirrored SAML group shows its members. None of these needs core, except the groupings that carry resources: they keep
their list in their own plugin and register with core how to read and change it.

```ts
// plugins/projects/server.ts: the projects plugin knows nothing about MCP, models or ACL
self.contribute(GroupingKinds, [registerGrouping({
	kind: ProjectKind,
	members,                                     // users and groupings in each project
	resources: {
		lists,                                   // each project's ListEntry[], kept by this plugin
		mayBring: isMember,                      // the list side of bringing: the project's own rule
		mayRemove: isMaintainer,
		mayJoin: isMember,                       // making a session's source this project
		add: (project, entry, ctx) => addEntry(lists, project, entry, ctx),
		remove: (project, resource, ctx) => removeEntry(lists, project, resource, ctx),
	},
})]);
```

A project's sessions are a query: catalog rows whose source is the project. The session points up, never the project
down, so two projects can never both equip one session. Selecting the project shows the project plugin's detail view,
whose rows are drawn by each thing's own plugin:

:::figure wide | Project pi selected. The projects plugin lists addresses in three columns; every row is drawn by the renderer of that thing's plugin (tags show which), so the project plugin never learns what an MCP server is.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>p3 · pi</span></div>
<div style="padding:14px 16px">
 <div style="display:flex;align-items:baseline;gap:10px"><div class="mk-h" style="font-size:18px">pi</div><span class="mk-by">projects</span><span style="margin-left:auto" class="mk-btn">New session here</span></div>
 <div class="mk-sub">Project · 3 people and 1 group · 5 resources · 2 sessions · you are a maintainer</div>
 <div style="display:grid;grid-template-columns:1fr 1.25fr 1fr;gap:14px">
  <div><div class="mk-who">People <span class="mk-by">users</span></div>
   <div class="mk-list">
    <div class="mk-li"><span class="mk-ico user">C</span><div class="t"><div>Colin</div><small>maintainer</small></div></div>
    <div class="mk-li"><span class="mk-ico user">C</span><div class="t"><div>Cristina</div><small>member</small></div></div>
    <div class="mk-li"><span class="mk-ico user">C</span><div class="t"><div>Charlotta</div><small>member</small></div></div>
    <div class="mk-li"><span class="mk-ico group">E</span><div class="t"><div>engineering</div><small>SAML group · 12</small></div><span class="mk-by">saml</span></div>
   </div><span class="mk-btn ghost">Add person or group</span></div>
  <div><div class="mk-who">Resources <span class="mk-by core">core list</span></div>
   <div class="mk-list">
    <div class="mk-li"><span class="mk-ico mcp">L</span><div class="t"><div>Linear</div><small>brought by Colin · 23 tools · signed in</small></div><span class="mk-by">mcp</span></div>
    <div class="mk-li"><span class="mk-ico env">G</span><div class="t"><div>gpu</div><small>brought by Cristina · ready · 2× A100</small></div><span class="mk-by">envs</span></div>
    <div class="mk-li"><span class="mk-ico model">A</span><div class="t"><div>Anthropic</div><small>brought by Charlotta · 9 models</small></div><span class="mk-by">models</span></div>
    <div class="mk-li"><span class="mk-ico drive">D</span><div class="t"><div>Company drive</div><small>instance · until Fri</small></div><span class="mk-pill warn">until Fri</span></div>
    <div class="mk-li"><span class="mk-ico tool">T</span><div class="t"><div>Built-in tools · 14</div><small>bash, files, subagents… (decision 1)</small></div><span class="mk-pill inst">instance</span></div>
   </div><span class="mk-btn ghost">Add resource</span></div>
  <div><div class="mk-who">Sessions <span class="mk-by">sessions</span></div>
   <div class="mk-list">
    <div class="mk-li"><span class="mk-ico sess">S</span><div class="t"><div>Fix flaky upload test</div><small>Cristina · working</small></div></div>
    <div class="mk-li"><span class="mk-ico sess">S</span><div class="t"><div>GPU benchmark</div><small>Colin · idle 3h</small></div></div>
   </div></div>
 </div>
</div>
</div>
:::

A Discord channel linked to a session is a grouping with resources too: its list is what the channel may use, and
the link sheet edits it.

# Adding Things {#adding lede="Creators per kind, a picker filtered by what the server says you may create, and bringing in one step."}

Each resource kind contributes a **creator** to a page registry: a name, an icon, a description and the sheet that
creates one. Any "Add resource" button opens the same picker: your existing resources and the instance's on top, the
creators below, filtered by one list the server computes for you, `creatable`. Install a plugin and its creator
appears; the picker knows no kinds in advance and no rules at all.

```tsx
// plugins/mcp/web.tsx
self.contribute(Creators, [creator(McpKind, { label: t.message("mcpServer"), description: t.message("mcpAbout"), icon: PlugIcon, Sheet: NewMcpSheet })]);

// plugins/resources/web.tsx: the picker behind every "Add resource"
const creatable = useWatch(useHold(MyResources, {}).creatable) ?? [];                 // computed on the server
const creators = useRegistry(Creators).filter((c) => creatable.includes(c.kind.contract.name));
```

:::figure wide | The same picker for Colin (engineering) and Cristina (research), with the rule "only engineering may create MCP servers". Cristina's view lacks the MCP creator because her <code>creatable</code> lacks it; she still uses Colin's server in pi.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>Add a resource to project pi</span></div>
<div class="mk-split">
 <div><div class="mk-who"><span class="mk-ico user">C</span>Colin sees</div>
  <div class="mk-search">Search your resources…</div>
  <div class="mk-who" style="font-size:9.5px">Yours</div>
  <div class="mk-list">
   <div class="mk-li"><span class="mk-ico mcp">R</span><div class="t"><div>Radius MCP</div><small>MCP server · yours</small></div><span class="mk-btn">Bring</span></div>
   <div class="mk-li off"><span class="mk-ico mcp">L</span><div class="t"><div>Linear</div><small>already in pi</small></div></div>
  </div>
  <div class="mk-who" style="font-size:9.5px">Create new</div>
  <div class="mk-grid">
   <div class="mk-card"><span class="mk-ico mcp">M</span><div class="t"><b>MCP server</b><small>HTTP, or a checkout's suggestion</small></div></div>
   <div class="mk-card"><span class="mk-ico model">P</span><div class="t"><b>Model provider</b><small>API key or sign-in</small></div></div>
   <div class="mk-card"><span class="mk-ico env">M</span><div class="t"><b>Machine</b><small>SSH host or sandbox</small></div></div>
   <div class="mk-card"><span class="mk-ico drive">D</span><div class="t"><b>Drive</b><small>files people and agents share</small></div></div>
  </div>
 </div>
 <div><div class="mk-who"><span class="mk-ico user">C</span>Cristina sees</div>
  <div class="mk-search">Search your resources…</div>
  <div class="mk-who" style="font-size:9.5px">Yours</div>
  <div class="mk-list">
   <div class="mk-li off"><span class="mk-ico env">G</span><div class="t"><div>gpu</div><small>already in pi</small></div></div>
   <div class="mk-li"><span class="mk-ico drive">D</span><div class="t"><div>Cristina's drive</div><small>drive · yours</small></div><span class="mk-btn">Bring</span></div>
  </div>
  <div class="mk-who" style="font-size:9.5px">Create new</div>
  <div class="mk-grid">
   <div class="mk-card"><span class="mk-ico model">P</span><div class="t"><b>Model provider</b><small>API key or sign-in</small></div></div>
   <div class="mk-card"><span class="mk-ico env">M</span><div class="t"><b>Machine</b><small>SSH host or sandbox</small></div></div>
   <div class="mk-card"><span class="mk-ico drive">D</span><div class="t"><b>Drive</b><small>files people and agents share</small></div></div>
   <div class="mk-card" style="border-style:dashed;opacity:.6"><span class="mk-ico" style="background:#ddd">–</span><div class="t"><b>No MCP server</b><small>not in your creatable kinds</small></div></div>
  </div>
 </div>
</div>
</div>
:::

Creating from a list creates and brings in one step for the user: the creator's sheet calls its plugin's `create`
(core's guarded step checks the owner rule and the policy), then the picker brings the new resource into the list with
the duration the user picked. Bringing needs two yeses: the resource's side (you own it; instance resources: you
administer) and the list's side (the project lets you add). Admins get one more choice in the picker, the owner:
themselves or the company, which is how the company's Claude key or build machine is created although nobody signs in
as the instance user.

# Who May {#policy lede="One replaceable policy, typed requests, core's guarded steps, and a rule change that reaches Cristina's page by itself."}

The groupings from SAML, Radius and projects do not know each other. **One policy decides**, behind one registry,
asked by core at the moment an action happens, on the server. Requests are typed values, kinds are tokens compared by
identity:

```ts
export type Request =
	| { readonly kind: "create-resource"; readonly actor: UserId; readonly resourceKind: ResourceKind; readonly owner: UserId }
	| { readonly kind: "create-grouping"; readonly actor: UserId; readonly groupingKind: GroupingKind }
	| { readonly kind: "bring"; readonly actor: UserId; readonly resource: Indexed; readonly into: ListRef }
	| { readonly kind: "use"; readonly session: SessionRow; readonly resource: Indexed }
	| { readonly kind: "administer"; readonly actor: UserId }
	| /* set-source, add-member, and a plugin's own operation(Contract, "method") */;

export type Policy = { decide(request: Request, baseline: Decision): Decision };
export const Policies = defineRegistry<Policy, Policy>("p3.policy", { version: 1 });
```

The default policy returns the baseline: the answer core and the owning plugin give from their own facts. On a laptop
that is "Mario may do everything". A company installs the rules plugin, and an admin edits rules on a settings screen
built from the same creators registry and every plugin's groupings:

:::figure wide | The rules plugin's settings screen. Kinds come from the <code>Creators</code> registry (names, icons), groups from any plugin's groupings (here SAML). A permission with rules is restricted to their members; one without rules keeps the baseline.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>Settings · Access rules</span></div>
<div style="padding:14px 16px">
 <div style="display:flex;align-items:baseline;gap:10px"><div class="mk-h">Access rules</div><span class="mk-by">rules</span><span class="mk-sub" style="margin:0 0 0 auto">Policy in use: rules · admins only</span></div>
 <table class="mk-rules">
  <tr><th>Permission</th><th>Only members of</th><th></th></tr>
  <tr><td>Create · <span class="mk-chip"><span class="mk-ico mcp">M</span>MCP server</span></td><td><span class="mk-chip"><span class="mk-ico group">E</span>engineering</span><span class="mk-chip"><span class="mk-ico group">R</span>research</span></td><td><span class="mk-pill">just added</span></td></tr>
  <tr><td>Create · <span class="mk-chip"><span class="mk-ico model">P</span>Model provider</span></td><td><span class="mk-chip"><span class="mk-ico group">A</span>admins</span></td><td></td></tr>
  <tr><td>Use · <span class="mk-chip"><span class="mk-ico env">M</span>This machine</span></td><td><span class="mk-chip"><span class="mk-ico group">A</span>admins</span></td><td></td></tr>
  <tr><td>Administer</td><td><span class="mk-chip"><span class="mk-ico group">A</span>admins</span></td><td></td></tr>
 </table>
 <div style="display:flex;gap:8px;align-items:center;margin-top:10px"><span class="mk-btn ghost">+ Rule</span><span class="mk-sub" style="margin:0">Kinds: MCP server · Model provider · Machine · Drive · Access to a session · Weather tool <span class="mk-by">creators</span></span></div>
</div>
</div>
:::

Adding research to the first rule reaches Cristina's open picker without a reload, without polling, and without the
picker knowing anything about groups:

:::sequence animate | An admin lets research create MCP servers; Cristina's picker gains the MCP creator.
actor admin "admin's page" "rules screen" blue
actor rules "rules plugin" "the policy" accent
actor core "core resources" "server"
actor view "MyResources" "Cristina's view"
actor page "Cristina's page" "picker" blue
admin -> rules: addRule { research may create mcp.server }
rules => rules: commit; policy.set(new value)
rules --> core: Policies value changed
core -> core: derive creatable per live view
core --> view: creatable gains mcp.server
view --> page: state pushed
page -> page: "MCP server" appears
:::

# Discord, Locked Down {#discord lede="A configured resource: access to one session, chosen actions, one hour, added from the Discord session itself."}

The owner's case: the Discord session may read the answers of one other session, only that one, for an hour, then
lose it again. The conversations tool has actions; the resource is the permission, not the tool:

```ts
// plugins/conversations/contract.ts
export const ConversationAccess = remote("conversations.access", { version: 1, params: { owner: str(), id: str() }, hostAddress: () => Server(),
	variants: { user: { state: { info: AccessInfo } } } });
export const AccessKind = resourceKind(ConversationAccess, (p) => userId(p.owner));
export const AccessConfig = obj({ target: str(), actions: arr(oneOf("answer", "send")) });

// plugins/conversations/worker.ts: the tool exists while any access (or the built-in peers) is on the list
self.contribute(Extensions, [grant(Peers, conversationsTool), grantForKind(AccessKind, conversationsTool)]);
```

Mario starts where he wants, on the Discord session: Add resource, "Access to a session", picks the target, `answer`
only, one hour. Two checks run: may Mario grant access to that target (he can send in it), may he change the channel's
list (the Discord plugin's rule). The expiry sits on the list entry, not on the resource.

:::figure wide | Session S2, fed by #support. Its source is the channel's list: the company key and access to one session, answers only, ending at 14:32. Discord people drive the whole list; the list is the control.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>p3 · Earendil / #support / Support bot</span></div>
<div class="mk-cols" style="min-height:250px">
<div class="mk-main">
 <div class="mk-h">Support bot</div>
 <div class="mk-sub"># support · Discord · owner Mario</div>
 <div class="mk-msg"><b>Lena · Discord</b>Is 0.9 out yet? The changelog link 404s.</div>
 <div class="mk-tool">conversations.answer → "Release notes draft"</div>
 <div class="mk-msg"><b>Pi</b>Not yet: the release notes are still in draft; the 0.9 changelog goes up with the release.</div>
 <div class="mk-msg"><b>Tom · Discord</b>Can you tell the release session to hurry up?</div>
 <div class="mk-tool err">conversations.send → refused: this session may only read answers of "Release notes draft"</div>
</div>
<div class="mk-panel">
 <div class="mk-h" style="font-size:13px">Resources <span class="mk-by core">core</span></div>
 <div class="mk-src"><span class="mk-ico" style="background:#5865f2">#</span>from <b>#support</b> <span class="mk-by" style="margin-left:auto">discord</span></div>
 <div class="mk-list">
  <div class="mk-li"><span class="mk-ico model">C</span><div class="t"><div>Company Claude key</div><small>model provider · <span class="mk-pill inst">instance</span></small></div></div>
  <div class="mk-li"><span class="mk-ico access">→</span><div class="t"><div>Release notes draft</div><small>answers only · Mario · <span class="mk-pill warn">ends 14:32</span></small></div></div>
 </div>
 <span class="mk-btn">Add resource</span>
 <div class="mk-note">No bash, no machine, no MCP: nothing else is on the channel's list.</div>
</div>
</div>
</div>
:::

At 14:32 the entry leaves the effective list; a call a second later is refused by the server, which finds the exact
entry behind that target and action and checks its deadline against the current time, whatever the worker still shows.
The session has no machine at all: its location is empty, so there is nothing to run bash on and no fallback to the
server machine.
# On the Worker {#worker lede="The worker follows its list; the harness lets in only extensions whose resource is on it; server views check every call."}

The list is computed on the server and pushed to the session's worker as the state of one view, `SessionResources`.
The worker reads it locally; a change arrives as one push. Nobody polls.

A plugin's worker facet contributes its Durable extension **together with the resource it belongs to**, the same
constant its server facet declared:

```ts
// plugins/coding-tools/worker.ts
self.contribute(Extensions, [grant(FileTools, fileToolsExtension), grant(Bash, bashExtension)]);

// plugins/harness: what Durable's registry is built from
function admitted(table: ExtensionTable, list: SessionList): readonly Extension[] {
	if (list.kind !== "ready") return [];                         // fail closed
	return table.flatMap(({ plugin, grant }) => {
		const ok = grant.kind === "resource"
			? list.entries.some((e) => sameAddress(e.resource, pack(grant.resource)) && e.plugin === plugin)
			: list.entries.some((e) => e.resource.contract === grant.of.contract.name && e.plugin === plugin);
		return ok ? [grant.extension] : [];
	});
}
```

The check `e.plugin === plugin` means a plugin cannot slip its extension in under another plugin's resource. A grant
naming a built-in nobody declared never runs and is reported to the author. Tools stop guarding themselves: p2's
`origin` and `locked` fields go; `scope` (main conversation or subagents) stays.

The filter alone is not enough, the review found: a code-mode script captured its tools when it started, and a worker
that lost its link still holds its last list. So the harness also checks at **every tool call**, nested ones included:
link live, list ready, entry present, deadline not passed. Things that are not tools check at their own door: the
composer's `!cmd` needs the bash built-in, a cache warmer re-admits its provider before each refresh, terminal and
voice channels re-check on use.

:::sequence animate | A session worker starts and follows its list: the harness admits extensions, models get pushed auth, MCP tools appear.
actor worker "S1's worker" "harness" accent
actor res "SessionResources" "server, core"
actor models "SessionModels" "server, models"
actor mcp "SessionMcp" "server, mcp"
worker -> res: hold (principal: worker S1)
res --> worker: list ready: Linear, gpu, Anthropic, built-ins
worker => worker: admitted(): file tools, bash, peers, Linear
worker -> models: hold
models --> worker: Anthropic + auth (expires 15:10)
worker -> mcp: hold
mcp --> worker: Linear: 23 tools
worker => worker: resume Durable: first turn runs
note res..mcp: each server view reads the same effective list: resourcesOf(self, principal, Kind)
:::

Resource plugins' per-session server views read the same list and check it at every call, so the worker is never the
last line:

:::sequence animate | Colin withdraws Linear from project pi while S1 is mid-script; the next call is refused on the server.
actor colin "Colin's page" "MyResources" blue
actor core "core resources" "server" accent
actor projects "projects" "pi's list"
actor mcp "SessionMcp" "S1's view"
actor worker "S1's worker" "harness"
colin -> core: withdraw Linear
core -> projects: remove(pi, Linear)
projects --> core: pi's list changed
core => core: recompute S1's list
core --> worker: list without Linear
core --> mcp: Linear gone
worker -> mcp: (sent before) call linear.search
mcp --> worker: refused: not on S1's list
worker -> worker: next phase: no Linear tools
:::

A call admitted before Colin's commit may finish; nothing is replayed. What is already in the transcript stays.

# Kinds in Code {#kinds lede="How models, MCP, machines and drives look under the same three parts."}

Every kind has the same three parts: a token in its contract file, a server facet that registers it and serves a
per-session view, a worker facet that grants its extension. What differs is what the worker gets.

**Model providers push credentials.** The worker streams from the provider itself; the server refreshes and pushes
pi-ai's auth with its expiry. Refresh tokens never reach the worker, and a cached token alone is not permission: the
worker refuses once the provider left the list or the auth expired.

```ts
host.serve(SessionModels, (_params, principal, self) => {
	const mine = resourcesOf(self, principal, ProviderKind);      // typed: Resource<typeof ModelProvider>[]
	const store = self.get(ModelStore, {});                       // pi-ai CredentialStore, one refresh per credential
	// a routine pushes { resource, models, auth, expires } for each, again before the earliest expiry
});
```

**MCP servers run on the server.** One resource per server, its transport in its configuration: HTTP (no location),
`server-stdio` (the p3 machine; admin by baseline), or `checkout` (an enabled `.pi/mcp.json` entry, bound to that env,
directory and the entry's digest, run there). The worker gets one extension per server on the list; every tool calls
`SessionMcp.call` with its conversation, so the server admits against the list now and checks that a checkout server
runs only where that conversation works. Processes stay per session by default, as in p2 (decision 4).

**Machines are where tools run.** A conversation's location names an env on the list; the machine p3 runs on is an
instance resource. Selecting a machine shows its detail view, assembled from panels three plugins contribute, none of
which imports the others:

```ts
self.contribute(Panels, [panel(Env, { title: t.message("files"), order: 10, Component: EnvFiles })]);          // files
self.contribute(Panels, [panel(Env, { title: t.message("terminals"), order: 20, Component: EnvTerminals })]);  // terminals
self.contribute(Panels, [panel(Env, { title: t.message("settings"), order: 90, Component: EnvSettings })]);    // envs
```

:::figure wide | Machine gpu selected. The layout mounts every panel registered for <code>Env</code>, each from its own plugin; a fourth (VNC) is someone's plugin added later. Each panel checks its own operations on the server.
<div class="mk">
<div class="mk-bar"><i></i><i></i><i></i><span>p3 · gpu</span></div>
<div style="padding:12px 16px 14px">
 <div style="display:flex;align-items:center;gap:9px"><span class="mk-ico env">G</span><div class="mk-h" style="margin:0">gpu</div><span class="mk-pill" style="background:#e3f1e6;color:#3f7a4b">ready</span><span class="mk-sub" style="margin:0">Cristina · ssh cristina@gpu.lab · Linux · 2× A100</span><span class="mk-by" style="margin-left:auto">row &amp; header: envs</span></div>
 <div class="mk-tabs">
  <div class="mk-tab">Files <span class="mk-by">files</span></div>
  <div class="mk-tab on">Terminals <span class="mk-by">terminals</span></div>
  <div class="mk-tab">Settings <span class="mk-by">envs</span></div>
  <div class="mk-tab" style="border:1px dashed #d5ccb9;border-bottom:none">VNC <span class="mk-by">vnc (3rd party)</span></div>
 </div>
 <div style="border:1px solid #e3dbcc;border-top:none;border-radius:0 0 8px 8px;padding:8px">
  <div style="display:flex;gap:6px;margin-bottom:6px"><span class="mk-chip">~/pi · bash</span><span class="mk-chip">~/bench · nvidia-smi</span><span class="mk-btn ghost" style="padding:1px 8px">+</span></div>
  <div class="mk-term"><span class="p">cristina@gpu:~/pi$</span> npm test -- upload --repeat 20<br>  ✓ upload › resumes after drop (19/20)<br>  ✗ upload › cleans temp dir (1/20)  ENOENT: /tmp/pi-up-7f3a<br><span class="p">cristina@gpu:~/pi$</span> ▍</div>
 </div>
</div>
</div>
:::

**Drives are file spaces.** People use a drive directly (the owner manages, members of a list holding it read); an
agent gets drive tools while any drive is on its list, each call naming a drive the server admits.

# Sign-in and Directories {#directories lede="SAML and Radius touch three places, each already in the model."}

Nothing about SAML or Radius appears in projects, MCP, models or the harness.

1. **Sign-in creates users.** A SAML plugin verifies the assertion and calls `Users.signIn({ issuer, subject, name })`.
   Emails are never identities.
2. **Sync mirrors groups as groupings.** `SamlGroup { name }` registers its members with core; they appear in the
   sidebar like any grouping and can be members of projects. A Radius plugin mirrors Radius org groups the same way.
3. **The policy names them.** "Only engineering may create MCP servers" is one rule on the settings screen above.

Radius resources are ordinary resources: signing in with Radius can create the user's Radius MCP server and Radius
model provider, by calling those plugins' `create` as that user. Whether one Radius sign-in can serve the relay, the
model gateway and the MCP server is the question still open with Armin and Vegard; in p2 these are three logins.
# What the Review Found {#review lede="Astra and Sol checked every p2 plugin; the model held, the edges needed work."}

Both reviewers mapped all 39 p2 plugins onto the spec and traced the six scenarios. Neither asked for a new noun, a
second resource source, per-run authority or login modes. Every plugin fits as a resource kind, a built-in, a grouping,
a presentation, or plain session infrastructure (search indexing, status, drafts, tree, file mirrors keep running
whatever the list holds). What they found were edges, now fixed in the spec:

- **Taking things away must stick.** Withdrawing a resource now raises a revision in core's index first, so the old
  entry stops counting everywhere at once, even in a project whose plugin is reloading and comes back with its old
  rows.
- **Copies must not smuggle.** Locking a project session down keeps only what the user could bring themselves; clones
  and forks re-check every entry. Cristina cannot keep Colin's server by detaching her session.
- **Using is not lending.** Being allowed to use the company key does not mean being allowed to put it into a project
  for everyone there.
- **Check at every call.** Code-mode scripts capture tools, and a disconnected worker keeps its last list, so the
  harness checks each tool call, and doors that are not tools (`!cmd`, cache warmers, terminal and voice channels)
  check at their own entry.
- **Typed tokens compare by declaration.** Each plugin bundles its own copy of another plugin's contract, so `===` on
  `McpKind` would fail; core compares declared names and versions through helpers.
- **Who acted travels as data on local calls,** because a local call acts as the server.
- **A session may have no machine.** The Discord session that only reads answers has an empty location, and nothing
  falls back to the server machine.
- **Per-action deadlines.** An hour of "answer" and five minutes of "send" to the same session expire separately, and
  revoking the target's sharing ends the access.

# Four Decisions {.epilogue lede="What only you can decide, each with a recommendation."}

1. **Built-in tools in project lists.** With "only admins bring instance resources", a project session has no bash
   unless an admin brings it. Recommendation: built-ins carry no login, so anyone who may use one may bring it, and a
   new project's list starts with every built-in its creator may use. The company key and build machine stay
   admin-only.
2. **Projects showing sessions they do not equip.** Linking a project session to Discord makes it use the channel's
   list, and it disappears from the project. Recommendation: let a project keep plain "shown here" references, drawn as
   "uses #support's resources", granting nothing.
3. **Exclusions from your defaults.** Recommendation: yes, a per-user set, so you can turn code mode or cache warming
   off everywhere while new tools still appear.
4. **MCP processes per session.** Recommendation: keep p2's default, one process per session, with a typed `lifetime`
   setting for servers that should be shared.

Still open elsewhere: whether one Radius sign-in can serve the relay, the models and the MCP server (Armin and Vegard);
running code on the server machine safely when several people share it (its own track).

# Where It Lives {.appendix}

| Piece | Plugin | You meet it as |
| --- | --- | --- |
| users, the instance user | users | sign-in; the company as an owner in pickers |
| resource kinds, index, lists, sources, `MyResources` | resources (core) | the session's resource panel, "Add resource", lock down |
| groupings with resources | projects, discord, ... | project view, channel link sheet |
| policy, typed requests, `guard` | policy (core), rules, default-policy | the access rules screen |
| extension grants, admission per call | harness (core) | tools appearing and disappearing |
| creators, renderers, panels, navigation | resources, presentation | pickers, rows, detail tabs, sidebar sections |

The spec with every API: `apps/p3/docs/resource-model/book.md`. The reviews: `/tmp/resource-model-review-astra.md`,
`/tmp/resource-model-review-sol.md`.
