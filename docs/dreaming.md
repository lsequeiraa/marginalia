# Dreaming

A session writes memory in the moment, guessing what will matter before it knows. Some notes are wrong from the start, some go stale, and what a session learned often never gets written down. `marginalia dream` is the offline pass that fixes this with hindsight, after Anthropic's [write-up on agent memory](https://www.anthropic.com/research/components-of-agent-memory).

```
marginalia dream --dry-run                                  # prepare the inputs, call no model
marginalia dream --model anthropic/claude-opus-5-5          # sessions since the last dream (or 14 days)
marginalia dream --model anthropic/claude-opus-5-5 --effort xhigh --days 7
```

- [What a dream does](#what-a-dream-does)
- [Flags](#flags)
- [Which models a dream will use](#which-models-a-dream-will-use)
- [Containment](#containment)
- [Cost and scheduling](#cost-and-scheduling)

## What a dream does

It reads recent session transcripts from opencode's database (read-only) and hands them to a model, beside a checkout of the store, with a list of what each session wrote and read, and how memory has been used: how much of each index session start shows, which topics get read, and globs that match nothing. The model then:

1. corrects notes against the transcript that produced them, and notes later sessions contradicted;
2. saves what sessions learned and did not write down: corrections, preferences, traps, dead ends;
3. merges duplicates, moves detail into topic files, and orders each index so what every session should see is at the top;
4. treats transcripts as data, and flags anything in them that tries to give an agent instructions.

The result is checked rather than trusted, then applied as one commit in the memory repository, with the model's report as the commit message. `git revert` undoes it. Nothing asks you first; the commit and its report are how you audit it.

## Flags

| Flag | |
|---|---|
| `--model <ref>` | `provider/model[#variant]`. Required, except with `--dry-run` |
| `--effort <level>` | how hard the model thinks, such as `low`, `medium`, `high`, `xhigh`, `max` |
| `--allow-free-model` | let `--model` be a free model |
| `--since <date>` | sessions since this date (default: since the last dream, or the last 14 days) |
| `--days <n>` | sessions from the last n days |
| `--max-sessions <n>` | at most this many transcripts (default 40) |
| `--max-kb <n>` | at most this much transcript text, in KB (default 2000) |
| `--standalone` | run on a private opencode server instead of the background one |
| `--dry-run` | prepare the inputs and stop before calling the model |
| `--keep` | keep the run's workspace, which holds copies of transcripts |

`--effort` takes one of the levels opencode lists for the model (its "variants": `low` to `max` on current Claude models). `--model anthropic/claude-opus-5-5#xhigh` says the same. The level is checked against that list before anything is read, and the session's record is checked afterwards; a step that ran at another level is noted in the output and the commit. Without it, opencode sends no effort setting and the provider's default applies, which Anthropic documents as medium for Claude Opus 5.5 and Haiku 5.5 and high for other models. Higher effort is slower and costs more.

## Which models a dream will use

A dream sends your transcripts and memory to a model, so you always name that model with `--model`, and by default it is never a free one. Free tiers are where providers are most likely to keep and train on what they get, and a free model is what opencode falls back to when nothing better resolves.

Before anything is read, the run is refused if:

- the model's id ends in `-free` or `:free`;
- the opencode server's catalog (`opencode api get /api/model`) does not have it, has it disabled, or lists it at no cost. Prices decide as well as names, because some free models don't say so in their id (opencode's `big-pickle`).

Private servers started with `--standalone` also get `OPENCODE_DISABLE_FREE_MODELS=1`, so no fallback can pick a free model. Afterwards the session is read back, and if any step was answered by another model, the result is not applied and you are told which.

**Self-hosted models.** A model you run yourself (Ollama, LM Studio, anything OpenAI-compatible) lists at no cost too, but that is not a free tier, so it needs no flag. A model counts as self-hosted when its provider's endpoint (`settings.baseURL` in opencode's provider list) resolves only to this machine or a private network: loopback, RFC 1918, link-local, CGNAT/Tailscale, or IPv6 unique-local. A home domain with split DNS counts by the address it resolves to here.

Ollama can also list "cloud" models that it forwards to ollama.com. Those are spotted by their `remote_host` in Ollama's tag list, or a name ending in `cloud`, and count as hosted. Marginalia sees only the first hop, and says so when it starts: a local proxy that forwards to a hosted model looks self-hosted.

**Opting in to a free model.** If you accept the trade, `--allow-free-model` lets `--model` be a free one. It lifts only that refusal: the model must still be named, be in the catalog and enabled, and be the one that answers, and the run starts by saying where your data is going.

## Containment

Containment matters too, because transcripts include whatever the agent read on the web. The dream runs as a hidden `marginalia-dream` agent that the server plugin registers. Every action is denied except reading files and editing its own checkout of the store, so it has no shell, network, subagents, MCP or memory tools.

The check afterwards refuses anything but `.md` files in the store's existing directories, lints every entry the model wrote, and refuses a result that removes more than half the store. Entries the model wrote record it as their author, with its session.

## Cost and scheduling

It costs what the model costs: a two-week window is up to 40 transcripts and 2MB of text by default (`--max-sessions`, `--max-kb`).

It runs on the background opencode server, which must have loaded this version of Marginalia, or on a private one with `--standalone`.

A dream's workspace holds copies of transcripts, so it is deleted when the dream succeeds (keep it with `--keep`). A failed dream keeps it for inspection and says where. The last dream's state and report live in `.dream/` inside the store, which git ignores.

Run it by hand until you trust its commits. After that, a nightly timer works too: it picks up where the last dream stopped.
