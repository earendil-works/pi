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
| group | persons put together (a family, a team), managed by its own tick | role, team |
| workspace | a thing that holds things and people (Pi, a project, Family); Pi is the root | folder, space |
| session | a session workspace: a leaf with one agent, its own worker and store; its id is its workspace's | chat, thread |
| party | whom a grant names: everyone here, the agents, a person, a group, one session's agent | |
| thing | one record of a kind a plugin brings (a canvas, a notebook, a login, the coding tools, a session), with one id and a name, linked in one or more workspaces | resource, feature |
| kind | a plugin's type of thing (`defineThing`, `defineWorkspace`): its members, ticks, default grants and makers | type |
| tick | a right on a thing, granted to a party where it is linked (Read, Draw, Bash; the workspace ticks Link, Hide, Configure, Manage people, Manage access; Make) | permission, scope |
| grant | one row giving (or withholding) one tick to one party on one thing in one workspace | |
| answer | what a caller gets for a thing in a workspace: its ticks (perhaps none), from the things plugin's index | |
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
| view | one way to look at a target (a thing of a kind, a person, a group): an entry of the things plugin's `Views`; a kind has 0 to n | pane, panel, app |
| component | a React component a plugin offers others to place (`defineComponent`, `Components`, `useComponent`): the pane layout, the navigator. Its token has no `View` suffix (`PaneLayout`, `Navigator`, `Settings`); `TargetView` is the decided name of the one that draws a target in its view | view |
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
