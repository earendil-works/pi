# Pi on Discord

`plugins/discord` lets people in a Discord channel wake a p2 session by mentioning a bot. The session reads what was
said since its last turn, works in its sandbox, and its answer goes back to the channel as a reply.

## Bots (More › Discord)

Bots are global: the owner sets them up once, then links sessions to channels from the sessions themselves.

1. At https://discord.com/developers/applications create an application, add a **Bot**, turn on **Message Content
   Intent** (Bot → Privileged Gateway Intents), and copy the bot token.
2. More › Discord lists the bots with their status. **Add bot**: paste the token, **Connect**. Discord's refusal
   (a wrong token, the intent off) shows there and nothing is kept; once Discord accepts it, the bot's sheet opens.
3. A bot's sheet: who it is and whether it is connected, the servers it is in (live: inviting it somewhere adds the
   server), the **invite link** (copy or open; it asks for view channels, send messages and in threads, embed links,
   attach files, read history), its linked sessions (read-only; tap one to open it), **Replace token** (a new token of
   the same application, kept once Discord accepts it) and **Remove bot** (its sessions are unlinked and unlocked).

Several bots may run. Tokens live in `<data>/discord.json` (`{ "bots": { "<id>": { "token", "addedAt" } } }`, 0600)
and are redacted from logs. The first release's `{ "token": … }` becomes bot `bot1` at the next start, and its links
name it. A bot that cannot reach Discord tries again every minute; a refused token or intent waits for a new token.

## Linking a session (Session sheet → Discord)

The Session sheet's **Discord** row shows the session's channel, or "Not linked". Its sheet:

- Not linked: pick the **bot** (connected ones), the **server** (the bot's), the **channel** (that server's text
  channels; one linked to another session shows as taken), **who may wake Pi** (anyone in the channel, or members
  with picked roles, plus optional user IDs), the **sandbox** (existing ones), and **what the session may use** (MCP
  servers of `mcp.json`, the project's MCP servers, the global instructions, forwarding ports, messaging other
  sessions). **Link** stays disabled and says what is still to pick. Linking moves the session into the sandbox (as
  the owner's Relocate does, into the sandbox's first folder, else `/root`; a busy session refuses, nothing changes),
  stores its lock and the link, and starts listening after the channel's newest message.
- Linked: the bot, server › channel and sandbox (fixed), then who may wake Pi and what the session may use, editable:
  **Save** (enabled once something changed and someone may still wake Pi) stores them in place (`Discord.updateLink`,
  contract version 3; version 2 pages still bind) and they apply at once: who may wake Pi is read at each message, the
  lock is mirrored into the running session. **Unlink** stops listening and lifts the lock; the session stays in its
  sandbox.
- **The agent knows:** a linked session's main agent and its threads' subagents get a two-sentence `discord` prompt
  section: their input comes from the channel (or thread), their final answer of each turn is posted there as the
  reply with the files offered with `send_file` during the turn attached, and nothing else is posted (intermediate
  text, thinking, tool output), so the final answer must stand alone. Its text changes only with the link. The worker keeps the link in the session
  document `p2.discord-link` (written at each delivery, cleared at unlink through `DiscordIngress.unlinked`); other
  subagents do not get the section.

A session has at most one link and a channel at most one session (its threads follow it).

## How a channel talks to its session

- **Waking:** a message that mentions the link's bot, by someone allowed, in a linked channel; other messages only
  accumulate. Other bots count as people (in batches, and waking Pi by the same rules); the link's own bot never
  counts. Loop guard: at most 3 turns in a row started by bots per channel or thread; the next bot mention gets one
  short notice ("Not answering more bots here until a person writes"), later ones nothing (logged), until a person
  writes there (any message). The count is in memory.
- **Batch:** every message after the link's cursor up to the mention (paged through Discord's history 100 at a time;
  a thread's first batch starts at the thread's start), oldest first, one `Name (<@id>): text` paragraph each (bots
  `Name (bot, <@id>)`, so the agent can mention them as `<@id>`; replies ping users, never roles or @everyone), the
  mention written `@Pi`, under a header naming the channel and the count. At most the newest 200 go into the input; the header
  says how many earlier ones were left out. It is
  one input of the session's main conversation by a guest author `Name · Discord` (entry kind `discord.batch`), steering
  the turn under way when the session is busy (the batch joins it). A turn that took several inputs has one answer
  (Durable settles them all with it): it is posted once, to the newest mention, with the files of the whole turn; the
  other pending replies go without a post. The cursor moves to the mention. Deliveries run one at a time per channel
  and per thread (a queue each): a second mention right after the first waits for it and starts at the cursor it
  left, so no message is in two batches and a new thread forks one subagent.
- **Catch-up:** when a bot connects (p2 starting, a new token, a new gateway session after an outage), it reads each of
  its links and their known threads after the cursor. The newest mention there by someone allowed to wake Pi is the
  trigger: one batch per channel or thread with every message from the cursor up to it (earlier missed mentions are
  just messages of the batch), and the reply goes to that newest mention. Its events and live
  messages are handled one at a time, and a mention at or before the cursor never delivers twice. Threads created
  while p2 was down are not searched.
- **Bots:** only the link's own bot listens; another bot mentioned in the same channel is ignored. A reply waits while
  its bot is not connected.
