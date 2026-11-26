// The composer of a holder with Send: the message being written, sent with Enter (Shift+Enter for a new line) or the
// send button, and with Stop a stop button while the agent works. The draft lives in page state under its key: a
// reload of a plugin keeps it, and only a successful send clears it; a failed send keeps the text.

import { Button, TextArea } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/p3/v1";
import { SendIcon, StopIcon, useMessages, usePageState } from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./composer.module.css";
import { messages } from "./messages.ts";

/**
 * The composer: `draft` keys the text in page state; `send` takes the text and a request id; `stop` (given with Stop)
 * is shown while `working`.
 */
export function Composer(props: {
	readonly draft: string;
	readonly working: boolean;
	readonly send: (message: { readonly text: string; readonly requestId: string }, context: Context) => Promise<null>;
	readonly stop?: (context: Context) => Promise<null>;
}) {
	const { t } = useMessages(messages);
	const [text, setText] = usePageState(props.draft, "");
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
					aria-label={t("message")}
					className={styles.input}
					data-message=""
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
					onValueChange={setText}
					placeholder={t("message")}
					rows={1}
					value={text}
				/>
				{props.working && props.stop !== undefined ? (
					<Button
						data-stop=""
						iconStart={<StopIcon />}
						onClick={() => void props.stop?.(BACKGROUND_CONTEXT).catch(failed)}
						semantic="negative"
					>
						{t("stop")}
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
					{t("send")}
				</Button>
			</div>
		</form>
	);
}

/** A fresh id for one send: a retry of the same send would carry it, and the worker takes it once. */
function requestId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
