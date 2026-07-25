class TreapNode {
	left: TreapNode | undefined;
	right: TreapNode | undefined;
	count = 1;
	size = 1;
	readonly key: number;
	readonly priority: number;

	constructor(key: number, priority: number) {
		this.key = key;
		this.priority = priority;
	}
}

function sizeOf(node: TreapNode | undefined): number {
	return node?.size ?? 0;
}

function updateSize(node: TreapNode): TreapNode {
	node.size = node.count + sizeOf(node.left) + sizeOf(node.right);
	return node;
}

/** A strictly online multiset with expected logarithmic operations. */
export class OnlineMultiset {
	private root: TreapNode | undefined;
	private priorityState = 0x9e37_79b9;

	get size(): number {
		return sizeOf(this.root);
	}

	add(value: number): void {
		this.root = this.insert(this.root, value);
	}

	del(value: number): boolean {
		const result = this.remove(this.root, value);
		this.root = result.node;
		return result.removed;
	}

	median(): number | undefined {
		return this.kth(Math.floor((this.size + 1) / 2));
	}

	kth(rank: number): number | undefined {
		if (!Number.isInteger(rank) || rank < 1 || rank > this.size) return undefined;
		let node = this.root;
		let remaining = rank;
		while (node) {
			const leftSize = sizeOf(node.left);
			if (remaining <= leftSize) {
				node = node.left;
				continue;
			}
			if (remaining <= leftSize + node.count) return node.key;
			remaining -= leftSize + node.count;
			node = node.right;
		}
		return undefined;
	}

	private nextPriority(): number {
		this.priorityState = (this.priorityState * 1_664_525 + 1_013_904_223) >>> 0;
		return this.priorityState;
	}

	private insert(node: TreapNode | undefined, value: number): TreapNode {
		if (!node) return new TreapNode(value, this.nextPriority());
		if (value === node.key) {
			node.count++;
			return updateSize(node);
		}
		if (value < node.key) {
			node.left = this.insert(node.left, value);
			if (node.left.priority < node.priority) node = this.rotateRight(node);
		} else {
			node.right = this.insert(node.right, value);
			if (node.right.priority < node.priority) node = this.rotateLeft(node);
		}
		return updateSize(node);
	}

	private remove(node: TreapNode | undefined, value: number): { node: TreapNode | undefined; removed: boolean } {
		if (!node) return { node: undefined, removed: false };
		if (value < node.key) {
			const result = this.remove(node.left, value);
			node.left = result.node;
			return { node: updateSize(node), removed: result.removed };
		}
		if (value > node.key) {
			const result = this.remove(node.right, value);
			node.right = result.node;
			return { node: updateSize(node), removed: result.removed };
		}
		if (node.count > 1) {
			node.count--;
			return { node: updateSize(node), removed: true };
		}
		return { node: this.merge(node.left, node.right), removed: true };
	}

	private merge(left: TreapNode | undefined, right: TreapNode | undefined): TreapNode | undefined {
		if (!left) return right;
		if (!right) return left;
		if (left.priority < right.priority) {
			left.right = this.merge(left.right, right);
			return updateSize(left);
		}
		right.left = this.merge(left, right.left);
		return updateSize(right);
	}

	private rotateLeft(node: TreapNode): TreapNode {
		const right = node.right;
		if (!right) return node;
		node.right = right.left;
		right.left = updateSize(node);
		return updateSize(right);
	}

	private rotateRight(node: TreapNode): TreapNode {
		const left = node.left;
		if (!left) return node;
		node.left = left.right;
		left.right = updateSize(node);
		return updateSize(left);
	}
}
