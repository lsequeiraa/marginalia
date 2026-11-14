#!/usr/bin/env node
// Marginalia — read-only inspector.
//   marginalia inspect        what is loaded, and what it costs
//   marginalia why <text>     which conversation taught me this
//   marginalia log [n]        what has been learned, in order
//   marginalia version        installed vs latest on npm
//   marginalia path           print the storage directory
//   marginalia dream [flags]  review memory against recent sessions (calls a model)
import path from "node:path"
import * as core from "./core.js"
import * as store from "./store.js"
import { DEFAULTS, dream } from "./dream.js"
import { firstUserText, openDb, sessionInfo } from "./transcripts.js"

const MEM_DIR = store.MEM_DIR

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)

const repoRoot = store.repoRootFor(process.cwd())
const dirs = store.dirsFor(repoRoot)
const loadScope = (scope) => store.loadScope(dirs, scope)

// --------------------------------------------------------------------- inspect

async function inspect() {
  const u = await loadScope("user")
  const g = await loadScope("global")
  const p = await loadScope("project")
  const now = new Date()
  const topics = [...u.topics, ...g.topics, ...p.topics]
  const block = core.renderBlock({
    userEntries: u.entries,
    globalEntries: g.entries,
    projectEntries: p.entries,
    projectName: path.basename(repoRoot),
    topics,
    relevant: store.relevantFor(store.toplevelFor(process.cwd()), topics),
    now,
  })

  const out = []
  out.push(`storage   ${MEM_DIR}`)
  out.push(`project   ${path.basename(repoRoot)}  (${repoRoot})`)
  out.push(`injected  ${kb(block.bytes)} ≈${block.approxTokens} tokens${block.truncated ? "  [TRUNCATED — prune]" : ""}`)
  out.push("")

  for (const { label, s } of [
    { label: "user", s: u },
    { label: "global", s: g },
    { label: "project", s: p },
  ]) {
    const limits = core.checkIndexLimits(s.index)
    const shown = block.sections[label]
    const visible = shown.shown < shown.total ? `, ${shown.shown} shown at session start` : ""
    out.push(`── ${label}  ${s.entries.length} entries${visible}, ${kb(limits.bytes)}, ${limits.lines} lines`)
    if (limits.message) out.push(`   ! ${limits.message}`)
    if (!s.entries.length) out.push("   (empty)")
    for (const e of s.entries) {
      const stale = core.isStale(e, now, core.staleDaysFor(label)) ? "  [unverified]" : ""
      out.push(`   ${e.negative ? "✗" : "·"} ${e.text}${e.date ? `  [${e.date}]` : ""}${stale}`)
    }
    if (s.topics.length) {
      out.push("")
      for (const t of s.topics) {
        out.push(`   ▸ ${t.scope}/${t.file}  ${kb(t.bytes)}  ${t.description || "(no description)"}`)
        if (t.paths.length) out.push(`     auto-loads for ${t.paths.join(", ")}`)
      }
    }
    out.push("")
  }
  return out.join("\n").trimEnd()
}

// ------------------------------------------------------------------------- why

async function why(query) {
  if (!query) return "usage: marginalia why <text>"
  const needle = query.toLowerCase()
  const matches = []
  for (const scope of ["user", "global", "project"]) {
    for (const e of (await loadScope(scope)).entries) {
      if (e.text.toLowerCase().includes(needle)) matches.push({ ...e, scope })
    }
  }
  if (!matches.length) return `No memory entry matching "${query}".`

  const db = await openDb()
  const out = []
  for (const m of matches) {
    out.push(`${m.negative ? "✗" : "·"} ${m.text}`)
    out.push(`  ${m.scope}${m.date ? `  learned ${m.date}` : ""}${m.agent ? `  by ${m.agent}` : ""}`)
    if (!m.session) {
      out.push("  (no source session recorded — added by hand or before provenance)")
    } else if (!db) {
      out.push(`  session ${m.session} (database unavailable)`)
    } else {
      const s = sessionInfo(db, m.session)
      if (!s) {
        out.push(`  session ${m.session} (no longer in the database)`)
      } else {
        out.push(`  from "${s.title}"  ${new Date(s.created).toISOString().slice(0, 16).replace("T", " ")}`)
        out.push(`  ${s.directory}`)
        out.push(`  resume: opencode --session ${s.id}`)
        const text = firstUserText(db, s.id)
        if (text) out.push(`  opened with: ${text.replace(/\s+/g, " ").slice(0, 160)}`)
      }
    }
    out.push("")
  }
  db?.close()
  return out.join("\n").trimEnd()
}

