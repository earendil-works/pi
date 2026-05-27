import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSatelliteConfig, validateConfig } from "./config.ts";
import { TunnelManager } from "./tunnel.ts";
import { createRemoteTool } from "./remote-tool.ts";
import { createCommands } from "./commands.ts";

let tunnelManager: TunnelManager | null = null;

export default function satelliteExtension(pi: ExtensionAPI): void {
  // 1. Load config
  let config;
  try {
    config = loadSatelliteConfig();
  } catch (err) {
    console.error(`[Satellite] ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const error = validateConfig(config);
  if (error) {
    console.error(`[Satellite] Config error: ${error}`);
    return;
  }

  // 2. Create TunnelManager
  tunnelManager = new TunnelManager(config);

  // 3. Register remote tool
  pi.registerTool(createRemoteTool(() => tunnelManager));

  // 4. Register commands
  const commands = createCommands(() => tunnelManager);
  pi.registerCommand("connect", commands.connect);
  pi.registerCommand("disconnect", commands.disconnect);
  pi.registerCommand("satellite", commands.satellite);

  // 5. Cleanup on session shutdown
  pi.on("session_shutdown", async () => {
    if (tunnelManager) {
      tunnelManager.disconnect();
      tunnelManager = null;
    }
  });

  console.log(`[Satellite] Extension loaded → ${config.ssh_user}@${config.ssh_host}`);
}

export function getTunnelManager(): TunnelManager | null {
  return tunnelManager;
}
