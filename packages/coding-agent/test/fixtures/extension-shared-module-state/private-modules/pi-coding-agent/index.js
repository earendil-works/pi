export function keyText(id) {
	return `private:${id}`;
}

export async function withFileMutationQueue(_path, fn) {
	return fn();
}
