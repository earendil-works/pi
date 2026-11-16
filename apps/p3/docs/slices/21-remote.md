# Slice 21: Remote access, forwards and backups

**Goal.** Reaching the Pi from elsewhere and keeping it safe: the Radius relay link (a relayed owner treated as remote), forwards of local ports (bounded, public toggle, the agent's tool, closed on archive), whole-Pi backups and restore (decision "Backups, not session sync"), tunnel ingress and a public origin.

**Depends on:** slices 1, 5.

**Read first:** p2's `plugins/radius/`, `plugins/ports/`, `plugins/backup/`, `plugins/sync/`, `plugins/proxy-marker/` (to drop); `apps/p3/docs/decisions.md` ("Backups, not session sync"); design §23 (HTTP relays, the security baseline).

The brief is filled out when the slice is next, starting with p2's features in its area (`../workflow.md`).
