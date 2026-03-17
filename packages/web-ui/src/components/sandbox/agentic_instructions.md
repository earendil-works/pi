# packages/web-ui/src/components/sandbox

## Purpose
Sandbox runtime providers for executing user-generated code artifacts in isolated iframes. Provides communication bridges between the host app and sandboxed code.

## Technology
TypeScript, Lit web components, postMessage API for iframe communication.

## Contents
- `ArtifactsRuntimeProvider.ts` - Provides artifact rendering capabilities to sandboxed code
- `AttachmentsRuntimeProvider.ts` - Provides file attachment access to sandboxed code
- `ConsoleRuntimeProvider.ts` - Captures and forwards console.log/error from sandbox to host
- `FileDownloadRuntimeProvider.ts` - Enables file download from sandboxed code
- `RuntimeMessageBridge.ts` - Message bridge for bidirectional host-sandbox communication
- `RuntimeMessageRouter.ts` - Routes messages between multiple runtime providers
- `SandboxRuntimeProvider.ts` - Base interface for sandbox runtime providers

## Key Functions
- `RuntimeMessageBridge.send(type, data)`: Send message to sandbox
- `RuntimeMessageBridge.on(type, handler)`: Listen for sandbox messages
- `RUNTIME_MESSAGE_ROUTER.register(provider)`: Register a runtime provider

## Data Types
- `SandboxRuntimeProvider`: `{ name, setup(bridge), teardown() }`
- `ConsoleLog`: `{ type: "log"|"error"|"warn", args: any[] }`
- `DownloadableFile`: `{ name, content, mimeType }`

## Logging
Console output captured via `ConsoleRuntimeProvider`.

## CRUD Entry Points
- **Create**: Implement `SandboxRuntimeProvider` interface and register with router
- **Read**: Providers receive messages from sandbox via bridge
- **Update**: Modify provider implementations
- **Delete**: Unregister provider from router

## Style Guide
- Interface-first design with `SandboxRuntimeProvider` contract
- PostMessage API for cross-origin iframe communication
- Provider pattern for extensible sandbox capabilities
