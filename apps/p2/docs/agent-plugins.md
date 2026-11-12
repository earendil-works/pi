# Agent-written plugins

The agent writes real p2 plugins (multiplayer or persistent views, server objects, tools) and applies them itself.
Custom HTML views stay for single-player artifacts.

## Problem

A custom view is one HTML page per viewer. A shared counter, a game with rules or a board several people edit needs
state on the server, rules applied there and events between viewers: a plugin. Before this, only a p2 checkout's
built-in plugins could be changed, only by owner-started turns, and only in dev mode.

## How it works

1. **The user plugin root**, `<data>/plugins/` (`userPluginsDirectory`, `src/runtime/host-dirs.ts`), is a second
   Chord plugins root after `apps/p2/plugins/` (`createP2Plugins`, `src/hosts/plugins.ts`). It is loaded and watched
   like the built-in root on the server, every worker, the web and the TUI bundles. A built-in wins a name clash
   (`listRoots`: the first root wins; discovery reports the clash). The server creates the directory at start (mode
   0700). User plugins import p2 only through `@p2/app/v1` and its per-kind modules; the bundles resolve `react` and
   the other host packages from the app's and the repository's `node_modules` (`common.nodePaths`,
   `src/hosts/bundles.ts`). `pluginFile(path)` from `@earendil-works/chord/plugins` resolves against the plugin's own
   directory in whichever root it lives (the facet's `plugin.dir`).
2. **Writing** uses the ordinary coding tools, no plugin file tools: the agent works in the server's environment. A
   session working on this machine writes there directly; any other session spawns a subagent with `env: null` and
   `cwd: <data>/plugins` (location `local:<data>/plugins`), whose tools then act on the server's files.
3. **Applying** is `reload_plugins` (plugins/dev-tools): the worker calls the server object `PluginReload` (worker
   principals only), which calls `ServerParts.plugins.reload(requested?)` (`applyPlugins` in `src/hosts/server.ts`):
   - `requested`, else every dirty plugin plus every plugin of the user root (an unchanged one keeps its digest, so
     its hosts keep it as it is: an apply never depends on the watcher having seen the last write; a directory not
     discovered yet is waited for once);
   - one `rebuild`: Chord's build, then the TUI and web bundles. Any failure stops before the rollout, so the old code
     and bundles stay;
   - per plugin: `applied`, `removed`, `failed` (the build's esbuild errors as `<kind>: file:line:column: message`,
     or a host's load error), `refused` (unknown, or a discovery problem: an invalid `package.json`, a built-in's
     name), plus the server's and workers' errors logged since the apply began (`processLogs`);
   - in dev mode the dev status is notified like the Reload button.
4. **Showing**: the `view` tool opens any kind a web facet registered in `ViewKinds` (docs/views.md).
5. **Guidance** is a skill, `plugins/agent-plugins/skills/writing-p2-plugins/SKILL.md`, with a complete, tested
   example next to it (`example/counter/`: a shared counter with presence, a wave event, a pane and a code-mode
   tool). Plugins' skills come from the worker registry `PluginSkills` (`src/runtime/plugin-skills.ts`, exported by
   `@p2/app/v1/worker`), keyed by plugin, `{ dir }` (a facet passes `pluginFile("skills")`). The prompt plugin lists
   them in `<available_skills>` after the environment's and the project's skills (the first skill of a name wins),
   counted as global skills (a locked session gets them only with its global instructions), and **only for
   conversations working on the server's machine**: the listing points at the plugin's files, never copied to another
   environment. Its local watches rewatch when the registry's directories change. A conversation on another
   environment gets instead the agent-plugins plugin's `p2-plugins` prompt section: multiplayer or persistent views
   are plugins; start a subagent at `local:<data>/plugins`, whose skills include the guide.
6. **Plugin tools** are deferred and code-mode only by default (`deferred: true, callers: ["tools"]`): the skill and
   the example say so; leaving both out offers a tool in the model's main list.

## Decisions

- **No per-turn authority.** `origin` is gone from p2 (tool requirements, `originOf`, `answerOrigin`, the `origin`
  fields of agent-written entries and of `Conversations`, `PeerConversation`, `ConversationBroker` and
  `AgentLocations`, each bumped a version). Whoever may send input in a session may have its agent use every tool it
  has. What a session's agents reach is decided by its tool selection, its location (a sandbox) and its lock.
  `reload_plugins` has no requirements, like bash: subagents can be given it.
- **A failed build applies nothing**, bundles included.
- **`Views` evolved to version 2** instead of changing in place; version 1 pages see only built-in kinds.
- **Kind names are not checked** against what pages register: the pane shows "Unknown view kind".
- **Plugin kinds stay out of the owner's view library.**

## Tests

`test/p2/agent-plugins.test.ts`: a subagent at `local:<root>` copies the example with `bash` and applies it with
`reload_plugins` (server object, event, presence, the code-mode tool, the view kind, the web bundle); an edit
reloads in place; build errors with file and line, refusals (a built-in's name, an unknown plugin); `pluginFile` in
the user root and its skills listed after the project's; a subagent given other tools cannot reload; a guest's turn
uses `reload_plugins` and the view library; in Chromium, an unknown kind's pane becomes the plugin's after the
reload. `envs.test.ts`: a remote conversation lists no plugin skill and gets the hint. `dev-tools.test.ts`: the
tool's results. `tool-access.test.ts`: `scope` and `locked` without origin.
