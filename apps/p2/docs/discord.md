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
- Linked: the bot, server › channel, who may wake Pi, the sandbox and what it may use, and **Unlink** (stops listening,
  lifts the lock; the session stays in its sandbox).

A session has at most one link and a channel at most one session (its threads follow it).

## How a channel talks to its session

- **Waking:** a message that mentions the link's bot, by someone allowed, in a linked channel. Bots never wake Pi; other
  messages only accumulate.
- **Batch:** the messages after the link's cursor up to the mention (at most 100; with no cursor the newest 50),
  oldest first, one `Name: text` paragraph each, the mention written `@Pi`, under a header naming the channel. It is
  one input of the session's main conversation by a guest author `Name · Discord` (entry kind `discord.batch`), queued
  as a follow-up when the session is busy. The cursor moves to the mention.
- **Bots:** only the link's own bot listens; another bot mentioned in the same channel is ignored. A reply waits while
  its bot is not connected.
- **Attachments:** each one up to 25 MiB (20 per batch) is downloaded by the worker into the session's uploads (source
  `discord`, key `discord:<message>:<n>`, Files sheet) and attached to the input as the composer's uploads are (paths
  listed, images inline). Larger ones are listed as links.
- **Reply:** when the input's turn ends (checked on every status change of the session and every 16 s), the answer's
  text is posted as a reply to the waking message, split at 2000 characters. A turn without an answer posts why. While
  a reply is pending and the session works, the channel shows "Pi is typing". A turn not done after 6 hours is given up.
- **Threads:** a thread of a bound channel gets its own subagent at its first mention: `discord-<thread name>`, forked
  from the main conversation at its last finished answer before the thread was created (a fresh conversation with the
  main agent's configuration when there is none). It lists in the sidebar like other subagents, follows the session's
  location and has no reporter: its batches (with the thread's own cursor) go to it, its answers back to the thread.
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
