/**
 * oh-pi Safe Guard Extension
 * 
 * Combines destructive command confirmation + protected paths in one extension.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force\b)/,
  /\bsudo\s+rm\b/,
  /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
];

export const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".pi/", "id_rsa", ".ssh/"];

export default function (pi: ExtensionAPI) {
  const allowedPatterns = new Set<string>();
  const allowedPaths = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    // Check bash commands for dangerous patterns
    if (event.toolName === "bash") {
      const cmd = (event.input as { command?: string }).command ?? "";
      const match = DANGEROUS_PATTERNS.find((p) => p.test(cmd));
      if (match && ctx.hasUI) {
        if (allowedPatterns.has(match.source)) return undefined;
        const choice = await ctx.ui.select(
          `⚠️  Dangerous Command\n\n  ${cmd}\n\nAllow?`,
          ["Yes", "Yes, remember for session", "No"]
        );
        if (choice === "Yes, remember for session") {
          allowedPatterns.add(match.source);
        } else if (choice !== "Yes") {
          return { block: true, reason: "Blocked by user" };
        }
      }
    }

    // Check write/edit for protected paths
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path ?? "";
      const hit = PROTECTED_PATHS.find((p) => path.includes(p));
      if (hit) {
        if (ctx.hasUI) {
          if (allowedPaths.has(hit)) return undefined;
          const choice = await ctx.ui.select(
            `🛡️  Protected Path\n\n  ${path}\n\nAllow write?`,
            ["Yes", "Yes, remember for session", "No"]
          );
          if (choice === "Yes, remember for session") {
            allowedPaths.add(hit);
          } else if (choice !== "Yes") {
            return { block: true, reason: `Protected path: ${hit}` };
          }
        } else {
          return { block: true, reason: `Protected path: ${hit}` };
        }
      }
    }
  });
}
