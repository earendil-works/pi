---
name: p2-ui
description: How to build UI in p2 (apps/p2): its own building blocks, design tokens and look rules, back navigation, phone input rules, tools' UI in their plugins, reloads and browser tests. Use when building or changing p2's web UI.
---

# Building p2's web UI

Paths are relative to `apps/p2`. Read `docs/handoff.md` and the matching part of `docs/p2-notes.md` first.

## Use p2's own building blocks

- **Sheets:** `Sheet` from `src/runtime/web.tsx` (`.sheet-layer`/`.sheet`/`.sheet-grip`/`.sheet-head`/`.sheet-body` in
  `src/web/style.css`): grip, 52px header with an `h2` title and Close, swipe down to close on phones, a centred dialog
  from 700px. A page inside a sheet passes `onBack` (Back button before the title). Never use a third-party
  drawer/dialog (Elanor/base-ui `Drawer`, etc.) where p2 has one.
- **Side panel:** `SidePanel` from `src/web/SidePanel.tsx`: docked on the right from 700px (`#side-dock`, beside the
  chat from 1280px), p2's `Sheet` on phones. Not modal; one thing at a time: a run's activity (`Route.activity`) or a
  plugin's panel (`Route.panel`, `openPanel(name)`/`closePanel()`); render it only while `useSidePanelShown()`.
  Docked, its left edge resizes it. Any panel size the reader drags uses `useDragSize` (`src/web/drag-size.ts`).
- **Layers and routes:** a sheet or viewer is a route layer: `openLayer({ kind: "sheet", name, locator })`,
  `closeLayers()`, `useSheet(name)` (the top layer when it is yours, with its `locator`). Locators are small serialized
  values (JSON of ids), never component state; read them back as untrusted (`try`/shape check). Layer model and Back
  logic: `src/web/navigation.ts` (`Navigation.push/close/closeThenPush/backOrPush`).
- **Plugin contributions:** web facets contribute to keyed registries (`self.contribute(Slots, { "name": Component })`,
  `SlotList` for `prefix:name` lists, `ToolActivities`, `ComposerExpanders`), declared in `src/runtime/web-core.ts`
  and read with `useRegistry`. Plugins import p2 only through `@p2/app/v1/web` (`src/api/v1/web.ts`).
