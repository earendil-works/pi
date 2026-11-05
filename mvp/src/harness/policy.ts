// Vendored from NeuroLift-Technologies/asfdk-harness src/policy.ts @ 5488262c96d97026b27703d6580da65c2bcb1fb6
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

/**
 * `rm` hardening. DESTRUCTIVE_SHELL_PATTERNS only matches the literal order `rm -rf <target>`. This also
 * catches reordered or split flags (`rm -fr`, `rm -r -f`), long options (`--recursive`), an end-of-options
 * `--` before the target, recursion without `-f`, and every operand (not just the first). A target is
 * dangerous if it is root-ish (`/...`), the home directory (`~`, `$HOME`, `${HOME}`), or a bare glob (`*`).
 * Scoped relative deletes such as `rm -rf ./build` and `rm -rf node_modules` remain allowed.
 */
const DANGEROUS_RM_TARGET = /^(?:\/|~|\$HOME|\$\{HOME\}|\*)/;

function isDestructiveRm(command: string): boolean {
  for (const segment of command.split(/[;&|\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const rmIndex = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
    if (rmIndex === -1) continue;
    let recursive = false;
    let endOfOptions = false;
    const operands: string[] = [];
    for (const word of words.slice(rmIndex + 1)) {
      if (!endOfOptions && word === "--") {
        endOfOptions = true;
      } else if (!endOfOptions && word.startsWith("--")) {
        if (word === "--recursive") recursive = true;
      } else if (!endOfOptions && word.startsWith("-") && word.length > 1) {
        if (/[rR]/.test(word)) recursive = true;
      } else {
        operands.push(word);
      }
    }
    if (recursive && operands.some((operand) => DANGEROUS_RM_TARGET.test(operand.replace(/^["']|["']$/g, "")))) {
      return true;
    }
  }
  return false;
}

/**
 * Shell globs can name a sensitive file without spelling it (`cat .en?`, `cat .e*`). Names the
 * sensitive-path patterns protect, used only to test whether a glob could expand to one of them.
 */
const SENSITIVE_NAME_CANDIDATES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secret",
  "secrets",
  "secrets.json",
];

/** Minimum literal characters before the first wildcard. Keeps broad globs such as `*`, `*.json`, `.*` allowed. */
const MIN_GLOB_LITERAL_PREFIX = 2;

function globToRegExp(glob: string): RegExp | undefined {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        source += "\\[";
      } else {
        const body = glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${body}]`;
        i = close;
      }
    } else {
      source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return undefined;
  }
}

function globCouldMatchSensitiveName(token: string): boolean {
  if (!/[*?[]/.test(token)) return false;
  const base = token.slice(token.lastIndexOf("/") + 1);
  const literalPrefix = base.search(/[*?[]/);
  if (literalPrefix < MIN_GLOB_LITERAL_PREFIX) return false;
  const matcher = globToRegExp(base);
  return matcher !== undefined && SENSITIVE_NAME_CANDIDATES.some((name) => matcher.test(name));
}

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
    if (isDestructiveRm(command)) {
      return {
        allow: false,
        severity: "block",
        reason: "ASFDK harness blocked recursive rm of a root, home, or glob target",
      };
    }
    // Close the shell bypass of the sensitive-path gate: a bash command can otherwise read or
    // copy (cat/cp/grep/scp/…) a file the read/write/edit gate blocks. Bash strips quotes and
    // escapes before execution (so `cat .e""nv`, `cat '.env'`, and `cat .e\nv` all read `.env`),
    // so normalize those away first, then tokenize and apply SENSITIVE_PATH_PATTERNS to each token.
    const normalized = command.replace(/['"`]/g, "").replace(/\\/g, "");
    const tokens = normalized.split(/[\s;|&><()=]+/).filter(Boolean);
    for (const token of tokens) {
      if (globCouldMatchSensitiveName(token)) {
        return {
          allow: false,
          severity: "block",
          reason: `ASFDK harness blocked shell glob that can match a sensitive path: ${token}`,
        };
      }
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
