# Direction under discussion: Pi Roam (owner, Armin, Colin, 2026-11-09)

Notes only, nothing decided. Recorded from the owner's voice summary so the discussion can pick it up again. The
resource model spec (`resource-model/book.md`) stays as it is until this is discussed; nothing is trimmed or shelved.

## What was said

1. **Your own Pi instance, fully extensible.** A personal instance with its sessions and its own plugins. Everything is
   overridable or extensible, like in the old pi: the main transcript view, the sidebar, layouts (a Discord integration
   with its own transcript view, and so on), on the page, in the session worker and on the server. p3 provides the
   primitives to build whatever you want in a structured way.
2. **Backups through Radius.** Connect your instance to Radius and its Chord stores sync up; provision a new machine,
   connect an instance, restore it from a backup.
3. **Remote access through Radius.** Pick your instance in Radius and get its interface as its plugins make it (Radius
   relays the instance's own UI; relevant to Cristina's sharing proposal).
4. **A one-click cloud machine on Radius.** A persistent computer with Pi Roam deployed. Earendil's case: one shared
   instance for the team (15 to 20 people), also in the Discord channels, on one cloud machine. Whoever provisions it
   sets up what everybody should have (GitHub CLI, mail and drive accounts, internal systems). A smaller circle gets its
   own instance.

## Consequences the owner named

- **The instance is the trust boundary.** That pushes most of the permission and resource machinery away from Pi.
- **Multiplayer inside one instance is not solved by this,** and in practice has rarely been used (one public share on
  Twitter for show; no collaborative session since). Session sharing stays, with the rule: whoever watches a shared
  session can reach whatever that instance and the session's environment can reach; the sharer must be mindful.
- **Environments stay:** connect as many machines as you want, as on the current instance.
- **Locked-down sessions are still interesting** (Discord: a fixed environment and tool set, the conversation tool
  limited to sessions the owner marks), but it is open whether that needs all of the resource machinery designed so
  far. To be discussed.
