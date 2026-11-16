# Slice 25: Sign-in with Radius

**Goal.** Signing in to a Pi with Radius is really nice, on the web and in the terminal: one button (or one command),
one approval at Radius, back in and remembered. The first web and terminal scaffold of p3 comes with it.

**Decided (owner, 2026-11-15):** its own slice, right after slice 1; a small web scaffold (the base page entry
rendering one slot, the sign-in screen as a plugin) and the terminal launcher's flow; plain styles of its own until
Elanor's components and CSS arrive (the screen is a plugin: swapping its look is a plugin edit; the flow, the provider
and the sign-in records stay).

## What p2 does (research, 2026-11-15; private: `/home/badlogic/chord-notes/research/p3-radius-signin.md`)

| p2 feature | p3 |
| --- | --- |
| The server's own link to Radius: set up once in a terminal (`npm run radius:login`, device code, client `pi-gateway`, scope `gateway offline_access`), tokens in `radius.json`, refreshed under 5 minutes, status only in logs | a Radius card in the owner's settings replaces the command (this slice or slice 21) |
| Browsers never sign in with Radius: identity comes from the relay (Radius checks the request and passes `{ kind, id, organization_id, email }`) | a person's identity bound by Radius user id, not email |
| The terminal launcher's own device-code login (owner only) | `pi join <link>` and the launcher share one flow |
| Radius as a model provider, Radius's MCP server: separate logins | not this slice (slices 7, 13) |

## What Radius offers today

- **Available:** OAuth discovery (RFC 8414), PKCE, device codes (the response includes a link with the code filled
  in), and dynamic client registration.
- **Missing:**
  - no OpenID Connect (no ID token, no userinfo; `openid`/`profile`/`email` are refused);
  - redirects only to loopback;
  - one scope, `gateway`, which is the user's whole API access.

So today a Pi can learn who a person is only through the relay, or by running a device-code login itself. The second
gives the Pi the person's full Radius token: fine for the owner, not for other people.

## The proposed flow (to detail with the slice)

The same flow on the web and in the terminal: a **pending sign-in** on the Pi.
1. The client asks its own Pi to start a sign-in.
2. The person approves at `radius.earendil.com/pair?code=…`, with the code filled in: one click when they are signed
   in to Radius.
3. The Pi's server learns the Radius user id and email, and finds or binds the person by user id.
4. The waiting browser gets the Pi's sign-in cookie; the terminal gets a token in its client file.

Screens (from the research):
- the join card;
- the approval popup with a matching code and a QR;
- the end states: no access, invite used, expired, declined, Radius unreachable, signed in as someone else;
- "Connect Radius" for a temporary person who joined by name;
- the owner's Radius card.

A visit through the relay needs no sign-in: the relay's identity maps to the same person.

**Radius changes it needs** (research recommendation):
1. a sign-in run through the Pi's own Radius connection, with a consent screen naming the Pi and its owner, so no
   person hands the Pi a token;
2. admission by Radius user id rather than email, a join path for any Radius user through the relay, and terminal
   connections for people other than the owner.

Until then, the screens can run on today's device code, for the owner only.

## Decided since (owner, 2026-11-16)

- The sign-in screen lists the registered identity providers: Radius and pairing.
- Pairing: the new device shows a short code, a signed-in device approves it (`p3 pair <code>`, the local page, the
  terminal client); no link travels, so the Pi never needs its public address (decision "Signing in a new device").
- No owner password.
- Open here: accepting remote requests behind a tunnel without declaring its host name, given Chord's HTTP baseline
  against DNS rebinding.

## Open (owner decisions, one at a time, with the details)

- Which Radius changes to ask for, or whether to accept the interim for persons.
- What Radius returns about a person (verified email, name); whether refresh tokens rotate; how tokens are revoked.
- Whether an invite is a bearer link or must match the invited email.
- An identity already bound to one person opening an invite made for a new person.
- Device-code phishing.
- Whether `name` stays in the principal.

**Depends on:** slice 1 (the kit's sign-ins and owner); slice 5's model (persons, links, identity providers) for the
binding. The people plugin's identity-provider registry starts here with one provider.

**Read first:** `chord-practices.md`; `decisions.md` ("Persons, guests and links", "The principal is identity only");
`slices/05-people-and-apps.md`; the research report above; p2's `plugins/radius/`, `plugins/login/`, the kit's
`sign-ins.ts` and `owner.ts` (p3's copies in `apps/p3/src/kit/`).
