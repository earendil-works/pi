const { spawnSync } = require("node:child_process");

const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;

const checks = [
  ["node", ["--version"]],
  ["npm", ["--version"]],
  ["fd", ["--version"]],
  ["git", ["--version"]],
  ["rg", ["--version"]],
  ["tar", ["--version"]],
  ["unzip", ["-v"]],
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, {
    env: childEnv,
    stdio: "ignore",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("runtime command is unavailable: " + command);
  }
}
