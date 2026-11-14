# Operation gates: a sketch

A policy can only limit what it knows. A gated call carries four things: who is calling, which operation, which
object, and the checked arguments. The plugin adds a fifth: facts. These are a few plain values computed from the
arguments, in a shared vocabulary, so a policy can decide without knowing the plugin.

## 1. The plugin: declares operations and their facts

```ts
// plugins/mcp/contract.ts
export const McpServers = remote("mcp.servers", {
	version: 1,
	params: {},
	variants: {
		user: {
			state: { servers: arr(ServerInfo) },
			methods: {
				create: method(obj({ config: McpConfig }), ResourceRef),
				remove: method(obj({ id: str() })),
			},
		},
	},
});

/** Creating a server. Facts: what a policy may key on without knowing MCP. Pure function of the checked args. */
export const CreateMcp = operation(McpServers, "create", {
	facts: ({ config }) => ({
		kind: "create",                                    // shared vocabulary: create | change | delete | use | read
		runsCode: config.transport.kind === "server-stdio" ? "server"
			: config.transport.kind === "checkout" ? "machine" : "none",
		reaches: config.transport.kind === "http" ? new URL(config.transport.url).host : null,
	}),
});
export const RemoveMcp = operation(McpServers, "remove", { facts: () => ({ kind: "delete" }) });
```

The plugin's handlers contain no checks. `create` just creates.

## 2. The platform: one gate in method dispatch

```ts
// in Chord's remote method dispatch (host serving a method call), before the handler runs
const op = operationOf(contract, method);                  // registered by operation(...); undefined: ungated
if (op !== undefined) {
	const decision = await gate.decide(
		{ principal, operation: op.name, object: { contract: contract.name, params }, args, facts: op.facts(args) },
		ctx,
	);
	if (decision.kind === "deny") throw forbidden(decision.reason);
}
return handler(args, ctx);
```

`gate` is a registry with one provider. Methods without an operation are ungated: reads and views are scoped by
their variant and params, as in p2 today.

## 3. The default policy (single user)

```ts
// plugins/policy-default/server.ts
contribute(host, Gate, {
	decide: ({ principal, facts }) =>
		principal.kind !== "user" ? deny("users only")
		: facts.runsCode === "server" && !isAdmin(principal) ? deny("runs code on the p3 machine")
		: allow(),
});
```

## 4. A company policy

```ts
// @acme/p3-policy/server.ts
contribute(host, Gate, {
	async decide({ principal, operation, facts, args }, ctx) {
		const groups = await directory.groupsOf(principal, ctx);
		// Generic: needs only the shared vocabulary.
		if (facts.kind === "create" && facts.runsCode !== "none" && !groups.includes("engineering"))
			return deny("only engineering adds servers that run code");
		if (facts.reaches !== null && !ALLOWED_HOSTS.includes(facts.reaches))
			return deny(`${facts.reaches} is not an approved service`);
		// Specific: imports the MCP plugin's published contract to read its typed arguments.
		if (isOperation(operation, CreateMcp) && args.config.lifetime === "shared" && !groups.includes("admins"))
			return deny("only admins add shared servers");
		return allow();
	},
});
```

## What this means

- Plugins never import the policy. They name their operations and describe them with facts.
- Generic rules use the shared fact vocabulary. Specific rules import the plugin's published contract, as any client
  of that plugin would. The dependency always points from policy to plugin, never back.
- A policy cannot limit what neither the arguments nor the facts express, for example what a stdio server will do
  once it runs. It limits the proxy instead: "runs code on the server".
- Single user: the default policy, one `if`, nearly free.
