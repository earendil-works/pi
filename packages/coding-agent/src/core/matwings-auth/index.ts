// MatwingsVenus authentication — pure Node, TUI-agnostic.
//
// The core (config/crypto/client/storage/session) has no dependency on pi-tui,
// so it can be reused as-is by the Phase-2 Electron GUI; only the login
// *screen* is a thin TUI adapter in src/modes/interactive.

export * from "./config.ts";
export * from "./crypto.ts";
export * from "./client.ts";
export * from "./storage.ts";
export * from "./session.ts";
