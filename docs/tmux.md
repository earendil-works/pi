# Run Pi in tmux

Pi works inside tmux, but tmux can report `Shift+Enter`, `Ctrl+Enter`, and plain `Enter` as the same key. Enable extended keys so Pi can distinguish them.

## Check your tmux version

```bash
tmux -V
```

For tmux 3.5 or newer, use the recommended CSI-u configuration below. For tmux 3.2 through 3.4, use the older-version configuration.

## Enable extended keys in tmux 3.5 or newer

Add these lines to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Pi requests extended-key reporting when the terminal does not provide the Kitty keyboard protocol directly. CSI-u is the most reliable format for forwarding modified keys through tmux.

## Restart tmux

The configuration applies to the tmux server. To guarantee that it is active, close your tmux sessions and start a new server.

If you choose to stop the server from the command line, save your work first. This command terminates every session managed by that server:

```bash
tmux kill-server
tmux
```

## Verify modified keys

Start Pi inside the new tmux session and check that:

1. `Shift+Enter` inserts a new line in the editor.
2. `Enter` submits the prompt.
3. `Alt+Enter` queues a follow-up on macOS and Linux. Windows and WSL use `Ctrl+Q` by default.

If these keys still behave like plain `Enter`, verify that the terminal outside tmux can report modified keys. See [Configure your terminal](terminal-setup.md).

## Use tmux 3.2 through 3.4

These versions support extended keys but not `extended-keys-format csi-u`. Add only:

```tmux
set -g extended-keys on
```

Pi supports the xterm `modifyOtherKeys` format used by these versions. Restart tmux and repeat the verification steps.

For older versions, upgrade tmux or use Pi outside tmux rather than relying on modified Enter shortcuts.
