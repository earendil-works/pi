# Remote environments

`plugins/envs` manages SSH environments. Tools and workspace files live on the remote host; the worker,
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
`node --import ./src/source.ts --test test/p2/envs.test.ts`.

The tests use fake providers, temporary data/workspaces and server port 0. A disposable loopback sshd has its own
host key, authorized client key and remote HOME. The SSH case skips if sshd or a local pi-env daemon build is absent;
it never contacts a real host. Coverage includes validation, observation/last-valid state, permissions, owner-only
key generation, owner-only remote uploads (`remote-env-keys.test.ts`), lazy construction/no local fallback,
fingerprints, key storage, local/remote directories, remote tools,
workspace, uploads, prompt resources, downloads, terminal environment selection, busy-edit/idle restart and shares.
