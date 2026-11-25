// The composer state's error as a toast (composer-state.tsx's `fail`): the chat shows it, and so does every main-area
// page that acts, so a refused action is never silent. Tapping it dismisses it.
import { useComposerState } from "./composer-state.tsx";

/** The app's current error; tapping it dismisses it. */
export function ErrorToast() {
	const { error, setError } = useComposerState();
	return error ? (
		<button type="button" className="toast" onClick={() => setError(undefined)}>
			{error}
		</button>
	) : null;
}
