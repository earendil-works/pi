# Pi on Discord

`plugins/discord` lets people in a Discord channel wake a p2 session by mentioning the bot. The session reads what was
said since its last turn, works in its sandbox, and its answer goes back to the channel as a reply.

## Setup

1. At https://discord.com/developers/applications create an application, add a **Bot**, turn on **Message Content
   Intent** (Bot → Privileged Gateway Intents), and copy the bot token.
2. In p2: sidebar → More → **Discord**, paste the token, **Connect**. The token is stored in `<data>/discord.json`
   (0600) and redacted from logs. A refused token or a missing intent shows in the sheet.
3. **Invite the bot to a server** (the sheet's link asks for: view channels, send messages and in threads, embed
   links, attach files, read history).
4. Put the session that should listen into a sandbox (Envs → sandbox; the binding form offers **Move**). Give the
   sandbox the secrets it needs (Envs → the sandbox → Secrets: GitHub, Radius, npm, any header).
5. **Bind a channel**: the channel, the session, who may wake Pi (anyone, or Discord user and role IDs), where the
   first delivery starts (after the newest message, or the last 50), and what the session may use (the lock, below).

## How a channel talks to its session

- **Waking:** a message that mentions the bot, by someone allowed, in a bound channel. Bots never wake Pi; other
  messages only accumulate.
- **Batch:** the messages after the binding's cursor up to the mention (at most 100; with no cursor yet the newest 50),
  oldest first, one `Name: text` paragraph each, the mention written `@Pi`, under a header naming the channel. It is
  one input of the session's main conversation by a guest author `Name · Discord` (entry kind `discord.batch`), queued
  as a follow-up when the session is busy. The cursor moves to the mention. **Deliver now** in the sheet delivers
  without a mention.
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
- **Refusals:** a session that is gone, archived or not in a sandbox gets nothing; the channel gets a notice instead.

## The session lock

Binding locks the session (`SessionLock`, kept by the sessions plugin as `p2.session-locks`, mirrored into the
session's Durable state as `p2.session-lock`). Everyone who may wake Pi can use everything the lock allows, so it lists
exactly what the owner picked:

- **MCP servers:** only the picked servers of `mcp.json`; the project's `.pi/mcp.json` servers only when picked.
- **Instructions:** the global AGENTS.md, skills and prompt templates only when picked (the project's own always).
- **Capabilities:** `ports` (forwarding) and `conversations` (messaging other sessions) only when picked;
  `reload_plugins` never. Other owner-only tools pass: what they reach is already confined (location tools by the
  sandbox).

In a locked session the lock replaces the "a turn the owner started" check, for the owner too. Unbinding the last
channel of a session lifts its lock.

## State

- `<data>/discord.json`: `{ "token": "…" }`, 0600.
- Server state `p2.discord-bindings` (persisted): bindings by channel (session, who may wake Pi, cursor, threads with
  their subagent conversation and cursor) and pending replies by waking message (session, reply channel, submission).
- The bot (discord.js, a server host package: plugins cannot bundle from the app's hoisted `node_modules`) runs in the
  server's host-lifetime `DiscordStore`; its relay logic (`relay.ts`) is plain code over a Discord port and a session
  port, tested with fakes (`test/p2/discord.test.ts`).
- The worker side is `DiscordIngress` (server only): `deliver` (downloads, the input), `turn` (the submission's state
  and answer), `thread` (the fork).

## Not done

- The transcript shows a batch as one guest message; there is no folded view of the channel's messages.
- No `@Pi stop`, no per-binding secrets (secrets are per sandbox), no DMs.
