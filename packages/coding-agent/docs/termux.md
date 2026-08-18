# Termux (Android) Setup

Pi runs on Android via [Termux](https://termux.dev/), a terminal emulator and Linux environment for Android.

## Prerequisites

1. Install [Termux](https://github.com/termux/termux-app#installation) from GitHub or F-Droid (not Google Play, that version is deprecated)
2. Install [Termux:API](https://github.com/termux/termux-api#installation) from GitHub or F-Droid for clipboard and other device integrations

## Installation

```bash
# Update packages
pkg update && pkg upgrade

# Install dependencies
pkg install nodejs termux-api git

# Install pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Create config directory
mkdir -p ~/.pi/agent

# Run pi
pi
```

## Clipboard Support

Clipboard operations use `termux-clipboard-set` and `termux-clipboard-get` when running in Termux. The Termux:API app must be installed for these to work.

Image clipboard is not supported on Termux (the `ctrl+v` image paste feature will not work).

## Example AGENTS.md for Termux

Create `~/.pi/agent/AGENTS.md` to help the agent understand the Termux environment:

````markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open --chooser image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
````

## Limitations

- **No image clipboard**: Termux clipboard API only supports text
- **No native binaries**: Some optional native dependencies (like the clipboard module) are unavailable on Android ARM64 and are skipped during installation
- **Storage access**: To access files in `/storage/emulated/0` (Downloads, etc.), run `termux-setup-storage` once to grant permissions

## Troubleshooting

### Clipboard not working

Ensure both apps are installed:
1. Termux (from GitHub or F-Droid)
2. Termux:API (from GitHub or F-Droid)

Then install the CLI tools:
```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permissions:
```bash
termux-setup-storage
```

### Node.js installation issues

If npm fails, try clearing the cache:
```bash
npm cache clean --force
```
