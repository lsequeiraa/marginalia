# Marginalia

Persistent memory for [opencode](https://opencode.ai) agents — notes in the margins of your codebase.

Plain markdown files. Git-backed. No vector database, no Python, no daemon, and no extra LLM calls.

```
opencode plugin add opencode-marginalia
```

Then restart opencode. Nothing is written until something is actually worth remembering.

One install covers both halves: opencode resolves `./server` for the memory engine and `./tui` for the `/memory` modal from the same package.

---

## Why

opencode already has the half of memory that *you* write: `AGENTS.md`. What it has no answer for is the half the *agent* writes — the build command it had to discover, the correction you have now made three times, the optimisation that turned out not to work.

Most plugins in this space bet on *capture everything, retrieve semantically*: embeddings, a vector store, an LLM summarising every turn. Marginalia bets the other way — **high-precision capture with a visible feedback loop, and retrieval that costs nothing until it is relevant.**

## How it works

**A small always-on index.** `MEMORY.md` for you (global) and one per repository. Roughly 300–600 tokens in practice, and the block reports its own cost so the tax is never invisible.

**Topic files that load only when relevant.** Give a topic file a `paths` glob and it is injected into the `read` tool result whenever the agent opens a matching file — the same mechanism opencode uses natively for nested `AGENTS.md`, so the model already understands the shape. Zero tokens until you touch that code.

```markdown
---
description: Belt solver profiling
paths: ["src/solver/**"]
---
Profiling shows 78% of time in Array allocation inside beltStep().
Preallocate a scratch buffer instead of returning fresh arrays.
```

**Memory that resists rot.** Every entry carries the date, the session and the agent that produced it. Entries older than 90 days render as `[unverified since …]` so the agent revalidates instead of trusting blindly. Writing a fact surfaces similar existing ones so contradictions get reconciled rather than silently duplicated.

**Negative memory.** Approaches that *failed* are first-class (`✗`). Agents re-try dead ends constantly; recording them is often worth more than recording successes.

**A durability linter.** Writes are rejected — with a reason — when they contain a commit SHA, a `file:line` reference, transient phrasing ("currently", "for now"), or anything shaped like a credential. There is no override flag; facts that need a SHA belong in a topic file, not the index.

## Usage

Mostly you do nothing — the agent maintains it. To capture something yourself:

```
#the deploy pipeline needs DOCKER_BUILDKIT=1
#global I prefer surgical diffs over refactors
```

`/memory` opens a searchable modal — a real dialog like `/models` or `/sessions`, not a prompt, so it costs no tokens and no round-trip:

```
Memory   4 entries  ·  1 topic  ·  ≈424 tokens of context                      esc
> ▏search…

  About you
    · Prefers surgical diffs over unrequested refactors.              2026-07-01
  endfield-calc
    · Test with `bun vitest run`; lint with `bun run lint`.           2026-07-02
    ✗ Memoizing the belt solver gave no gain — bottleneck is alloc.   2026-07-03
    · Worktrees live on /mnt/d.  unverified since 2026-01             2026-01-20
  Topic files
    ▸ project/solver-perf.md      auto-loads for src/solver/**             3.3KB
  Marginalia
    How memory works              Capturing facts, and what # does
    Context cost                  What this costs you every turn
    History                       What has been learned, in order
    Version                       Installed vs latest on npm
    Storage folder                Where these files live on disk
```

Selecting an entry shows **where it came from** — the conversation that taught it, with a `resume:` command to go read that exchange.

The same views are available outside opencode via the bundled CLI:

```
marginalia inspect | why <text> | log [n] | version | path
```

The agent gets four tools: `memory_read`, `memory_append`, `memory_write`, `memory_edit`.

## Storage

```
~/.local/share/marginalia/          ← a git repo; every write is committed
├── global/MEMORY.md
└── projects/<repo>-<hash>/
    ├── MEMORY.md
    └── solver-perf.md
```

Plain markdown you can read, edit or delete by hand. The project key is derived from the **git common directory**, so every linked worktree of a repository shares one memory — matching the fact that they are one repository.

Nothing leaves your machine. The only network call is the optional update check below.

## What it costs

Memory is injected into every turn, so the price should be visible rather than implied. `/memory` reports it in the title, and the **Context cost** row breaks it down:

```
  protocol        ≈307    always injected — the rules that make
                          the agent maintain memory at all
  about you       ≈0      0 entries
  endfield-calc   ≈0      0 entries
  topic index     ≈0      0 files
  wrapper         ≈14     headings and tags
  ──────────────────────────────
  total           ≈321    in every session, every turn
```

The shape is a **fixed floor of roughly 310 tokens, then about 20 tokens per fact.** On an empty store ~95% of the cost is the protocol — the rules that make the agent maintain memory at all — not anything you have stored. That floor buys the behaviour; without it nothing gets captured.

Two things are deliberately *not* in that number:

- **Topic file bodies.** A file with `paths` is injected only into the `read` result for a matching file. Ten topic files cost the same as zero until you open the code they describe.
- **Stale entries.** They stay in the index but render as `[unverified since …]`, which is a prompt to reconcile them — pruning is what actually reclaims the tokens, and `/memory` shows you which ones to prune.

## Updating

opencode tracks plugin versions itself:

```
opencode plugin check    # report available updates
opencode plugin update   # apply them, then restart opencode
```

`/memory version` also tells you when a newer release exists, checking npm on demand.

The daily background update check was removed in the opencode 2 port: its only output was a toast, and server plugins have no way to raise one — they run in a separate process from the terminal client. `opencode plugin check` covers it properly.

## Configuration

| Variable | |
|---|---|
| `MARGINALIA_DIR` | storage location (default `~/.local/share/marginalia`) |
| `OPENCODE_DB` | opencode database used by `/memory why` |

## Requirements

opencode 2. The `marginalia` CLI needs Bun **or** Node ≥ 22.5; `/memory` and the agent-facing tools do not.

## How the two halves are registered

Marginalia has two halves — the memory engine and the `/memory` modal — and they run in **different processes**. The engine is a server plugin; the modal is a CLI plugin living in the terminal client. They share no state and communicate only through the memory files on disk.

opencode resolves both from one package via the `exports` map, so a single install covers them:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["opencode-marginalia"] }   // -> ./server, and ./tui alongside it
```

If you run the terminal client against a *remote* server, register the CLI half separately so it stays local:

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": ["opencode-marginalia"] }   // -> ./tui
```

