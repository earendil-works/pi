#!/usr/bin/env node
import "./sandbox-env-setup.ts";
// After the environment is restored, before runtime setup and pi load: --agent-dir overrides PI_CODING_AGENT_DIR.
import "../cli/agent-dir-setup.ts";
import "./runtime-setup.ts";
import "../cli.ts";
