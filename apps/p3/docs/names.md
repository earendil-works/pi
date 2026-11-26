# Names

One name per thing, used the same way in plugins, contracts, pane kinds, code and docs (owner, 2026-11-14). A plugin
is named after the one thing it owns; its contracts and its pane kind carry that name. Chord's own terms (host, link,
plugin, facet, contract, object, reference, registry, document, table, derive, native, routine, job) keep their
meaning from `packages/chord/docs/design.md` §2.

| Name | Means | Not |
| --- | --- | --- |
| Pi | one installation of p3, with one owner | instance |
| owner | the person who owns the Pi and installs its plugins: a person with the owner flag | admin |
| person | anyone who signs in, the owner among them (an invite link makes the others) | user, guest |
| group | persons an app made for one of its roles (coaches, players) | role, team |
| member | a person or a group in a session, who reads or writes there | share, participant |
| app | a plugin that owns the page below the top bar, and its sessions; coding is the built-in app | |
| session | one agent in one folder of one environment, with its members and things, its own worker and store; belongs to exactly one app. The page may say workspace | chat, thread |
| party | a person or a group | |
| thing | one record of a kind a plugin brings (a canvas, a notebook, a login, the coding tools), with one id, a name and an owner: a person, a group, the Pi, or nobody. Sessions use things | resource, feature |
| content | a thing nobody owns: made in a session by a writer or the agent, gone when no session uses it | artifact, document |
| options | what a thing allows in one session: one whole object per party there (everyone, the agent, a member) | settings |
| everywhere | an owned thing's switch: every session that follows its owner has it. The page says "in all my sessions" | global, default, shared |
| follows | a session follows one party, or nobody: it has that party's `everywhere` things, live, while the party writes in it | inherits, template |
| keep | a writer gives content an owner (themselves, a group of theirs, the Pi for the owner) | save, claim |
| conversation | one line of talk in a session; branches and subagents are conversations | |
| transcript | a conversation's entries, and the plugin and pane that own them | chat |
| entry | one item in a transcript (a message, a tool call, a marker) | |
| run | the agent's work from an input to its answer | |
| turn | one assistant answer plus its tool calls; a run has one or more turns | |
| harness | Durable in the session's worker, which composes what the agent gets | |
| extension | what a kind's things give the harness: tools, prompt sections, hooks; one per kind and session | |
| tool | one thing the agent can call | |
| model | a language model | |
| provider | who offers models (and signs the owner in to them) | |
| environment | a machine the agent works on: this device, SSH, a sandbox | env, hands |
| location | where a session works: an environment and a folder | place |
| org | a company that manages its members' Pis | company |
| view | a React component a plugin offers for something to show (`defineView`); apps place views | pane, panel |
| layout | how an app arranges its views | |
| slot | a place inside a view where other plugins add parts | |
| chrome | the page's frame: the top bar (app switcher, person menu, connection) and the chosen app's page | workbench |
| question | something a person is asked: an ask or an approval | |
| artifact | something a session made to be shown | |
| identity provider | how a person proves who they are (Radius, this device) | |
| invite | a link that lets a person join | |
| sign-in | one browser or device signed in as someone | session (for logins) |
| admission | Chord's decision, before an object's factory, whether and at which level a principal gets it | access check |

Changed on the branch `skeleton` (2026-11-22, `base.md`): lock, layer and sheet are gone with locks; person, group,
member, thing, options, view and chrome as above.
On 2026-11-23 (`base.md`, "Things"): party, content, everywhere, follows and keep are new; thing and options changed
(a thing is a record with one id and an owner, no longer "added with options").

Names still to choose (docs audit, 2026-11-14): a word for a provider's login (here "sign-in" means a signed-in
device); a word for the loader refusing a plugin (here "admission" is Chord's pre-factory decision); Durable's
conversation "view" against the pane "view"; p2's "workspace" (files and diffs) against "session: one agent
workspace"; groupings (sidebar sections), shares, the org profile, the plugin registries (`ViewKinds`,
`ArtifactKinds`). Lock ids must follow plugin names (`coding.bash`, `conversations.reach`, `locations.places`,
`terminals.use` do not yet).