The server half works on its own. Without the CLI half you lose `/memory`; memory itself, the tools and path-scoped injection are unaffected.

If `/memory` ever stops appearing, check the `/plugins` dialog — a plugin disabled there stays disabled regardless of config.

## Development

```bash
git clone https://github.com/lsequeiraa/marginalia && cd marginalia
bun install
bun test          # 189 tests
bun run typecheck # tsc as a checker; no build step, no emit
```

Point opencode at the working copy — use the **directory**, which picks up both halves at once:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["/absolute/path/to/marginalia"] }
```

For a directory target opencode joins the path directly (`<dir>/server`, `<dir>/tui`) and does **not** consult `package.json` `exports`. That is what the root `server.js` and `tui.js` shims are for; they re-export from `src/`. Published installs go through `exports` as normal.

Symlinking the checkout into `~/.config/opencode/plugins/` works too, and is the tidier option for local development — CLI plugins are discovered as directories there. Do not do both, or it loads twice. Local plugins are keyed by mtime, so editing a file is enough to reload the CLI half; the server half needs a restart.

## Design notes

- The injected block is **pushed** as a separate system entry, never written over `system[0]`, which holds the base prompt. The v1 rationale was prompt-cache breakpoints on the first two system messages; that specific claim has not been re-verified against v2, but pushing exactly one entry and leaving index 0 alone remains the conservative choice either way.
- The rendered block is cached per session and rebuilt only on compaction, so a memory write mid-session does not bust the KV cache.
- Path-scoped injection is deduplicated per session and re-armed after compaction.
- Every hook is wrapped in `try/catch`. A bug in a memory plugin must never break your session.
- The CLI half uses only the promise-based `ui.dialog` helpers — no `@opentui` imports, no custom renderables, no JSX — so it needs no build step and stays plain JS. The one place that takes care is command registration: `keymap.layer()` needs a live Solid owner, so it is called from inside a headless `ui.slot({ append: "app" })` claim whose render returns `null`, which is how every builtin does it. Failures degrade to a toast; memory itself never depends on the CLI half.
- `engines.opencode` is deliberately **not** declared. opencode 2 betas version as `0.0.0-beta-<n>`, and semver compares that prerelease tag as a single string — so `beta-9999` sorts *above* `beta-19059` and any `>=` range breaks at a digit-count boundary. A constraint that silently excludes the runtime it was written for is worse than none; the `@opencode-ai/plugin` peer dependency carries the real floor.
- CI runs `tsc` as a checker over the plain JavaScript (`checkJs`, `noEmit`). Misusing opencode's API — a wrong argument shape, a field that does not exist on a `Session` — fails the build instead of failing silently inside a `try/catch`. That is not hypothetical: it is how the two bugs in `0.1.0`'s provenance lookup were found.

## License

MIT
