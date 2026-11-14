# Slice 6: locks

**Goal.** A plugin declares what can be switched off or limited, registers it, and enforces it where it hands things
out; values per layer (org, Pi, app, session) only narrow; one sheet per layer; the agent's lock tools.

**Builds:** plugin `locks` (the registry, the stored values, each session's values computed live, the sheet, the
candidates), the plugin switch, tools naming their lock in the harness, Chord's rendering of another plugin's messages.

**Depends on:** slices 1–5.

**Read first:** `archive/locks/design.md` and Fable's review
(`/home/badlogic/chord-notes/research/p3-people-2026-11-13/locks-review-adm-fable.md`: four blocking fixes, a simpler
candidates design, cuts).

**From the archive:** `archive/rundown/book.md` (The Filters: where p2 decides what the model sees), `archive/org-managed/book.md` (the org layer's source), `archive/people/book.md` (Locks, The Plugin Switch, Layers and Sheets: the first version).

**Open (owner):** Fable's cuts: `version`/`migrate` on locks (my earlier yes reversed), the plugin switch as one
`plugins` lock, tools declaring their lock (dropping `coding.bash` and `mcp.tools` into `harness.tools`),
`maximumLock`; candidates as a function next to the lock, called when the picker opens.
