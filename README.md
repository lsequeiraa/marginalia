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
Memory                                    1.3KB ≈321 tokens
> ▏search…
  About you
    · Prefers surgical diffs over refactors            2026-07-27
  endfield-calc
    · Test: `bun vitest run`                           2026-07-27
    ✗ Memoizing the belt solver gave no gain           2026-07-01
    · Worktrees live on /mnt/d              [unverified since 2026-01]
  Topic files
    ▸ solver-perf.md   auto-loads for src/solver/**
  ─────
    History · Version · Storage folder
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

`opencode plugin` writes both halves of the package automatically — the server plugin to `opencode.json` and the `/memory` modal to `tui.json`. Installing by hand means adding it to both:

```jsonc
// ~/.config/opencode/opencode.json      // ~/.config/opencode/tui.json
{ "plugin": ["opencode-marginalia"] }    { "plugin": ["opencode-marginalia"] }
```

If `/memory` ever stops appearing, check opencode's `/plugins` dialog: toggling a plugin there writes to a key-value store that silently **overrides** `tui.json`.

## Development

```bash
git clone https://github.com/lsequeiraa/marginalia && cd marginalia
bun install && bun test
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

- The injected block is pushed as a **separate** system entry and never mutates `system[0]`, which is the provider's prompt-cache prefix.
- The rendered block is cached per session and rebuilt only on compaction, so a memory write mid-session does not bust the KV cache.
- Path-scoped injection is deduplicated per session and re-armed after compaction.
- Every hook is wrapped in `try/catch`. A bug in a memory plugin must never break your session.
- The TUI half uses only opencode's five high-level dialog components — no `@opentui` imports, no custom renderables, no JSX — so it needs no build step and presents the smallest possible surface to an undocumented API. It capability-probes on open and degrades to a toast; memory itself never depends on the TUI.

## License

MIT
