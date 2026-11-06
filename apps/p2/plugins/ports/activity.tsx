// How the `ports` tool shows in the chat: what it did with which port, and an opened port's links after the turn's
// answer (only Radius forward addresses).
import {
	CodeBlock,
	detailsOf,
	failureOf,
	InputOutput,
	OutputBlock,
	type Step,
	stringOf,
	type ToolActivity,
	ToolIcon,
	type ToolView,
} from "@p2/app/v1/web";
import "./activity.css";

/** The addresses of a port a call opened: private, and public when it is public. Only Radius forward addresses. */
function forwardOf(tool: ToolView): { name: string; url?: string; publicUrl?: string } | undefined {
	const raw = detailsOf(tool).forward;
	const forward = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const link = (value: unknown) =>
		typeof value === "string" && /^https?:\/\/(?:fwd|pub)--[0-9a-f]{32}--[a-z0-9]+\.[^/\s]+\/$/.test(value)
			? value
			: undefined;
	const url = link(forward.url);
	const publicUrl = link(forward.publicUrl);
	if (tool.status !== "done" || !(url || publicUrl)) return undefined;
	return {
		name:
			stringOf(forward.name) || `port ${typeof forward.port === "number" ? forward.port : stringOf(forward.port)}`,
		...(url ? { url } : {}),
		...(publicUrl ? { publicUrl } : {}),
	};
}

function PortLinks({ tool }: { tool: ToolView }) {
	const forward = forwardOf(tool);
	if (!forward) return null;
	return (
		<div className="result-links">
			<ToolIcon />
			{forward.url && (
				<a
					className="result-link"
					data-testid="tool-link"
					href={forward.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					Open {forward.name}
				</a>
			)}
			{forward.publicUrl && (
				<a
					className="result-link"
					data-testid="tool-link"
					href={forward.publicUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					Public link
				</a>
			)}
		</div>
	);
}

function PortsDetail({ step }: { step: Step }) {
	const { tool } = step;
	return (
		<InputOutput
			input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
			output={
				<>
					<PortLinks tool={tool} />
					{tool.output.trim() && <OutputBlock output={tool.output} failed={step.status === "error"} />}
				</>
			}
		/>
	);
}

const port = (tool: ToolView) => (typeof tool.args.port === "number" ? String(tool.args.port) : "");

export const portsActivity: ToolActivity = {
	describe(step) {
		const action = stringOf(step.tool.args.action);
		return {
			label: {
				kind: "port",
				verb: action === "open" ? "Opened port" : action === "close" ? "Closed port" : "Listed ports",
				...(port(step.tool) ? { object: port(step.tool), style: "code" as const } : {}),
			},
			description: failureOf(step) ?? (stringOf(step.tool.args.name) || undefined),
		};
	},
	argument: (tool) =>
		[stringOf(tool.args.action), port(tool), stringOf(tool.args.name), tool.args.public === true ? "public" : ""]
			.filter(Boolean)
			.join(" "),
	hasResult: (tool) => (forwardOf(tool) ? "after" : false),
	Result: PortLinks,
	Detail: PortsDetail,
};
