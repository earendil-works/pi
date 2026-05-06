import { ImagePlus, Loader2, SendHorizontal, Sparkles, X } from "lucide-react";
import * as React from "react";
import { useRef, useState } from "react";
import { BorderBeam } from "@/components/magicui/border-beam";
import { ShineBorder } from "@/components/magicui/shine-border";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatImageInput, WebState } from "@/lib/types";

interface ComposerProps {
	state: WebState | null;
	busy: boolean;
	onSubmit: (message: string, images: ChatImageInput[], behavior?: "steer" | "followUp") => Promise<void>;
	onAbort: () => Promise<void>;
}

async function fileToChatImage(file: File): Promise<ChatImageInput> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
		reader.readAsDataURL(file);
	});
	const commaIndex = dataUrl.indexOf(",");
	return {
		data: commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1),
		mimeType: file.type || "application/octet-stream",
		name: file.name,
	};
}

export const Composer = React.forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
	{ state, busy, onSubmit, onAbort },
	forwardedRef,
): React.ReactElement {
	const [message, setMessage] = useState("");
	const [images, setImages] = useState<ChatImageInput[]>([]);
	const [queueMode, setQueueMode] = useState<"steer" | "followUp">("steer");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const isStreaming = state?.isStreaming ?? false;
	const canSubmit = message.trim().length > 0 && !busy;

	async function submit(): Promise<void> {
		const text = message.trim();
		if (!text || busy) return;
		setMessage("");
		setImages([]);
		await onSubmit(text, images, isStreaming ? queueMode : undefined);
	}

	return (
		<div className="relative rounded-[1.5rem]">
			<BorderBeam className={isStreaming ? "opacity-100" : "opacity-0"} />
			<ShineBorder />
			<div className="glass relative rounded-[1.5rem] p-3">
				<div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Sparkles className="size-3.5" />
						<span>{isStreaming ? "Queue guidance while pi works" : "Ask pi to read, edit, run, and reason"}</span>
					</div>
					{isStreaming ? (
						<div className="flex items-center gap-1 rounded-full border bg-background/40 p-1 text-xs">
							<button
								type="button"
								className={
									queueMode === "steer"
										? "rounded-full bg-primary px-2 py-1 text-primary-foreground"
										: "px-2 py-1 text-muted-foreground"
								}
								onClick={() => setQueueMode("steer")}
							>
								steer
							</button>
							<button
								type="button"
								className={
									queueMode === "followUp"
										? "rounded-full bg-primary px-2 py-1 text-primary-foreground"
										: "px-2 py-1 text-muted-foreground"
								}
								onClick={() => setQueueMode("followUp")}
							>
								follow-up
							</button>
						</div>
					) : null}
				</div>
				<Textarea
					ref={forwardedRef}
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					placeholder={
						state?.model
							? "Describe the change you want. Use @ paths in plain text, slash prompts, or attach images."
							: "Configure an API key with pi /login or auth.json, then reload this page."
					}
					className="min-h-28 border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				{images.length > 0 ? (
					<div className="mb-3 flex flex-wrap gap-2">
						{images.map((image, index) => (
							<Badge key={`${image.name ?? image.mimeType}-${index}`} variant="outline" className="gap-1.5">
								{image.name ?? image.mimeType}
								<button
									type="button"
									className="rounded-full hover:text-destructive"
									onClick={() =>
										setImages((current) => current.filter((_, imageIndex) => imageIndex !== index))
									}
								>
									<X className="size-3" />
								</button>
							</Badge>
						))}
					</div>
				) : null}
				<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
					<div className="flex items-center gap-2">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={(event) => {
								const files = Array.from(event.target.files ?? []);
								void Promise.all(files.map(fileToChatImage)).then((loaded) =>
									setImages((current) => [...current, ...loaded]),
								);
								event.currentTarget.value = "";
							}}
						/>
						<Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
							<ImagePlus /> Image
						</Button>
						{isStreaming ? (
							<Button variant="outline" size="sm" onClick={() => onAbort()}>
								<X /> Abort
							</Button>
						) : null}
					</div>
					<Button disabled={!canSubmit} onClick={() => void submit()}>
						{busy ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
						{isStreaming ? "Queue" : "Send"}
					</Button>
				</div>
			</div>
		</div>
	);
});
