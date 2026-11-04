// Vendored from NeuroLift-Technologies/asfdk-harness src/policy.ts @ f28136d1cece7f5dd20734020346075efc2f6d9d
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
export interface ToolPolicyDecision {
  allow: boolean;
  reason?: string;
  severity: "allow" | "advise" | "block";
}

const DESTRUCTIVE_SHELL_PATTERNS = [
  /\brm\s+-rf\s+(?:\/|~|\$HOME|\*)/i,
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_ed25519$/i,
  /(^|\/)credentials(?:\.|$)/i,
  /(^|\/)secrets?(?:\.|\/|$)/i,
];

export function reviewToolCall(toolName: string, input: Record<string, unknown>): ToolPolicyDecision {
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const matched = DESTRUCTIVE_SHELL_PATTERNS.find((pattern) => pattern.test(command));
    if (matched) {
      return {
        allow: false,
        severity: "block",
        reason: `ASFDK harness blocked high-risk shell command pattern: ${matched}`,
      };
    }
    // Close the shell bypass of the sensitive-path gate: a bash command can otherwise read or
    // copy (cat/cp/grep/scp/…) a file the read/write/edit gate blocks. Bash strips quotes and
    // escapes before execution (so `cat .e""nv`, `cat '.env'`, and `cat .e\nv` all read `.env`),
    // so normalize those away first, then tokenize and apply SENSITIVE_PATH_PATTERNS to each token.
    const normalized = command.replace(/['"`]/g, "").replace(/\\/g, "");
    const tokens = normalized.split(/[\s;|&><()=]+/).filter(Boolean);
    for (const token of tokens) {
      const sensitive = SENSITIVE_PATH_PATTERNS.find((pattern) => pattern.test(token));
      if (sensitive) {
        return {
          allow: false,
          severity: "block",
          reason: `ASFDK harness blocked shell access to sensitive path: ${token}`,
        };
      }
    }
  }

  if (["read", "write", "edit"].includes(toolName)) {
    const path = String(input.path ?? "");
    const matched = SENSITIVE_PATH_PATTERNS.find((pattern) => pattern.test(path));
    if (matched) {
      return {
        allow: false,
        severity: "block",
        reason: `ASFDK harness blocked access to sensitive path pattern: ${matched}`,
      };
    }
  }

  return { allow: true, severity: "allow" };
}

export function formatPolicyContext(assessment: unknown): string {
  return JSON.stringify(assessment);
}
