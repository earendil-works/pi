import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// Restore the environment before evaluating modules that read it at startup.
restoreSandboxEnv();
