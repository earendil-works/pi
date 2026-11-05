# Remote environments

`plugins/envs` manages SSH environments and sandboxes (Gondolin VMs on an SSH environment, see Sandboxes). Tools and workspace files live on the remote host; the worker,
Durable history, provider credentials and model calls stay on this device. Remote sessions never fall back
to local execution when configuration, trust or a connection is unavailable.

## Add and use one

1. Sidebar → **Envs** → **Add environment**. Give it a lowercase name (e.g. `gpu`), an SSH host or
   `~/.ssh/config` alias, and optional user, port, identity file, shell, login-shell setting and `KEY=value` overrides.
2. **Upload private key** is available to every owner, locally or remotely (associated cookie-authenticated device or Radius),
   never guests; so is **Generate key**. Both store a passphrase-less key in the server's private data
   directory. Add its public key to the host's `~/.ssh/authorized_keys`. Existing identity files/agent keys work;
   passwords do not. Private keys are never returned to the browser. Uploads pass through your tunnel/relay, so use
   a trusted transport.
3. **Save and test** reports platform, architecture, daemon version, home, round-trip time, watch mode and warnings.
   Before **Trust this key**, compare the shown fingerprint with one obtained independently from the host.
   Changed keys are refused; **Forget old key** is only for a change you understand.
4. New session → **Browse directories** → select `gpu`, browse/type a path and **Use**. Folder and environment
   choices are navigation steps. Recent directories are scoped to the selected machine.

Session groups and the top bar display `gpu:/path`. The catalog stores the raw cwd and a separate `env` field.
Every conversation works at a location `{ env, cwd }`: the main conversation at the session's; a subagent spawned
without a cwd follows it; a subagent spawned with a cwd keeps its own, on the environment of the conversation that
spawned it (its sidebar row, bar, workspace header and terminal tabs show `env:/path`). Deleting an environment is
refused while any session or subagent location, including archived ones, references it. Editing a valid
configuration stops the idle workers using it; busy workers finish on their captured environment and stop when idle.
Opening the session again loads the new revision without replaying a prompt.

Moving a session to another machine (Relocate, `/cd gpu:/path`) needs no worker restart when it is idle: the worker
opens the new machine's environment (reading `envs.json` then), moves the main conversation and the subagents following
it, reloads prompt resources and workspace watches there, and closes the old connection unless a subagent with its
own location still works on that machine. Open chats stay connected. Subagents spawned with their own cwd stay
where they are, on their machine, and keep running their tools there. Terminals already running stay on the machine
they were started on; new ones open where the viewed conversation works.

## Sandboxes

A sandbox is a Gondolin VM (earendil-works/gondolin: QEMU with KVM, host-side network policy) on an SSH environment,
its host. In the Envs sheet it is listed under its host, and the host's **Save and test** reports whether it can run
sandboxes: natively (Linux, `/dev/kvm` usable, Node >= 22, QEMU >= 7.2), through Docker (Linux, `/dev/kvm`, a usable
`docker`; e.g. Ubuntu 22.04, whose QEMU 6.2 is too old), or not, with the reason. Only the owner creates, edits,
starts, stops and deletes sandboxes, in the Envs sheet; plugins pick an existing one (env listings carry `type`).

```json
"box1": {
  "type": "gondolin",
  "host": "slayer",
  "image": "alpine-base:latest",
  "mounts": [{ "host": "~/sbx/box1", "guest": "/workspace" }, { "host": "~/datasets", "guest": "/data", "readonly": true }],
  "allowHosts": ["registry.npmjs.org", "*.github.com"],
  "cpus": 2,
  "memoryMb": 2048
}
```

