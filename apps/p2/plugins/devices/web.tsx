import { BACKGROUND_CONTEXT, contribute, defineFacet } from "@p2/app/v1";
import {
	CopyButton,
	closeLayers,
	forgetOwner,
	openLayer,
	Sheet,
	Slots,
	useObject,
	useOwner,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Devices } from "./contract.ts";

function DevicesSheet() {
	const service = useObject(Devices, {});
	const canMint = useReadable(service?.canMint);
	const [token, setToken] = useState<string>();
	const [error, setError] = useState<string>();
	const [generation, setGeneration] = useState(0);
	const [confirmAll, setConfirmAll] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const signOut = (all: boolean) => {
		setSigningOut(true);
		setError(undefined);
		void fetch(all ? "/owner/logout-all" : "/owner/logout", { method: "POST", credentials: "same-origin" })
			.then(async (response) => {
				if (!response.ok) throw new Error("Could not sign out. Try again.");
				// Conversations kept on this device for the owner go with the sign-in.
				await forgetOwner();
				location.replace("/owner");
			})
			.catch((reason: Error) => {
				setError(reason.message);
				setSigningOut(false);
			});
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: generation explicitly requests a fresh token.
	useEffect(() => {
		let current = true;
		setToken(undefined);
		setError(undefined);
		if (service && canMint)
			void service
				.token(BACKGROUND_CONTEXT)
				.then(({ token }) => {
					if (current) setToken(token);
				})
				.catch((reason: unknown) => {
					if (current) setError(reason instanceof Error ? reason.message : "Could not generate a sign-in token.");
				});
		return () => {
			current = false;
		};
	}, [service, canMint, generation]);
	return (
		<Sheet title="Devices" onClose={closeLayers}>
			<div className="stack">
				<p>This token grants full owner access. Give it only to your own device, not to collaborators.</p>
				<p className="muted small">
					Open Pi's domain on the other device, paste this token into the sign-in page, and tap Sign in. It expires
					after ten minutes and works once.
				</p>
				{canMint === false ? (
					<p className="error" role="alert">
						Generate owner links on the host with npm run owner-link. Associated devices cannot mint more tokens.
					</p>
				) : error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : token ? (
					<>
						<label className="label" htmlFor="owner-token">
							One-time sign-in token
						</label>
						<textarea
							id="owner-token"
							className="input mono"
							rows={3}
							readOnly
							value={token}
							onFocus={(event) => event.target.select()}
						/>
						<CopyButton key={token} primary text={token} label="Copy token" />
						<button type="button" className="text-action" onClick={() => setGeneration((value) => value + 1)}>
							Generate a new token
						</button>
					</>
				) : (
					<output className="muted">Generating token…</output>
				)}
				{canMint === false && error && (
					<p className="error" role="alert">
						{error}
					</p>
				)}
				<div className="list">
					<button type="button" className="text-action" disabled={signingOut} onClick={() => signOut(false)}>
						Sign out on this device
					</button>
					{confirmAll ? (
						<>
							<p className="muted small">
								This signs out every associated device, including this one, and invalidates outstanding owner
								links. Already-running agent work is not stopped.
							</p>
							<button
								type="button"
								className="text-action danger"
								disabled={signingOut}
								onClick={() => signOut(true)}
							>
								Confirm sign out all devices
							</button>
							<button
								type="button"
								className="text-action"
								disabled={signingOut}
								onClick={() => setConfirmAll(false)}
							>
								Cancel
							</button>
						</>
					) : (
						<button
							type="button"
							className="text-action danger"
							disabled={signingOut}
							onClick={() => setConfirmAll(true)}
						>
							Sign out all devices
						</button>
					)}
				</div>
			</div>
		</Sheet>
	);
}
function DevicesButton() {
	const sheet = useSheet("devices");
	if (!useOwner()) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				title="Sign in another device"
				onClick={() => openLayer({ kind: "sheet", name: "devices" }, { fromDrawer: true })}
			>
				Devices
			</button>
			{sheet && <DevicesSheet />}
		</>
	);
}
export default defineFacet((host) => {
	contribute(host, "p2.web-devices", (self) => {
		self.contribute(Slots, { "sidebar-foot:devices": DevicesButton });
	});
});
