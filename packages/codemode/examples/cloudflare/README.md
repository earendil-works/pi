# pi-codemode on Cloudflare

This example has two Workers:

- **`sandbox/`** deploys `CodemodeSandboxDurableObject` as its own Worker, `pi-codemode-sandbox`.
  Scripts run there, in a separate isolate.
- **`agent/`** has a `Session` Durable Object that owns the tools. It runs scripts through
  `RemoteCodemodeSandbox`, which keeps the tools and results in `Session` while the sandbox Worker
  runs the VM.

The [README of the package](../../README.md#usage-on-cloudflare-workers) explains why the
sandbox must be a separate Worker, and which limits apply.

## Try it locally

Install `@earendil-works/pi-codemode` and `wrangler` in each directory, then start both Workers in
one process:

```sh
npx wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc
curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
```

## Deploy

Deploy the sandbox first, because the agent's binding refers to it by name:

```sh
(cd sandbox && npx wrangler deploy)
(cd agent && npx wrangler deploy)
```
