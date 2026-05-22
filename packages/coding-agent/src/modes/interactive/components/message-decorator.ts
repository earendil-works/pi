import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { ExtensionRunner } from "../../../core/extensions/runner.ts";
import type {
	MessageDecorationSubject,
	MessageDecoratorContext,
	MessageViewOptions,
} from "../../../core/extensions/types.ts";
import { type Theme, theme } from "../theme/theme.ts";

type DefaultMessageRenderer = (message: AgentMessage) => Component[];
type ComponentWithChildren = Component & { children: Component[] };
type ComponentWithAddChild = Component & { addChild(component: Component): void };

function hasChildArray(component: Component): component is ComponentWithChildren {
	return Array.isArray((component as { children?: unknown }).children);
}

function hasAddChild(component: Component): component is ComponentWithAddChild {
	return typeof (component as { addChild?: unknown }).addChild === "function";
}

function insertChild(parent: Component, child: Component, index: number): boolean {
	if (!hasChildArray(parent)) return false;
	const safeIndex = Math.max(0, Math.min(index, parent.children.length));
	parent.children.splice(safeIndex, 0, child);
	return true;
}

function appendChild(parent: Component, child: Component): boolean {
	if (hasAddChild(parent)) {
		parent.addChild(child);
		return true;
	}

	if (hasChildArray(parent)) {
		parent.children.push(child);
		return true;
	}

	return false;
}

function findDescendant<T extends Component>(
	root: Component | Component[],
	predicate: (component: Component) => component is T,
): T | undefined {
	const roots = Array.isArray(root) ? root : [root];
	const stack = [...roots].reverse();

	while (stack.length > 0) {
		const component = stack.pop();
		if (!component) continue;
		if (predicate(component)) return component;
		if (hasChildArray(component)) {
			for (let i = component.children.length - 1; i >= 0; i--) {
				stack.push(component.children[i]);
			}
		}
	}

	return undefined;
}

class DecoratedRowBase extends Container {
	protected readonly extensionRunner: ExtensionRunner;
	protected readonly options: MessageViewOptions;
	protected readonly thm: Theme;

	constructor(extensionRunner: ExtensionRunner, options: MessageViewOptions, thm: Theme) {
		super();
		this.extensionRunner = extensionRunner;
		this.options = options;
		this.thm = thm;
	}

	protected emitRenderError(extensionPath: string, event: string, error: unknown): void {
		this.extensionRunner.emitError({
			extensionPath,
			event,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	protected createDecoratorContext(components: Component[]): MessageDecoratorContext {
		return {
			options: this.options,
			theme: this.thm,
			parent: this,
			components,
			insertChild,
			appendChild,
			findDescendant,
		};
	}

	protected runDecorators(subject: MessageDecorationSubject, components: Component[]): void {
		const context = this.createDecoratorContext(components);
		for (const decorator of this.extensionRunner.getMessageDecorators(subject)) {
			try {
				decorator.decorate(subject, context);
			} catch (error) {
				this.emitRenderError(decorator.extensionPath, `message_decorator:${decorator.name}`, error);
			}
		}
	}
}

/**
 * Generic chat row wrapper that lets extensions decorate non-message rows such as tool executions.
 */
export class DecoratedRowComponent extends DecoratedRowBase {
	private readonly subject: MessageDecorationSubject;
	private readonly components: Component[];

	constructor(
		subject: MessageDecorationSubject,
		extensionRunner: ExtensionRunner,
		components: Component[],
		options: MessageViewOptions,
		thm: Theme = theme,
	) {
		super(extensionRunner, options, thm);
		this.subject = subject;
		this.components = components;
		this.redecorate();
	}

	redecorate(): void {
		this.clear();
		for (const component of this.components) {
			this.addChild(component);
		}
		this.runDecorators(this.subject, this.components);
	}
}

/**
 * Message row wrapper that lets extensions decorate built-in message rendering
 * without replacing the primary rendered message content or mutating transcript data.
 */
export class DecoratedMessageComponent extends DecoratedRowBase {
	private message: AgentMessage;
	private readonly defaultRenderer: DefaultMessageRenderer;

	constructor(
		message: AgentMessage,
		extensionRunner: ExtensionRunner,
		defaultRenderer: DefaultMessageRenderer,
		options: MessageViewOptions,
		thm: Theme = theme,
	) {
		super(extensionRunner, options, thm);
		this.message = message;
		this.defaultRenderer = defaultRenderer;
		this.rebuild();
	}

	updateMessage(message: AgentMessage, options?: Partial<MessageViewOptions>): void {
		this.message = message;
		Object.assign(this.options, options);
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.updateMessage(this.message, { expanded });
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const components = this.defaultRenderer(this.message);
		for (const component of components) {
			this.addChild(component);
		}
		this.runDecorators({ type: "message", message: this.message }, components);
	}
}
