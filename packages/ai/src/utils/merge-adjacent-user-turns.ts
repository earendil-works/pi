export interface UserTurnMergeOptions {
	mergeWithPrevious?: boolean;
	mergeNext?: boolean;
}

export function createUserTurnAppender<T extends { role?: string }, TPart>(
	messages: T[],
	getParts: (message: T) => TPart[],
): (message: T, options?: UserTurnMergeOptions) => void {
	let mergeNextUser = false;
	return (message, options = {}) => {
		const previous = messages[messages.length - 1];
		if (message.role === "user" && previous?.role === "user" && (options.mergeWithPrevious || mergeNextUser)) {
			getParts(previous).push(...getParts(message));
		} else {
			messages.push(message);
		}
		mergeNextUser = message.role === "user" && options.mergeNext === true;
	};
}
