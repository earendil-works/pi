// Pi Mobile's app-level new-session choices, retained when another conversation opens.
import { createContext, type ReactNode, useContext, useState } from "react";
import type { ModelChoice } from "./ModelPicker.tsx";

/**
 * A project the new session joins (a sidebar project group's "+"): its name, shown on the new-session screen, and how
 * the session joins it once created (given its ID).
 */
export type NewSessionJoin = { readonly label: string; readonly run: (session: string) => Promise<unknown> };

type State = {
	location: { env: string | null; cwd: string } | undefined;
	setLocation: (location: { env: string | null; cwd: string }) => void;
	/** The group the new session joins; "New session" clears it, picking another directory keeps it. */
	join: NewSessionJoin | undefined;
	setJoin: (join: NewSessionJoin | undefined) => void;
	choice: ModelChoice | undefined;
	setChoice: (choice: ModelChoice | undefined) => void;
};
const Context = createContext<State | undefined>(undefined);
export function NewSessionState({ children }: { children: ReactNode }) {
	const [location, setLocation] = useState<State["location"]>();
	const [join, setJoin] = useState<NewSessionJoin>();
	const [choice, setChoice] = useState<ModelChoice>();
	return (
		<Context.Provider value={{ location, setLocation, join, setJoin, choice, setChoice }}>
			{children}
		</Context.Provider>
	);
}
export function useNewSessionState(): State {
	const state = useContext(Context);
	if (!state) throw new Error("Missing app new-session state");
	return state;
}