- **What the VM sees:** its own root file system (lost when the VM restarts) and the listed host folders; nothing else
  of the host. In Docker mode folders must be inside the host user's home (only the home is shared with the container).
  A writable folder must not contain or be inside `~/.pi` (p2's launcher and daemons run from there on the host).
  `/opt/pi-env` (the daemon) and `/.p2-vfs` (Gondolin's own mount point) are reserved in the VM.
- **Network:** HTTP(S) to `allowHosts` only (Gondolin's patterns: `*` alone is any host, `*` inside a pattern any
  substring); everything else is refused with 403 before the host resolves the name, so names do not leak to DNS. An
  empty or missing list allows no host. Allowed names that resolve to private addresses are refused too. Other
  protocols are not routed.
- **Lifecycle:** one long-lived VM per sandbox, shared by every session working in it. It starts at the first
  connection (or **Start**, **Save and start**, **Test**) and runs until **Stop**, deleting the sandbox or moving it to
  another host (both stop it first), the VM dying (the supervisor notices within seconds; the next connection starts
  a new one) or a host reboot. Other configuration changes apply at its next start: the sheet says so while the
  running VM is older, and offers **Save and restart**.
- **Connection:** the worker connects to the host over SSH as for the host itself, deploys pi-env's daemon there
  (the same Linux binary runs in the VM) and p2's launcher (`plugins/envs/sandbox/`, under the host's
  `~/.pi/p2/sandbox/<content hash>/`, checked by hash at every deployment; versions of other p2 installations stay
  until unused for 30 days). It runs `p2-sandbox.sh start` (which may take minutes the first time: Docker image,
  `npm ci` from the shipped lockfile, guest image download, boot) and then `p2-sandbox.sh daemon <key> <config>
  <daemon> -- serve --token …`. The launcher picks native or Docker (image `p2-sandbox:<Dockerfile hash>` with Node and
  QEMU only, container `p2-sandbox-<uid>-<Dockerfile hash>` with the home mounted at the same path and `/dev/kvm`
  passed in), starts the sandbox's supervisor if needed (`p2-sandbox.mjs serve`, one process holding the VM; socket
  and log under `~/.pi/p2/sandbox/run/<key>/`, `<key>` being the sandbox's name prefixed by a hash of this p2
  installation's machine and data directory), copies the daemon into the VM and passes its stdin and stdout through.
  Tools, the workspace, terminals, uploads and `send_file` then work as on any remote environment. Hosts must be
  Linux. Connections to a sandbox are keyed by its configuration and its host's: editing either opens new ones.
- **Confinement:** a conversation whose environment is a sandbox cannot leave it. `location_envs` shows only the
  sandbox; `location_dirs` and `location_move` take paths inside it; `subagent` spawn/configure place subagents only
  in it; one-shot agents (`tools.agent`) inherit their caller's location (the `p2.inherited-location` document), so a
  subagent's sandbox holds for the agents its scripts start. `AgentLocations.move` refuses to move a sandboxed session
  out too, and `subagent` configure keeps a subagent working in a sandbox there whoever configures it. Only the
  owner's Relocate moves a session out (the web UI asks first, also for a move to another sandbox). Confinement is decided per
  conversation from its current location and the environment's configured `type`, never its name:
  `conversationConfinement(harness.environments, id, ctx)` (`@p2/app/v1/worker`), backed by
  `HarnessEnvironmentEntry.sandbox`. The `terminal` tool lists and drives only the session's terminals in the
  caller's sandbox. Tools that run on the p2 machine or reach unconfined places (MCP, ports, conversations, …) are a
  session tool policy's job, not the location's.

## Data and execution

`<P2_DATA_DIR>/envs.json` is independently observed by the server and workers. Invalid edits keep the last valid
observed state and expose `Envs.failure`. Management writes are locked. Example:

```json
{
  "gpu": {
    "type": "ssh",
    "host": "gpu-box",
    "user": "me",
    "port": 22,
    "identityFile": "~/.ssh/id_ed25519",
    "loginShell": false,
    "shellEnv": { "LANG": "en_US.UTF-8" }
  }
}
```

Trusted keys use `<data>/ssh/known_hosts` and alias `pi-env-<name>`. Managed keys use `<data>/ssh/keys/<name>`;
keep this directory private. Upload requires a server-assigned owner principal, not a client hostname or display
name. Generation and fetching an existing public key are owner-only too (every owner, as in Pi Mobile); never guests.

The env worker contributes a lazy machine per environment through `HarnessEnvironments` (one connection, a
`RemoteExecutionEnv` per directory), shared by every conversation of the worker working there; the native Harness
does not select a local default for a remote location. Connection failures belong to the operation that needed the host;
a later operation retries. SSH bootstrap/deployment and host-key handling use the workspace `pi-env` package,
which verifies its content-addressed daemon before each start. The package currently deploys daemons under the
remote `~/.pi/mobile/tools/`; this fixed package path is not an import from apps/mobile.

Attachments are copied to remote `~/.pi/p2/uploads/<session>/` on the machine of the receiving conversation before
prompt admission. The message lists remote paths; inline images still read the private local upload copy.
`send_file`, workspace reads/uploads and coding tools use the conversation's environment. Global `<data>/AGENTS.md`
remains local; project instructions are read from the conversation's cwd ancestors, and skills from its machine's
`~/.pi/p2/skills/` and `<cwd>/.pi/skills/`. Prompt watches run through
the same environment; remote prompt loading is background work so an offline host does not block worker startup.

The terminals plugin opens a terminal at the viewed conversation's location (the server reads it from the catalog
and its subagent list) with the same SSH configuration/known-hosts file. The former
`terminal-sessions.json` mapping is no longer read. Detached terminals still outlive server/worker restarts;
Windows PTYs remain unsupported.

Read/write remote sharing requires explicit confirmation in the UI and `remoteConfirmed: true` at link creation
or reset, whenever the session or one of its subagents works on a remote environment. Guests with send access can
run commands on those hosts. Sharing is not filesystem isolation.

## Tests

From `apps/p2`: `npm run check`; `npm test`; focused:
`node --import ./src/source.ts --test test/p2/envs.test.ts` and `test/p2/sandboxes.test.ts` (configuration,
launcher arguments, confinement; with `P2_TEST_GONDOLIN=1` also a real VM through the launcher and a session in a
sandbox over a loopback sshd, which need `/dev/kvm`, QEMU >= 7.2 or Docker, sshd and pi-env's packaged Linux daemon).

The tests use fake providers, temporary data/workspaces and server port 0. A disposable loopback sshd has its own
host key, authorized client key and remote HOME. The SSH case skips if sshd or a local pi-env daemon build is absent;
it never contacts a real host. Coverage includes validation, observation/last-valid state, permissions, owner-only
key generation, owner-only remote uploads (`remote-env-keys.test.ts`), lazy construction/no local fallback,
fingerprints, key storage, local/remote directories, remote tools,
workspace, uploads, prompt resources, downloads, terminal environment selection, busy-edit/idle restart and shares.
