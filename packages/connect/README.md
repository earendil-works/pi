# @earendil-works/pi-connect

Sign in to model providers from the browser with [pi-ai](../ai), and know what works there and why.

A pi-ai `Models` collection in a browser has three problems the CLI does not have:

- Many providers' OAuth sign-ins redirect only to a local server (`http://127.0.0.1:…`), which a web page cannot run.
- Some providers' auth endpoints send no CORS headers, so a page can neither finish a sign-in nor refresh a token.
- There is no `~/.pi/agent/auth.json`: credentials and model catalogs need a home in the browser.

pi-connect handles all three, and is transparent about what is not possible:

```ts
import { openConnect } from "@earendil-works/pi-connect";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";

const connect = await openConnect({ providers: [radiusProvider(), anthropicProvider()] });
void connect.refresh(); // newer auth documents and model catalogs from pi.dev

for (const provider of connect.support()) {
	// provider.available, provider.reason, provider.methods[].tier / .available / .reason
}

signInButton.onclick = () => connect.signIn("radius"); // must run in a click handler
await connect.setApiKey("anthropic", key);

// Hand the collection to pi-ai or pi-durable.
const harness = await Harness.open(storage, { models: connect.models }, context);
```

## What works in a browser

Every sign-in method of every provider has a tier in the browser. Outside browsers every method works directly.

| Tier | Meaning |
|---|---|
| `direct` | Works without pi infrastructure beyond the sign-in window. |
| `relay-login` | The sign-in goes through pi.dev's relay; refreshes go to the provider directly. |
| `relay-always` | The sign-in and every token refresh go through pi.dev's relay. |
| `manual` | The provider redirects to a local server; the user pastes the address of the page that fails to load. Off unless the app passes `manual: true`. |
| `unsupported` | Not possible, with the reason. |

A provider is only usable when its model API accepts browser requests; otherwise every method is unavailable and the
provider's `reason` says why. The current matrix is at <https://pi.dev/connect/providers>.

The information comes from **auth documents**: metadata that pi.dev publishes at `/api/auth/providers` and this package
bundles (`BUILTIN_AUTH_DOCUMENTS`). `refresh()` adopts a newer revision and caches it in IndexedDB. Documents never name
an endpoint or a client ID; those stay in pi-ai's flow code, so a document cannot send a credential anywhere new.
Providers pi.dev does not document are offered with their API key, marked `unknown`.

`scripts/probe-cors.ts` checks the bundled documents against what the providers' endpoints accept today and fails on
any mismatch. Run it before publishing new documents:

```sh
node packages/connect/scripts/probe-cors.ts
```

## Signing in

`signIn(provider, method?)` opens pi.dev's sign-in window (`https://pi.dev/connect`) and resolves once the credential
is stored:

1. The window announces itself; the app answers with the provider, the method and a nonce.
2. The window takes the app's origin from that message (the browser sets it, so a page cannot claim another), shows it
   ("http://example.com asks to sign in to your Anthropic account"), and waits for the user to continue.
3. It runs the provider's pi-ai flow: device codes, copy-a-code pages and, with `manual`, pasted addresses.
4. It sends the credential to that origin only and closes. pi.dev keeps no credential.

Requirements for the app's page:

- Call `signIn` from a click handler, or the browser blocks the window (`popup_blocked`).
- Do not send `Cross-Origin-Opener-Policy: same-origin`; it cuts the link between the windows. Use
  `same-origin-allow-popups` if you need COOP.

Failures reject with a `ConnectError` whose `code` is `unknown_provider`, `unavailable`, `popup_blocked`,
`popup_closed`, `cancelled` or `sign_in_failed`.

## The relay

pi.dev forwards requests to a fixed list of provider auth endpoints that send no CORS headers (`RELAY_ENDPOINTS`) and
stores nothing. Sign-in steps are accepted only from pi.dev's sign-in window, so every new sign-in passes the page
that shows which site receives the credential; token refreshes are accepted from any page. `openConnect` registers
pi-ai's OAuth flows with a fetch that routes exactly these endpoints through the relay (`relayFetch`); everything else,
including all model requests, goes to the provider directly.

## Security model

What protects what:

- **The credential reaches only the site the user saw.** The window shows the origin the browser
  reports for the opening page and posts the credential to that origin only. It is always a fresh
  window (`_blank`), drops any window name, and opens links with `noopener`, so no other page can
  get a handle to it. Its Continue button arms only after the window has been visible for a moment,
  so a double-click aimed at the opening page cannot approve the sign-in.
- **The window cannot run injected code.** It is served with a Content Security Policy that allows
  only same-origin scripts, no inline code, no framing and no form submissions, and enforces Trusted
  Types. Addresses from providers are linked only if they are http(s).
- **The relay is not an open proxy.** It forwards only to exact allowlisted URLs and methods, at most
  16 KiB, re-serializes token bodies so the provider sees the grant type the relay checked, drops
  cookies and redirects, rate limits per IP, and stores and logs no bodies. Its answers are sandboxed
  documents.
- **Sign-in steps through the relay need the window.** The relay accepts code exchanges and device
  polling only with pi.dev's origin. This keeps other sites from using pi's OAuth clients through
  pi.dev without showing the user who asks. It is a policy boundary, not a credential boundary: anyone
  with a server can call the providers directly.
- **Documents cannot redirect credentials.** They carry no endpoints; the endpoints are in pi-ai's code.

What it does not protect:

- Credentials in the app's IndexedDB are readable by any script on the app's origin.
- pi.dev is trusted: it serves the window's code. A compromised pi.dev can take every new sign-in.
- Tokens for relayed providers pass through pi.dev's memory at sign-in and, for `relay-always`, at
  every refresh.
- Device-code sign-ins can be phished like anywhere else: an attacker's site can start one and show the
  code. The window always names the asking site.

## Storage

Credentials and model catalogs live in IndexedDB (database `pi-connect` by default). A Web Lock per provider makes
token refreshes one critical section across tabs, so two tabs never spend the same refresh token.

Credentials are readable by any script on the app's origin. Keep untrusted code, including model-generated code you
run in the page, away from them.

## pi.dev

pi.dev serves the auth documents, the model catalogs (`/api/models/...`), the relay (`/api/oauth/relay`) and the
sign-in window (`/connect`). It vendors this package's popup and data with `scripts/vendor-pi-connect.mjs`. Pass
`piUrl` to use another deployment, for example a local pi.dev during development.
