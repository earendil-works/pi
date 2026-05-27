/**
 * Tests for satellite extension entry point
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import satelliteExtension from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("./config.ts", () => ({
  loadSatelliteConfig: vi.fn(),
  validateConfig: vi.fn(),
}));

vi.mock("./tunnel.ts", () => ({
  TunnelManager: vi.fn().mockImplementation(() => ({
    disconnect: vi.fn(),
    connect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({ connected: false, host: "test.host", port: 9000, uptime: null }),
  })),
}));

vi.mock("./remote-tool.ts", () => ({
  createRemoteTool: vi.fn().mockReturnValue({
    name: "remote",
    label: "Remote",
    description: "remote tool",
    parameters: {},
    execute: vi.fn(),
  }),
}));

vi.mock("./commands.ts", () => ({
  createCommands: vi.fn().mockReturnValue({
    connect: { name: "connect", description: "Connect", handler: vi.fn() },
    disconnect: { name: "disconnect", description: "Disconnect", handler: vi.fn() },
    satellite: { name: "satellite", description: "Status", handler: vi.fn() },
  }),
}));

import { loadSatelliteConfig, validateConfig } from "./config.ts";
import { TunnelManager } from "./tunnel.ts";
import { createRemoteTool } from "./remote-tool.ts";
import { createCommands } from "./commands.ts";

// ============================================================================
// Helpers
// ============================================================================

function createMockPi(): ExtensionAPI {
  const eventHandlers = new Map<string, Function>();
  const registeredTools: unknown[] = [];
  const registeredCommands = new Map<string, unknown>();

  return {
    on: vi.fn((event: string, handler: Function) => {
      eventHandlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: unknown) => {
      registeredTools.push(tool);
    }),
    registerCommand: vi.fn((name: string, options: unknown) => {
      registeredCommands.set(name, options);
    }),
    // Expose for assertions
    _eventHandlers: eventHandlers,
    _registeredTools: registeredTools,
    _registeredCommands: registeredCommands,
  } as unknown as ExtensionAPI;
}

// ============================================================================
// Tests
// ============================================================================

describe("satelliteExtension", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("loads config and validates it", () => {
    const mockConfig = {
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "user",
      ssh_host: "host",
      log_level: "info" as const,
    };
    vi.mocked(loadSatelliteConfig).mockReturnValue(mockConfig);
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(loadSatelliteConfig).toHaveBeenCalledOnce();
    expect(validateConfig).toHaveBeenCalledWith(mockConfig);
  });

  it("returns early and logs error when config validation fails", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({} as any);
    vi.mocked(validateConfig).mockReturnValue("Missing required field: auth_token");

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[Satellite] Config error: Missing required field: auth_token"
    );
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });

  it("returns early and logs error when config loading throws", () => {
    vi.mocked(loadSatelliteConfig).mockImplementation(() => {
      throw new Error("Config file not found");
    });

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Satellite]")
    );
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("creates TunnelManager with loaded config", () => {
    const mockConfig = {
      remote_port: 8080,
      auth_token: "token",
      local_port: 7070,
      ssh_user: "alice",
      ssh_host: "remote.host",
      log_level: "debug" as const,
    };
    vi.mocked(loadSatelliteConfig).mockReturnValue(mockConfig);
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(TunnelManager).toHaveBeenCalledWith(mockConfig);
  });

  it("registers the remote tool", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "user",
      ssh_host: "host",
      log_level: "info" as const,
    });
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(createRemoteTool).toHaveBeenCalledOnce();
    expect(pi.registerTool).toHaveBeenCalledOnce();
  });

  it("registers connect, disconnect, and satellite commands", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "user",
      ssh_host: "host",
      log_level: "info" as const,
    });
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(createCommands).toHaveBeenCalledOnce();
    expect(pi.registerCommand).toHaveBeenCalledTimes(3);
    expect(pi.registerCommand).toHaveBeenCalledWith("connect", expect.anything());
    expect(pi.registerCommand).toHaveBeenCalledWith("disconnect", expect.anything());
    expect(pi.registerCommand).toHaveBeenCalledWith("satellite", expect.anything());
  });

  it("registers session_shutdown handler", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "user",
      ssh_host: "host",
      log_level: "info" as const,
    });
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("logs success message with user@host", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "alice",
      ssh_host: "my.server.io",
      log_level: "info" as const,
    });
    vi.mocked(validateConfig).mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const pi = createMockPi();
    satelliteExtension(pi);

    expect(consoleSpy).toHaveBeenCalledWith(
      "[Satellite] Extension loaded → alice@my.server.io"
    );
    consoleSpy.mockRestore();
  });

  it("session_shutdown handler disconnects tunnelManager", () => {
    vi.mocked(loadSatelliteConfig).mockReturnValue({
      remote_port: 9000,
      auth_token: "token",
      local_port: 9000,
      ssh_user: "user",
      ssh_host: "host",
      log_level: "info" as const,
    });
    vi.mocked(validateConfig).mockReturnValue(null);

    const pi = createMockPi();
    satelliteExtension(pi);

    // Get the session_shutdown handler
    const shutdownHandler = vi.mocked(pi.on).mock.calls.find(
      (call) => call[0] === "session_shutdown"
    )?.[1] as Function;

    expect(shutdownHandler).toBeDefined();

    // Call the handler
    shutdownHandler();

    // TunnelManager was constructed, so disconnect should be called on its instance
    const tunnelInstance = vi.mocked(TunnelManager).mock.results[0]?.value;
    expect(tunnelInstance?.disconnect).toHaveBeenCalled();
  });

  it("is exported as default function", () => {
    expect(typeof satelliteExtension).toBe("function");
  });
});
