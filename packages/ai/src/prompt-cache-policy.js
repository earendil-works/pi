function sortToolsDeterministically(tools) {
    if (!tools)
        return undefined;
    return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}
function getProviderCacheKey(model, sessionId) {
    if (!sessionId)
        return undefined;
    if (model.api === "openai-codex-responses")
        return sessionId;
    return undefined;
}
export function planPromptCachePolicy(args) {
    return {
        context: {
            ...args.context,
            tools: sortToolsDeterministically(args.context.tools),
        },
        provider: {
            cacheKey: getProviderCacheKey(args.model, args.sessionId),
        },
    };
}
//# sourceMappingURL=prompt-cache-policy.js.map