- Shared components: `Code.tsx` (`CodeBlock`, `DiffBlock`, `LinesBlock`), `Markdown.tsx`, `Viewer.tsx` (`FileCard`),
  `icons.tsx` (p2's icon set), `activity/Detail.tsx` (detail blocks).

## Tokens and look

- Colours `--text`, `--muted`, `--faint`, `--line`, `--bg`, `--hover`, `--user`, `--ok`, `--bad`; spacing `--x` (16px
  inset), `--s1`…`--s5` (4/8/12/16/24); sizes `--row` (44px row), `--bar` (52px), `--control` (40px),
  `--control-sm` (32px), `--radius` (4px); type `--fs-xs/sm/md/lg/code`, `--fw-strong`, `--mono`. No raw values
  where a token exists.
- Owner rules: no coloured side edges, no left border lines, no decorative borders; rows separated by `1px solid
  var(--line)` at most. Kinds differ by icon and word, never by per-kind colour. Touch targets at least 44px
  (`min-height: var(--row)`). Message text stays selectable: links and tap targets go on headers, never on bodies.
- States: the open or selected row is filled (`background: var(--hover)`), never an inset side edge; a chosen option
  shows its check icon. Hover backgrounds only inside `@media (hover: hover)` (touch browsers keep `:hover` after a
  tap); `:active` gives press feedback everywhere. Popovers and dialogs: a 1px `--line` border, no shadow.
- Text levels: `--text`, then `--muted` for anything a reader needs (meta, sizes, timestamps, hints); `--faint` only for
  placeholders, icons, chevrons and line numbers. Empty lists say so with `.empty-note`.
- Coarse pointers: list rows and small controls grow to `--row` in the touch-target block at the end of style.css; add
  new rows and small buttons there instead of per-screen media queries. Scrollbars are thin everywhere (one rule on
  `*`); do not add per-element scrollbar styles.
- Tabs in a bar fill its height, so the selected tab's underline sits on the bar's bottom line. A page inside a sheet
  goes back with the header's Back (`onBack`), not a "← back" link in its body.
- Transcript rhythm (`.row` in style.css, `TranscriptRow.gap` in Chat.tsx): a row carries its spacing to the row
  before as padding. A new turn (a person's message, an incoming message, the agent's first part after it, a marker)
  starts `--s5` below; the parts of the agent's turn (thought, words, wheel, answer, results) follow `--s2` apart.
  One-line rows are exactly `--row` tall: the working wheel, a settled wheel, a "Thought" row, an incoming header;
  the turn's first part is at least `--row` (`data-lead`), so Working… turning into anything never shrinks the turn.
  Inside a block: `--s3` (answer paragraphs and code blocks, card and code padding), `--s2` (results, inline
  artifacts below their card, images); the copy/branch actions pull up `--s2` to sit under the answer.

## Back navigation

Every sheet, every page inside it (a detail view) and every jump to another screen is a history entry, so Android's
back gesture and the browser's Back undo it one step at a time:

- Open a sheet: `openLayer(layer)`. A page inside it: push one more layer (`getNavigation().push({ ...route, layers:
  [...route.layers, layer] })`). Several steps at once: compute each route from the current one first (pushes are
  queued, `nav.route` is not updated yet), as `openActivity` in `src/web/activity/ActivitySheet.tsx` does.
- Header Back: `getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, -1) }))`. Close/scrim/
  swipe/Escape: `closeLayers()`.
- Another conversation or session: `navigate({ session })` or the chat's `OpenConversation`/`OpenPeerConversation`
  (`closeThenPush`: Back returns to where the reader was, without the closed layers).
- Render a layer from a component that stays mounted (the transcript's `Messages`, a slot), not from a virtualized row.

## Phone input rules

- A controlled input gets its value in the same render as the keystroke: never route the value through an effect or a
  later render (e3c8c3b48: the caret jumped to the end and keyboard composition broke).
- Buttons next to the composer keep the textarea focused on `pointerdown` (`keepComposerFocus`, 52e9c17b0): otherwise
  the keyboard closes, the layout jumps and the first tap is lost.
- Long press (500 ms, no move) is the touch path for hover actions (reply); keep text selectable.

## Tools' UI lives in their plugins

No tool-specific code in `src/web`, `src/tui` or `src/runtime` (no tool names, labels, phrases, renderers or a tool's
`details` format). The plugin that owns a tool contributes its `ToolActivity` (type in `src/web/activity/model.ts`)
to `ToolActivities` keyed by tool name, from its web facet (`plugins/<name>/activity.tsx` + `web.tsx`, e.g.
`plugins/coding-tools`): `describe`/`running` labels (a `Kind` icon, verb, object, extra), `argument`, `failure`,
`summary(count)`, `Detail`, `hasResult` ("after" the answer or "inline" in place) + `Result`, `nestedCalls` and
`repeated` for a tool that runs others, `CallInput`/`CallDetail` for its calls made by scripts; its TUI facet
registers `ToolRenderers` in `TuiToolRenderers`. Tools without one get the generic look. Do not add UI fields to tool
declarations or schemas. Add new plugins' contributions to `PLUGIN_TOOLS` in `test/fixtures/transcript.ts` (TUI:
`PLUGIN_TUI_RENDERERS` in `test/fixtures/tui-tools.ts`). The whole guide, with a complete example plugin:
`docs/tool-ui.md`.

## State and contracts

- Actions, pending states and loads: follow `docs/optimistic-ui.md` (`useOptimisticCall` in `src/runtime/web.tsx`,
  the outbox, kept copies).
- Bumping a contract version needs an `accepts` entry for the previous version (`evolve` with the released version
  verbatim): `docs/p2-notes.md`, "Contract versions"; `test/p2/contract-versions.test.ts`.

## Reload or restart

Plugin code, web facets included, reloads with Reload / `npm run reload` in dev mode. `src/runtime`, `src/hosts`, the
base web bundle (`src/web`, `src/api`), contracts and workspace packages need a restart (`npm run reload --
--restart`). Never hand-test on real sessions: a throwaway data dir or `startFixture`.

## Tests

- Browser tests: `test/p2/ui-*.test.ts` with `Browser` (`test/p2/browser.ts`): `start`, `metrics(390, 844)` (phone;
  `mobile: true` below 700px), `open`, `wait(expr)`, `click(selector)` (waits until hit-testable, no running
  animation), `evaluate`, `call(cdpMethod)`. `startFixture({ web: true })` + the fake provider (`P2_FAKE` prompts in
  `plugins/models/fake.ts`), or a component fixture (`browser.loadFixture("codemode-card.ts")`, `test/fixtures/`).
- Back: `browser.evaluate("history.back()")`, then wait for the previous state.
- Touch: `call("Emulation.setTouchEmulationEnabled", { enabled: true })` and `Input.dispatchTouchEvent`. CDP touch
  emulation has limits: no real long press or OS text selection, no soft keyboard; test those paths by their
  handlers (timers, `pointerdown`).
- Run them on slayer (`CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker`, Node 24) in a scratch clone, never in
  `~/pi` or `~/p2-live`. Screenshots: `call("Page.captureScreenshot")` at 390×844.
- Before reporting: `npm run check` in `apps/p2` (tsc clean, Biome 0 diagnostics).
