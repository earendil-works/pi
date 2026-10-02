# MCP client conformance

Runs the official [MCP conformance suite](https://github.com/modelcontextprotocol/conformance) against pi's MCP client and compares the result with a committed baseline.

```bash
npm run test:mcp-conformance
```

CI runs it in the `mcp-conformance` job of `.github/workflows/ci.yml`. Requires network access the first time, to fetch the pinned suite (`@modelcontextprotocol/conformance@0.2.0-alpha.11`) with `npx`. Install scripts are disabled. Needs a POSIX shell.

## How it works

For every protocol version pi negotiates (`2025-03-26`, `2025-06-18`, `2025-11-25`), `run.ts` lists the suite's client scenarios and runs them one at a time. The suite starts a scenario server and runs `client.ts` against it.

`client.ts` uses the code pi runs for an HTTP server in `mcp.json`: `McpServerConnection` connects and calls tools, and `signInMcpServer` runs the OAuth sign-in that `/mcp` starts. A simulated browser fetches the authorization URL and delivers the redirect to pi's loopback callback server. When the server asks for sign-in again (for example for more scope), the simulated user signs in again, up to three times.

Every check the suite reports is compared with `baseline.json`. The extra `pi-client` check records whether `client.ts` completed the scenario. Some scenarios expect the client to give up (`auth/scope-retry-limit`), so it is baselined like the others.

The run fails when:

- a check that passes in the baseline fails or is missing,
- a check fails that the baseline does not list as failing,
- a baselined scenario did not run.

Checks that started passing are reported; update the baseline to lock them in.

## Options

```bash
node packages/coding-agent/test/mcp-conformance/run.ts --mode 2025-11-25 --scenario auth/scope-step-up --verbose
node packages/coding-agent/test/mcp-conformance/run.ts --update-baseline
```

- `--mode`, `--scenario`: run a subset (repeatable).
- `--verbose`: print the suite's output, including each check and the client's log.
- `--keep-results`: keep the suite's `checks.json` and client output.
- `--update-baseline`: write the results of a full run to `baseline.json`. Review the diff; do not regenerate it to hide a regression.

## Known failures

- `elicitation-sep1034-client-defaults`: pi does not support elicitation.
- `auth/basic-cimd`: pi registers clients dynamically instead of using a Client ID Metadata Document.
- `auth/scope-retry-limit`: `pi-client` fails by design; the server never accepts the granted scope.

2026-07-28 is not covered: it is a stateless protocol pi does not implement.
