# pi-env agent

`pi-env agent` keeps a machine permanently reachable for its owner through Radius, without SSH: the same binary as
`pi-env serve`, run as a user service, connected outbound to the owner's Radius relay. Through it the owner's Pi (p2)
runs pi-env sessions on the machine, exactly as over SSH ([protocol.md](protocol.md)), and the machine's local HTTP
services are reachable as port forwards. In Radius such a machine is a server row of kind `env`.

## Commands

```text
pi-env install [--gateway URL] [--code CODE | --code-stdin] [--name NAME] [--state DIR] [--no-service]
               [--service-name NAME]
pi-env enroll [--gateway URL] [--code CODE | --code-stdin] [--name NAME] [--state DIR]
pi-env agent [--state DIR]
pi-env status [--state DIR]
pi-env uninstall [--state DIR] [--keep-state]
```

- `install` enrolls (below), copies the running binary to `<state>/bin/pi-env` (through a new file, so a running
  agent's binary is never written over), installs and starts the user service, and prints as its last stdout line
  `{"server_id", "organization_id", "public_origin", "service"}` with `service` one of `systemd-user`, `launchd`,
  `schtasks`, `termux`, `none`. Instructions (how to start the agent without a service, lingering) go to stderr.
  `--no-service` skips the service (`service: "none"`); `--service-name` names the service (default `dev.pi.env` for
  launchd, `pi-env` elsewhere), for several agents on one machine and for tests. Running `install` again stops the
  service, replaces the binary and starts it again; the enrollment stays.
- `enroll` only enrolls, and prints the same JSON without `service`.
- `agent` runs the relay host in the foreground: what the service runs.
- `status` prints `{enrolled, stateDir, serverId, organizationId, gateway, name, publicOrigin, service: {kind, name,
  state}, relay}`, where `service.state` is `running`, `stopped`, `not_installed` or `unknown` and `relay` is what the
  running agent last wrote to `status.json` (`{relay: "connecting"|"connected"|"retrying"|"revoked", error?, pid,
  serverId, updatedAt}`).
- `uninstall` stops and removes the service and, unless `--keep-state`, the state directory. It does not remove the
  machine from Radius; the owner does that in the shell's Machines view, which also revokes its grant.

The gateway defaults to `https://radius.pi.dev`; `http://` gateways (then `ws://`) are for local development and tests.

## Enrollment

- With a code (`--code`, or `--code-stdin`, which reads it from stdin so it stays out of process lists): the agent
  generates a lowercase UUIDv4 server ID and redeems the code at `POST <gateway>/v1/oauth/token` with
  `grant_type=urn:radius:params:oauth:grant-type:enrollment_code`, `client_id=pi-env`, `code`, `server_id` and the
  optional `name`.
- Without a code: the device flow. `POST <gateway>/v1/oauth/device` with `client_id=pi-env`,
  `scope=host offline_access` and `server_id`; the verification URL and the user code go to stderr; the agent polls the
  token endpoint with the device-code grant at the given interval (`slow_down` adds 5 s) until the owner approves or
  the code expires.
- The token response must carry `organization_id`, `principal_id` (the owner) and a refresh token; `server_id` and
  `public_origin` are taken when present.
- An enrolled state is kept: without `--code`, `install` and `enroll` reuse its server ID and credentials (a `--name`
  updates the name). A code always enrolls anew, with a new server ID. A different `--gateway` without a code runs the
  device flow.

## State

Default `~/.pi/env` (Windows `%USERPROFILE%\.pi\env`). Every file is written atomically (a temporary file renamed over
it).

| file | content |
|---|---|
| `agent.json` | `{gateway, serverId, organizationId, principalId, publicOrigin, name, service: {kind, name}}` |
| `credentials.json` | `{access_token, refresh_token, expires_at}` (milliseconds since the epoch), mode 0600 |
| `forwards.json` | `{forwards: [{id, port, name?, public?, tag?}]}` |
| `status.json` | the relay state the running agent reports (see `status`) |
| `agent.log` | the agent's log, moved to `agent.log.1` at 1 MiB (one generation kept) |
| `bin/pi-env` | the installed binary the service runs |
| `task.xml` | Windows only: the scheduled task's definition |

## Relay host

The agent ports the host side of p2's brain (`apps/p2/plugins/radius/brain.ts`) to Rust, with the relay protocol of
Radius (`packages/gateway/src/servers/protocol.ts`).

- It connects `wss://<gateway>/v1/servers/<serverId>/connect?replace=1&name=<name>` with `Authorization: Bearer
  <access token>`, offering only `pi-server.host.v5`. The name is the configured one, else the host name.
- Heartbeat: a `ping` after 20 s without any message from the relay, the connection counts as lost after 60 s
  (wall-clock time, so a sleep is noticed at once). Reconnects back off from 1 s, doubling, to 30 s.
- Replacement: a host closed with 1012 "Server host replaced" was replaced by another agent with the same server ID;
  it reconnects without `replace`, so the relay answers 409 until the other one is gone, and replaces again once it
  is connected.
- Tokens: the access token is refreshed (`grant_type=refresh_token`) when it expires within 5 minutes, and after the
  gateway answered 401 for it; a returned refresh token replaces the stored one. A refresh refused with 400 or 401
  means the machine was removed: the agent logs it, reports `revoked`, and tries again every 5 minutes. A failed
  refresh of a token that is still valid keeps using it.
- The owner is `{kind: "user", id: principalId, organization_id: organizationId}`.
- When the host socket is lost, every channel ends with it, as the relay fails them.

`connection_open` is handled as follows:

| channel | handling |
|---|---|
| `ws`, no `forward`, the owner | env channel (below) |
| `http` or `ws` with `forward`, the owner or anonymous | forward proxy (below) |
| `http`, no `forward`, the owner | 404 `text/plain` "This machine runs pi-env without Pi." |
| anything else (members, service accounts, anonymous without forward, `stream`) | `connection_close` 1008 |

### Env channels

The agent opens the channel's socket, `/v1/servers/<serverId>/channels/<connection_id>` with subprotocol
`pi-server.channel.v1` and the bearer token (retried once with a refreshed token after a 401; a failure is answered
with `connection_close` 1011, so the relay fails the client's upgrade at once). The client's first message must be the
text head `{"type":"pi-env","token":"<1 to 64 lowercase hex digits>"}` within 30 s; the agent answers with the binary
message `PI-ENV <token>\n` and then runs one session exactly as `serve` does over stdio: client binary messages are
its input, each output frame goes out as one binary message. A missing or invalid head, or a text message after it,
closes the channel with 1008. When the channel ends (or sends nothing for 30 s), everything the session started is
killed, as on the end of stdin. Stopping the agent (SIGTERM, SIGINT, SIGHUP) kills the commands of every session.
Sessions are independent; each runs on threads of its own, as `serve` does (no async runtime).

Env channel sessions have the operations `forwards`, `forwardSet` and `forwardRemove` ([protocol.md](protocol.md),
"Forwards"), and `hello.features` lists `forwards`.

### Forward proxy

A channel naming a forward goes to `localhost:<port>` of that forward (127.0.0.1 first, then ::1), as p2's
`#openForward` does:

- An unknown forward answers 404 "This port forward does not exist (any more)." (HTTP) or is refused with 1008
  (WebSocket). An anonymous channel (no principal, from the public `pub--` origin) reaches only forwards marked public;
  others look unknown.
- `Host` is `localhost:<port>`; an `Origin` equal to the forward's public origin becomes `http://localhost:<port>`;
  `X-Forwarded-Host` and `X-Forwarded-Proto` name the public origin. Hop-by-hop headers are dropped.
- HTTP: one HTTP/1.1 request with `Connection: close`. A request with `Content-Length` keeps it; one without uses
  chunked encoding unless its method has no body by default (GET, HEAD, DELETE, OPTIONS, TRACE, CONNECT), as Node
  sends requests. Request body bytes are credited to the relay once written to the local server; response body bytes
  are sent in frames of at most 256 KiB, never more than the relay's window unacknowledged. A `Location` starting with
  `http://localhost:<port>` or `http://127.0.0.1:<port>` (followed by nothing, `/` or `?`) points at the public origin.
  Nothing listening, or a failure before the response head, answers 502 "Nothing is listening on port N of this
  machine."; a failure after it ends the channel with `connection_close`.
- WebSocket: the local socket is opened first, offered the client's first subprotocol only; then the channel socket.
  Either failing is refused with 1011. Messages pass unchanged both ways, and a close passes on with its code.

Backpressure: each socket's writers block while its TCP connection does not take more, so a slow relay or client slows
the local source instead of growing the agent's memory. See `src/agent/ws.rs` for how a reader waits without holding
the socket's lock.

## Services

| system | service | validated |
|---|---|---|
| Linux | systemd user unit `~/.config/systemd/user/<name>.service` (`Restart=always`, `RestartSec=2`), `daemon-reload`, `enable`, `restart`; then `loginctl enable-linger $USER`, with a warning when that fails. Without a user systemd (`systemctl --user show-environment` fails): `none`, with `nohup` and crontab `@reboot` instructions | compiles (clippy for aarch64 and x86_64 musl); not run |
| macOS | LaunchAgent `~/Library/LaunchAgents/<label>.plist` (`RunAtLoad`, `KeepAlive`, `ThrottleInterval` 5), `launchctl bootout` then `bootstrap` in `gui/$UID`, else `user/$UID` (no GUI session, as over SSH) | yes: `test/agent-launchd.test.ts` |
| Windows | scheduled task `<name>` at logon of the current user (`InteractiveToken`, no time limit, restart on failure every minute), created from UTF-16 task XML with `schtasks /Create /XML`, started with `schtasks /Run` | **unvalidated**: compiles (clippy for x86_64-pc-windows-msvc); a console window may show while the agent runs |
| Android (Termux) | `~/.termux/boot/<name>` (needs the Termux:Boot app) and a start now, detached; no restart after a crash | **unvalidated**: compiles (clippy for aarch64-linux-android) |

Login environment (POSIX): a service starts with a bare environment (launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`).
At startup, before any other thread, the agent runs `$SHELL -l -c 'env -0'` (the shell from `SHELL`, else the password
database, else `/bin/sh`; at most 10 s, stdin from `/dev/null`) and takes that environment as its own, so commands see
the PATH an SSH login gives. Without a result it keeps its own environment and logs why. It does this whether or not a
service started it.

## Deviations from the v1 spec

- `install --service-name NAME` is an addition: tests need a label of their own, and it allows several agents per user.
  `agent.json` records the service (`service: {kind, name}`) so `status` and `uninstall` find it.
- Forward URLs have no trailing slash (p2's own forward views add one).
- `forwards` items always carry `public` (a boolean); `url` and `publicUrl` are absent while the machine's origin is
  unknown.
- The login environment is captured on every POSIX start of `agent`, not only under a service.

## Development

`npm run build:daemon` builds `daemon/target/debug/pi-env`. The agent tests use a fake Radius
(`test/fixtures/agent-relay.ts`: the OAuth endpoints, the host protocol v5 with channel sockets and HTTP credit) and run
pi-env sessions through it with `Connection` and a small bridge (`test/fixtures/agent-bridge.ts`):

```sh
npx vitest --run test/agent.test.ts
PI_ENV_TEST_LAUNCHD=1 npx vitest --run test/agent-launchd.test.ts   # macOS: loads and removes a real LaunchAgent
```

The LaunchAgent test is opt-in because it registers a job in the user's launchd domain (macOS announces it as a new
background item). The agent tests are skipped on Windows. Cross-checking other targets from macOS needs a C compiler
for ring, for example `zig cc -target <triple>` as `CC_<target>`.
