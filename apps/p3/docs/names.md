# Names

One name per thing, used the same way in plugins, contracts, pane kinds, code and docs (owner, 2026-11-14). A plugin
is named after the one thing it owns; its contracts and its pane kind carry that name. Chord's own terms (host, link,
plugin, facet, contract, object, reference, registry, document, table, derive, native, routine, job) keep their
meaning from `packages/chord/docs/design.md` §2.

| Name | Means | Not |
| --- | --- | --- |
| Pi | one installation of p3, with one owner | instance |
| owner | the person who owns the Pi and installs its plugins | admin |
| person | anyone else the owner lets in | user, guest, member |
| app | a plugin with its own layout, views and sessions; coding is the built-in app | |
| session | one agent workspace, with its own worker and store; belongs to exactly one app | chat, thread |
| conversation | one line of talk in a session; branches and subagents are conversations | |
| transcript | a conversation's entries, and the plugin and pane that own them | chat |
| entry | one item in a transcript (a message, a tool call, a marker) | |
| run | the agent's work from an input to its answer | |
| turn | one assistant answer plus its tool calls; a run has one or more turns | |
| harness | Durable in the session's worker, which composes what the agent gets | |
| extension | what a plugin gives the harness: tools, prompt sections, hooks | |
| tool | one thing the agent can call | |
| model | a language model | |
| provider | who offers models (and signs the owner in to them) | |
| environment | a machine the agent works on: this device, SSH, a sandbox | env, hands |
| location | where a session works: an environment and a folder | place |
| lock | something a plugin lets be switched off or limited | session lock, setting |
| layer | where a lock's value is set: org, Pi, app, session | scope |
| sheet | the screen where one layer's locks are set | |
| org | a company that manages its members' Pis | company |
| view | a kind of pane | |
| layout | how an app arranges its views | |
| slot | a place inside a view where other plugins add parts | |
| workbench | the page's frame: pane chrome, the fixed bar, safe mode | |
| question | something a person is asked: an ask or an approval | |
| artifact | something a session made to be shown | |
| identity provider | how a person proves who they are (Radius, this device) | |
| invite | a link that lets a person join | |
| sign-in | one browser or device signed in as someone | session (for logins) |
| admission | Chord's decision, before an object's factory, whether and at which level a principal gets it | access check |
