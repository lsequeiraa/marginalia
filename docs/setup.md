# Setup

## Install

```
opencode plugin add opencode-marginalia
```

Then restart opencode. Nothing is written until something is actually worth remembering.

Marginalia needs opencode 2.3 or later.

## The CLI

The `marginalia` command ships in the same package. Run it without installing anything:

```
npx opencode-marginalia inspect
```

or install it once to get a plain `marginalia` command:

```
npm install -g opencode-marginalia
```

It needs Bun or Node 22.5 or later. The agent-facing tools do not.

| Command | |
|---|---|
| `marginalia inspect` | what is loaded for this repository, and what it costs |
| `marginalia why <text>` | which conversation taught a fact, with the command to resume it |
| `marginalia log [n]` | what has been learned, in order |
| `marginalia version` | installed version against the latest on npm |
| `marginalia path` | print the storage directory |
| `marginalia dream` | review memory against recent sessions, see [Dreaming](dreaming.md) |

## Updating

opencode tracks plugin versions itself:

```
opencode plugin check    # report available updates
opencode plugin update   # apply them, then restart opencode
```

`marginalia version` also tells you when a newer release exists, checking npm on demand.

The daily background update check was removed in the opencode 2 port. Its only output was a toast, and server plugins have no way to raise one, because they run in a separate process from the terminal client. `opencode plugin check` covers it properly.

## Upgrading from a two-scope install

Older versions had two scopes, "global" and "project". There are now three: `user`, `global` and `project`.

`global/MEMORY.md` is left exactly as it is and now renders as *Across projects*. Nothing is moved for you, because guessing which of your entries are about *you* would get it wrong. If some are, move them into `user/MEMORY.md` by hand, or re-add them with `#me`.

Note that `#user` used to be a synonym for `#global`. It is now not a prefix at all, so `#user …` saves to the current project with the text intact.

## Server and terminal halves

The package has two halves that run in **different processes**. The memory engine is a server plugin. A `/memory` dialog for browsing the store is a CLI plugin living in the terminal client. They share no state and communicate only through the memory files on disk.

opencode resolves both from one package via the `exports` map, so a single install covers them:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["opencode-marginalia"] }   // -> ./server, and ./tui alongside it
```

If you run the terminal client against a *remote* server, register the terminal half separately so it stays local:

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": ["opencode-marginalia"] }   // -> ./tui
```

The server half works on its own. Memory itself, the tools and path-scoped loading do not depend on the terminal half.

If `/memory` ever stops appearing, check the `/plugins` dialog. A plugin disabled there stays disabled regardless of config.