// ------------------------------------------------------------------------- log

function log(n) {
  const out = store.git(["log", "--no-decorate", "--date=short", "--format=%ad %s", "-n", String(Number(n) || 20)], MEM_DIR)
  if (out === null) return "No memory history yet (nothing has been written)."
  return out || "No memory history yet."
}

// --------------------------------------------------------------------- version

// Reports installed vs latest on npm. opencode 2 tracks plugin versions itself
// (`opencode plugin check` / `update`); this stays because it also works when
// marginalia is used standalone, outside opencode.
async function version() {
  const { name, version: current } = await store.manifest()
  const lines = [`${name} ${current}`, `runtime  ${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`}`]
  try {
    const latest = await store.latestVersion(name)
    lines.push(
      latest === current
        ? "up to date"
        : `UPDATE AVAILABLE: ${latest}\n  opencode plugin add ${name}@${latest}   (then restart opencode)`,
    )
  } catch {
    lines.push("could not determine the latest version (offline, or not yet published)")
  }
  return lines.join("\n")
}

// ------------------------------------------------------------------------ main

const DREAM_HELP = `marginalia dream: review memory against recent sessions, with hindsight

Reads the transcripts of recent opencode sessions beside the memory store and
has a model correct what they got wrong, save what they missed and keep the top
of each index for what every session should see. The result is checked, then
applied as one commit in the memory repository; git revert undoes it.

This sends your transcripts and memory to a model, through opencode, and costs
what that model costs. The model is never a default and never a free one: name
it with --model, and a model the server's catalog lists at no cost is refused.
Afterwards the session is read back, and if any step ran on another model the
result is not applied.

  --model <ref>      provider/model[#variant], required (not for --dry-run)
  --since <date>     sessions since this date (default: since the last dream,
                     or the last ${DEFAULTS.days} days)
  --days <n>         sessions from the last n days
  --max-sessions <n> at most this many transcripts (default ${DEFAULTS.maxSessions})
  --max-kb <n>       at most this much transcript text (default ${DEFAULTS.maxKB})
  --standalone       run on a private opencode server instead of the background one
  --dry-run          prepare the inputs and stop before calling the model
  --keep             keep the run's workspace (it holds copies of transcripts)`

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i])
    if (!m) return { error: `unexpected argument "${args[i]}"` }
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (["standalone", "dryRun", "keep", "help"].includes(key)) flags[key] = true
    else if (["since", "days", "model", "maxSessions", "maxKb"].includes(key)) {
      const value = m[2] ?? args[++i]
      if (value === undefined) return { error: `--${m[1]} needs a value` }
      flags[key] = value
    } else return { error: `unknown flag --${m[1]}` }
  }
  return { flags }
}

async function runDream(args) {
  const { flags, error } = parseFlags(args)
  if (error) {
    console.log(`${error}\n\n${DREAM_HELP}`)
    return 1
  }
  if (flags.help) {
    console.log(DREAM_HELP)
    return 0
  }
  if (!flags.dryRun && !flags.model) {
    console.log(`--model is required: a dream sends your transcripts and memory to it.\n\n${DREAM_HELP}`)
    return 1
  }
  for (const key of ["days", "maxSessions", "maxKb"])
    if (flags[key] !== undefined && !(Number(flags[key]) > 0)) {
      console.log(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a positive number`)
      return 1
    }
  const number = (v) => (v === undefined ? undefined : Number(v))
  return dream({
    since: flags.since,
    days: number(flags.days),
    model: flags.model,
    maxSessions: number(flags.maxSessions),
    maxKB: number(flags.maxKb),
    standalone: flags.standalone,
    dryRun: flags.dryRun,
    keep: flags.keep,
  })
}

const [cmd = "inspect", ...rest] = process.argv.slice(2)
if (cmd === "dream") {
  process.exitCode = await runDream(rest)
} else {
  const run = {
    inspect: () => inspect(),
    why: () => why(rest.join(" ").trim()),
    log: () => log(rest[0]),
    version: () => version(),
    path: () => MEM_DIR,
  }[cmd]
  console.log(run ? await run() : `unknown command "${cmd}" — use inspect | why <text> | log [n] | version | path | dream`)
}
