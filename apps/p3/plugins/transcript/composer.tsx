// A writer's composer: the message being written, sent with Enter (Shift+Enter for a new line) or the send button,
// and a stop button while the agent works. A failed send keeps the text.

import { Button, TextArea } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/p3/v1";
import { SendIcon, StopIcon } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./composer.module.css";

/** The composer: `send` takes the text and a request id; `stop` is shown while `working`. */
export function Composer(props: {
	readonly working: boolean;
	readonly send: (message: { readonly text: string; readonly requestId: string }, context: Context) => Promise<null>;
	readonly stop: (context: Context) => Promise<null>;
}) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const failed = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
	const submit = () => {
		const message = text.trim();
		if (message === "" || sending) return;
		setSending(true);
		setError(undefined);
		props.send({ text: message, requestId: requestId() }, BACKGROUND_CONTEXT).then(
			() => {
				setSending(false);
				setText("");
			},
			(failure: unknown) => {
				setSending(false);
				failed(failure);
			},
		);
	};
	return (
		<form
			className={styles.composer}
			data-composer=""
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			{error === undefined ? null : <p className={styles.error}>{error}</p>}
			<div className={styles.row}>
				<TextArea
					aria-label="Message"
					className={styles.input}
					data-message=""
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
					onValueChange={setText}
					placeholder="Message"
					rows={1}
					value={text}
				/>
				{props.working ? (
					<Button
						data-stop=""
						iconStart={<StopIcon />}
						onClick={() => void props.stop(BACKGROUND_CONTEXT).catch(failed)}
						semantic="negative"
					>
						Stop
					</Button>
				) : null}
				<Button
					data-send=""
					disabled={text.trim() === ""}
					hierarchy="primary"
					iconStart={<SendIcon />}
					pending={sending}
					type="submit"
				>
					Send
				</Button>
			</div>
		</form>
	);
}

/** A fresh id for one send: a retry of the same send would carry it, and the worker takes it once. */
function requestId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