- **Attachments:** each one up to 25 MiB (20 per batch) is downloaded by the worker into the session's uploads (source
  `discord`, key `discord:<message>:<n>`, Files sheet) and attached to the input as the composer's uploads are (paths
  listed, images inline). Larger ones are listed as links.
- **Reply:** when the input's turn ends (checked on every status change of the session and every 16 s), the answer's
  text is posted as a reply to the waking message, split at 2000 characters. A turn without an answer posts why. While
  a reply is pending (queued or not) the channel shows "Pi is typing": sent the moment a mention is recognized, before the
  wait for an earlier delivery and the history's pages, refreshed every 8 s (Discord shows it about 10 s) through the
  delivery and while the reply is pending, and over once the reply is posted, the turn stopped or failed, or the
  delivery failed. Commands never type. A turn not done after 6 hours is given up.
- **Files:** what the agent offers with `send_file` during a Discord-started turn (the main agent's, or a thread
  subagent's; also from scripts) is attached to the reply: `send_file` downloads carry their conversation as `ref`, and
  the worker's `turn` lists those made between the input and the answer. Read through the session's Files
  (`DiscordIngress.read`) and uploaded with the reply (multipart): at most 10 a message, together within the server's
  per-message limit (10 MiB; 50 MiB and 100 MiB on boosted servers). Larger files are named in the reply only. A turn
  with files and no text posts the files alone.
- **Commands:** a mention of the bot by someone allowed to wake Pi whose remaining text is exactly `stop`, `status`
  or `compact` (any case, an optional leading slash: `@Pi /stop`) is a command, run at once (not behind a delivery
  under way) on the main conversation, or in a thread on its subagent. `stop` is the web's Stop: queued inputs are
  withdrawn, the run is aborted; it also aborts running compactions (tasks of their own, which Stop leaves running:
  the web's Escape path), read from Durable since a compaction just started may not be in the view yet. It answers
  "Stopped." (with how many queued messages were withdrawn), "Stopped compaction.", both, or "Nothing is running.", and
  the stopped turns post nothing. `status` answers the model, whether it works (and compacts), the queued inputs, the
  context's use, and the cost so far (the cost sheet's data: the target conversation's responses) with the last
  turn's (the responses since its newest input); `compact` starts a compaction and says so. Commands never go into a batch and are not caught up
  on after downtime (a missed `stop` is stale). They are left out of batches rather than moving the cursor past them,
  which would drop the undelivered messages before them. A mention of the bot's own role counts as a mention of the
  bot.
- **Threads:** a thread of a linked channel gets its own subagent at its first mention: `discord-<thread name>`, forked
  from the main conversation at its last finished answer before the thread was created (a fresh conversation with the
  main agent's configuration when there is none). It lists in the sidebar like other subagents, follows the session's
  location and has no reporter: its batches go to it, its answers back to the thread. Its first batch holds what it
  never saw: the channel's messages after the channel's cursor up to the thread's creation (under "[#channel, before
  the thread]"), then the thread's messages up to the mention ("[The thread]"); the channel's cursor stays, so the main
  agent still gets those channel messages. After that the thread has its own cursor.
- **Refusals:** a session that is gone, archived or no longer in a sandbox gets nothing; the channel gets a notice.

## The session lock

Linking locks the session (`SessionLock`, kept by the sessions plugin as `p2.session-locks`, mirrored into the
session's Durable state as `p2.session-lock`). Everyone who may wake Pi can use everything the lock allows, so it lists
exactly what the owner picked:

- **MCP servers:** only the picked servers of `mcp.json`; the project's `.pi/mcp.json` servers only when picked.
- **Instructions:** the global AGENTS.md, skills and prompt templates only when picked (the project's own always).
- **Capabilities:** `ports` (forwarding) and `conversations` (messaging other sessions) only when picked;
  `reload_plugins` never. Other owner-only tools pass: what they reach is already confined (location tools by the
  sandbox).

In a locked session the lock replaces the "a turn the owner started" check, for the owner too. Unlinking lifts it.

## State

- `<data>/discord.json`: the bots' tokens (above).
- The bots' avatars reach the sheets through `GET /discord/avatar?bot=<id>` (owner only, fetched from Discord's CDN by
  the server and kept per avatar): the page's CSP loads only its own images.
- Server state `p2.discord-bindings` (persisted; version 2 adds the bot): links by channel (bot, session, who may wake
  Pi, cursor, threads with their subagent conversation and cursor) and pending replies by waking message (bot,
  session, reply channel, submission).
- The bots (discord.js, a server host package: plugins cannot bundle from the app's hoisted `node_modules`) run in the
  server's host-lifetime `DiscordStore` (`fleet.ts`, one `Bot` each, `bot.ts`); the relay logic (`relay.ts`) is plain
  code over bot and session ports, tested with fakes (`test/p2/discord.test.ts`). The sheets: `BotsSheet.tsx`,
  `LinkSheet.tsx` (`test/p2/ui-discord.test.ts`).
- The worker side is `DiscordIngress` (server only): `deliver` (downloads, the input), `turn` (the submission's state
  and answer), `thread` (the fork).

## Not done

- The transcript shows a batch as one guest message; there is no folded view of the channel's messages.
- No `@Pi stop`, no per-link secrets (secrets are per sandbox), no DMs.
