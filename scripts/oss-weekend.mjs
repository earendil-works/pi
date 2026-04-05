import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";

const TIME_ZONE = "Europe/Berlin";
const DEFAULT_README_PATHS = ["README.md", "packages/coding-agent/README.md"];
const DEFAULT_STATE_PATH = ".github/oss-weekend.json";
const MARKER_START = "<!-- OSS_WEEKEND_START -->";
const MARKER_END = "<!-- OSS_WEEKEND_END -->";
const DISCORD_URL = "https://discord.com/invite/3cU7Bz4UPx";

function normalizeReason(reason) {
  const trimmedReason = reason.trim();
  return trimmedReason ? trimmedReason : null;
}

function parseArgs(argv) {
  const options = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;

    const trimmedArg = arg.slice(2);
    const separatorIndex = trimmedArg.indexOf("=");

    if (separatorIndex === -1) {
      options[trimmedArg] = "true";
      continue;
    }

    const key = trimmedArg.slice(0, separatorIndex);
    const value = trimmedArg.slice(separatorIndex + 1);
    options[key] = value;
  }

  return options;
}

function getOption(name, cliOptions, envName, fallback) {
  const cliValue = cliOptions[name];
  if (cliValue !== undefined) return cliValue;

  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") return envValue;

  return fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid end date: ${value}. Use YYYY-MM-DD.`);
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
}

function buildBanner(now, endDate, reason) {
  const startDate = formatLongDate(now);
  const reopenDate = formatLongDate(endDate);
  const normalizedReason = normalizeReason(reason ?? "");

  return [
    MARKER_START,
    "# 🏖️ OSS Weekend",
    "",
    `**Issue tracker reopens ${reopenDate}.**`,
    "",
    `OSS weekend runs ${startDate} through ${reopenDate}. New issues and PRs from unapproved contributors are auto-closed during this time. Approved contributors can still open issues and PRs if something is genuinely urgent, but please keep that to pressing matters only. For support, join [Discord](${DISCORD_URL}).`,
    ...(normalizedReason ? ["", `> _Current focus: ${normalizedReason}_`] : []),
    MARKER_END,
    "",
    "---",
    "",
    "",
  ].join("\n");
}

function upsertBanner(readme, now, endDate, reason) {
  const banner = buildBanner(now, endDate, reason);
  const bannerPattern = new RegExp(
    `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n\\n---\\n\\n?`,
    "m",
  );

  if (bannerPattern.test(readme)) {
    return readme.replace(bannerPattern, banner);
  }

  return `${banner}${readme}`;
}

function removeBanner(readme) {
  const bannerPattern = new RegExp(
    `^${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n\\n---\\n\\n?`,
    "m",
  );

  return readme.replace(bannerPattern, "");
}

function parseReadmePaths(cliOptions) {
  const readmeOption = getOption("readme", cliOptions, "OSS_WEEKEND_README_PATH", "");
  if (!readmeOption) return DEFAULT_README_PATHS;

  return readmeOption
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

function buildState(now, endDateInput, endDate, reason) {
  const normalizedReason = normalizeReason(reason ?? "");

  return JSON.stringify(
    {
      active: true,
      mode: "weekend",
      startsAt: now.toISOString(),
      startsAtText: formatLongDate(now),
      reopensOn: endDateInput,
      reopensOnText: formatLongDate(endDate),
      reason: normalizedReason,
      discordUrl: DISCORD_URL,
    },
    null,
    2,
  );
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

function quoteArg(arg) {
  return /[^A-Za-z0-9_./:=@-]/.test(arg) ? JSON.stringify(arg) : arg;
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

function hasStagedChanges(paths) {
  try {
    runCommand("git", ["diff", "--cached", "--quiet", "--", ...paths], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function runGitOperations(mode, paths, dryRun) {
  const commitMessage = mode === "close" ? "docs: enable OSS weekend" : "docs: disable OSS weekend";
  const addArgs = ["add", "--", ...paths];
  const pushArgs = ["push"];
  const commands = [formatCommand("git", addArgs)];

  if (dryRun) {
    commands.push(`git commit -m ${quoteArg(commitMessage)}`);
    commands.push(formatCommand("git", pushArgs));
    return {
      commitMessage,
      commands,
      committed: false,
      pushed: false,
      stagedChanges: false,
    };
  }

  runCommand("git", addArgs, { stdio: "inherit" });

  if (!hasStagedChanges(paths)) {
    return {
      commitMessage,
      commands,
      committed: false,
      pushed: false,
      stagedChanges: false,
    };
  }

  const commitArgs = ["commit", "-m", commitMessage];
  commands.push(formatCommand("git", commitArgs));
  runCommand("git", commitArgs, { stdio: "inherit" });

  commands.push(formatCommand("git", pushArgs));
  runCommand("git", pushArgs, { stdio: "inherit" });

  return {
    commitMessage,
    commands,
    committed: true,
    pushed: true,
    stagedChanges: true,
  };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/oss-weekend.mjs --mode=close --end-date=2026-03-23",
      "  node scripts/oss-weekend.mjs --mode=close --end-date=2026-03-23 --git",
      "  node scripts/oss-weekend.mjs --mode=open",
      "  node scripts/oss-weekend.mjs --mode=open --git",
      "",
      "Options:",
      "  --mode=close|open     Required. close enables OSS weekend mode. open disables it.",
      "  --end-date=YYYY-MM-DD Required for --mode=close.",
      "  --readme=PATHS        Optional comma-separated README paths. Defaults to README.md,packages/coding-agent/README.md.",
      "  --state=PATH          Optional state file path. Defaults to .github/oss-weekend.json.",
      "  --reason=TEXT         Optional reason shown in the README banner and weekend auto-close comments.",
      "  --git                 Stage only the OSS weekend files, commit, and push after updating them.",
      "  --dry-run             Preview without editing files or running git operations.",
      "  --now=ISO             Optional current timestamp override for testing.",
      "  --help                Show this message.",
      "",
    ].join("\n"),
  );
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));

  if (isTruthy(cliOptions.help ?? "false")) {
    printUsage();
    return;
  }

  const mode = getOption("mode", cliOptions, "OSS_WEEKEND_MODE", "");
  if (mode !== "close" && mode !== "open") {
    throw new Error("--mode must be close or open.");
  }

  const dryRun = isTruthy(getOption("dry-run", cliOptions, "OSS_WEEKEND_DRY_RUN", "false"));
  const runGit = isTruthy(getOption("git", cliOptions, "OSS_WEEKEND_GIT", "false"));
  const nowInput = getOption("now", cliOptions, "OSS_WEEKEND_NOW", "");
  const readmePaths = parseReadmePaths(cliOptions);
  const statePath = getOption("state", cliOptions, "OSS_WEEKEND_STATE_PATH", DEFAULT_STATE_PATH);
  const endDateInput = getOption("end-date", cliOptions, "OSS_WEEKEND_END_DATE", "");
  const reason = normalizeReason(getOption("reason", cliOptions, "OSS_WEEKEND_REASON", ""));

  const now = nowInput ? new Date(nowInput) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid date: ${nowInput}`);
  }

  if (mode === "close" && !endDateInput) {
    throw new Error("--end-date is required when --mode=close.");
  }

  const endDate = mode === "close" ? parseDateInput(endDateInput) : null;
  const readmeResults = [];

  for (const readmePath of readmePaths) {
    const currentReadme = await readFile(readmePath, "utf8");
    const nextReadme = mode === "close" ? upsertBanner(currentReadme, now, endDate, reason) : removeBanner(currentReadme);
    const changed = nextReadme !== currentReadme;

    if (changed && !dryRun) {
      await writeFile(readmePath, nextReadme, "utf8");
    }

    readmeResults.push({ path: readmePath, changed });
  }

  const currentState = await readOptionalFile(statePath);
  const nextState = mode === "close" ? buildState(now, endDateInput, endDate, reason) : null;
  const stateChanged = mode === "close" ? currentState !== nextState : currentState !== null;

  if (!dryRun) {
    if (mode === "close") {
      await writeFile(statePath, `${nextState}\n`, "utf8");
    } else {
      await rm(statePath, { force: true });
    }
  }

  const gitPaths = [...readmePaths, statePath];
  const gitResult = runGit ? runGitOperations(mode, gitPaths, dryRun) : null;

  const output = {
    mode,
    dry_run: dryRun ? "true" : "false",
    weekend_active: mode === "close" ? "true" : "false",
    readme_paths: readmeResults.map((result) => result.path).join(","),
    readme_changed: readmeResults.some((result) => result.changed) ? "true" : "false",
    readme_changed_paths: readmeResults
      .filter((result) => result.changed)
      .map((result) => result.path)
      .join(","),
    state_path: statePath,
    state_changed: stateChanged ? "true" : "false",
    git_enabled: runGit ? "true" : "false",
    git_paths: gitPaths.join(","),
    git_commit_message: gitResult?.commitMessage ?? "",
    git_committed: gitResult?.committed ? "true" : "false",
    git_pushed: gitResult?.pushed ? "true" : "false",
    git_commands: gitResult ? gitResult.commands.join(" && ") : "",
    end_date: endDate ? endDateInput : "",
    end_date_text: endDate ? formatLongDate(endDate) : "",
    reason: reason ?? "",
    now_utc: now.toISOString(),
    now_berlin: new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(now),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  printUsage();
  process.exit(1);
});
