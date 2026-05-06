# @mariozechner/pi-web-app

A Next.js graphical interface for the pi coding-agent harness. It runs the same `AgentSessionRuntime` used by interactive, print, and RPC modes, then streams session events to a React UI built with local shadcn-style components and MagicUI-style visual primitives.

## Run locally

```bash
# From the monorepo root. The workspace dev script builds the pi deps first.
PI_WEB_CWD=/path/to/project npm run dev --workspace @mariozechner/pi-web-app
```

Open <http://localhost:3000>.

If `PI_WEB_CWD` is omitted, the app uses the process working directory. Set `PI_WEB_CONTINUE=0` to force a new session instead of continuing the most recent one for that cwd.

## Checks

```bash
npm run check --workspace @mariozechner/pi-web-app
npm run build --workspace @mariozechner/pi-web-app
```
