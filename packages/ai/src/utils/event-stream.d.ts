import type { AssistantMessage, AssistantMessageEvent } from "../types.js";
export declare class EventStream<T, R = T> implements AsyncIterable<T> {
    private isComplete;
    private extractResult;
    private queue;
    private waiting;
    private done;
    private finalResultPromise;
    private resolveFinalResult;
    constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R);
    push(event: T): void;
    end(result?: R): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
    result(): Promise<R>;
}
export declare class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
    constructor();
}
//# sourceMappingURL=event-stream.d.ts.map