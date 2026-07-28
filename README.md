# Marginalia

Persistent memory for [opencode](https://opencode.ai) agents — notes in the margins of your codebase.

Plain markdown files. Git-backed. No vector database, no Python, no daemon, and no extra LLM calls.

```
opencode plugin opencode-marginalia@0.1.0 -g
```

Then restart opencode. Nothing is written until something is actually worth remembering.

> **Pin the version.** opencode caches plugins by the literal spec string you write and *never re-resolves it*. A bare `"opencode-marginalia"` becomes `@latest` exactly once, then stays frozen at that version forever — even across `opencode upgrade`. Always install an explicit version, and see [Updating](#updating).

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

Because opencode freezes plugin versions permanently, upgrading is deliberate:

```
opencode plugin opencode-marginalia@<new-version> --force   # then restart opencode
```

`/memory version` tells you when a newer release exists. To be told automatically instead — once per day, silent on failure — set:

```
MARGINALIA_UPDATE_CHECK=1
```

## Configuration

| Variable | |
|---|---|
| `MARGINALIA_DIR` | storage location (default `~/.local/share/marginalia`) |
| `MARGINALIA_UPDATE_CHECK=1` | enable the daily update check (off by default) |
| `OPENCODE_DB` | opencode database used by `/memory why` |

## Requirements

opencode ≥ 1.18. The `marginalia` CLI needs Bun **or** Node ≥ 22.5; `/memory` and the agent-facing tools do not.

## About `tui.json`

Marginalia has two halves — the memory engine and the `/memory` modal — and opencode registers them in two different files. `opencode plugin` handles both for you:

```
opencode plugin opencode-marginalia@0.1.0 -g

  Detected server + tui targets
  Added to ~/.config/opencode/opencode.json     ← tools, capture, injection
  Added to ~/.config/opencode/tui.json          ← the /memory modal
```

**`tui.json` is opencode's own config file, not something this plugin introduces.** It holds your theme, keybinds, `attention`, `mouse`, `scroll_speed`, `diff_style` and so on — opencode split these out of `opencode.json` at some point, with a one-time migration that leaves a `.tui-migration.bak`. If you already have one, installing only appends to its `plugin` array: the file is patched in place and comments, formatting and trailing commas are preserved. Nothing is overwritten.

Installing by hand means adding the package to both files:

```jsonc
// ~/.config/opencode/opencode.json      // ~/.config/opencode/tui.json
{ "plugin": ["opencode-marginalia"] }    { "plugin": ["opencode-marginalia"] }
```

Two quirks worth knowing, both opencode's rather than this plugin's:

- `tui.json` and `tui.jsonc` are equivalent, and the installer writes to whichever already exists. If you somehow have **both**, it picks `tui.json` — keep only one.
- If `/memory` ever stops appearing, check the `/plugins` dialog. Toggling a plugin there writes to a key-value store that silently **overrides** `tui.json`.

The server half works on its own. Without the `tui.json` entry you lose `/memory`; memory itself, the tools and path-scoped injection are unaffected.

## Development

```bash
git clone https://github.com/lsequeiraa/marginalia && cd marginalia
bun install
bun test          # 190 tests
bun run typecheck # tsc as a checker; no build step, no emit
```

Point opencode at the working copy — use the **directory**, so resolution goes through `exports["./server"]` exactly as it will for published installs:

```jsonc
// ~/.config/opencode/opencode.json   -> tools, memory, injection
{ "plugin": ["/absolute/path/to/marginalia"] }
// ~/.config/opencode/tui.json        -> the /memory modal
{ "plugin": ["/absolute/path/to/marginalia"] }
```

Do not also symlink it into `~/.config/opencode/plugins/` — the auto-scan and the `plugin` array are not deduplicated against each other and it would load twice. opencode does not hot-reload plugins; restart to pick up changes.

## Design notes

- The injected block is **pushed** as a separate system entry, never written over `system[0]`. `system[0]` holds the entire base prompt, and opencode gives prompt-cache breakpoints to the first *two* system messages — so pushing exactly one entry keeps memory inside the cache window. Pushing more, or rewriting index 0, silently disables the merge that keeps it there.
- The rendered block is cached per session and rebuilt only on compaction, so a memory write mid-session does not bust the KV cache.
- Path-scoped injection is deduplicated per session and re-armed after compaction.
- Every hook is wrapped in `try/catch`. A bug in a memory plugin must never break your session.
- The TUI half uses only opencode's five high-level dialog components — no `@opentui` imports, no custom renderables, no JSX — so it needs no build step and presents the smallest possible surface to an undocumented API. It capability-probes on open and degrades to a toast; memory itself never depends on the TUI.
- `engines.opencode` is declared, but it is a soft gate: opencode enforces it only for npm-installed plugins on a released binary, and ignores it for path plugins and dev builds.
- CI runs `tsc` as a checker over the plain JavaScript (`checkJs`, `noEmit`). Misusing opencode's API — a wrong argument shape, a field that does not exist on a `Session` — fails the build instead of failing silently inside a `try/catch`. That is not hypothetical: it is how the two bugs in `0.1.0`'s provenance lookup were found.

## License

MIT
