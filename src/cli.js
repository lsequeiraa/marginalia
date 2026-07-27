#!/usr/bin/env node
// Marginalia — read-only inspector.
//   marginalia inspect        what is loaded, and what it costs
//   marginalia why <text>     which conversation taught me this
//   marginalia log [n]        what has been learned, in order
//   marginalia version        installed vs latest on npm
//   marginalia path           print the storage directory
//
// Runs under either Bun or Node: bun:sqlite and node:sqlite are mutually
// exclusive built-ins, so the driver is selected at runtime.
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as core from "./core.js"

const MEM_DIR = process.env.MARGINALIA_DIR || path.join(os.homedir(), ".local/share/marginalia")
const DB_PATH = process.env.OPENCODE_DB || path.join(os.homedir(), ".local/share/opencode/opencode.db")

const read = (p) => fs.readFile(p, "utf8").then((s) => s, () => null)
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

const repoRoot = (() => {
  const out = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], process.cwd())
  return out ? path.dirname(out) : process.cwd()
})()

const dirs = {
  global: path.join(MEM_DIR, "global"),
  project: path.join(MEM_DIR, "projects", core.projectKey(repoRoot)),
}

async function loadScope(scope) {
  const index = (await read(path.join(dirs[scope], "MEMORY.md"))) ?? ""
  const entries = core.entriesOf(core.parseMemoryFile(index))
  const topics = []
  for (const file of (await fs.readdir(dirs[scope]).then((n) => n, () => [])).sort()) {
    if (!file.endsWith(".md") || file === "MEMORY.md" || file.includes(".tmp-")) continue
    const content = (await read(path.join(dirs[scope], file))) ?? ""
    const { data, body } = core.parseFrontmatter(content)
    topics.push({ scope, file, bytes: Buffer.byteLength(content, "utf8"), description: data.description || "", paths: data.paths || [], body })
  }
  return { index, entries, topics }
}

// Both drivers expose prepare() -> { get(...p), all(...p) }; only construction
// and the readonly option name differ.
async function openDb() {
  try {
    if (typeof Bun !== "undefined") {
      const { Database } = await import("bun:sqlite")
      return new Database(DB_PATH, { readonly: true })
    }
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(DB_PATH, { readOnly: true })
  } catch {
    return null
  }
}

// --------------------------------------------------------------------- inspect

async function inspect() {
  const g = await loadScope("global")
  const p = await loadScope("project")
  const now = new Date()
  const block = core.renderBlock({
    globalEntries: g.entries,
    projectEntries: p.entries,
    projectName: path.basename(repoRoot),
    topics: [...g.topics, ...p.topics],
    now,
  })

  const out = []
  out.push(`storage   ${MEM_DIR}`)
  out.push(`project   ${path.basename(repoRoot)}  (${repoRoot})`)
  out.push(`injected  ${kb(block.bytes)} ≈${block.approxTokens} tokens${block.truncated ? "  [TRUNCATED — prune]" : ""}`)
  out.push("")

  for (const [label, s] of [["global", g], ["project", p]]) {
    const limits = core.checkIndexLimits(s.index)
    out.push(`── ${label}  ${s.entries.length} entries, ${kb(limits.bytes)}, ${limits.lines} lines`)
    if (limits.message) out.push(`   ! ${limits.message}`)
    if (!s.entries.length) out.push("   (empty)")
    for (const e of s.entries) {
      const stale = core.isStale(e, now) ? "  [unverified]" : ""
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
  for (const scope of ["global", "project"]) {
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
      const s = db.prepare("SELECT id, title, directory, time_created FROM session WHERE id = ?").get(m.session)
      if (!s) {
        out.push(`  session ${m.session} (no longer in the database)`)
      } else {
        out.push(`  from "${s.title}"  ${new Date(s.time_created).toISOString().slice(0, 16).replace("T", " ")}`)
        out.push(`  ${s.directory}`)
        out.push(`  resume: opencode --session ${s.id}`)
        const msg = db
          .prepare("SELECT id FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'user' ORDER BY time_created LIMIT 1")
          .get(s.id)
        if (msg) {
          const part = db.prepare("SELECT data FROM part WHERE message_id = ? LIMIT 8").all(msg.id)
          const text = part.map((r) => JSON.parse(r.data)).find((d) => d.type === "text" && d.text)?.text
          if (text) out.push(`  opened with: ${text.replace(/\s+/g, " ").slice(0, 160)}`)
        }
      }
    }
    out.push("")
  }
  db?.close()
  return out.join("\n").trimEnd()
}

// ------------------------------------------------------------------------- log

function log(n) {
  const out = git(["log", "--no-decorate", "--date=short", "--format=%ad %s", "-n", String(Number(n) || 20)], MEM_DIR)
  if (out === null) return "No memory history yet (nothing has been written)."
  return out || "No memory history yet."
}

// --------------------------------------------------------------------- version

// opencode caches plugins by literal spec string and never re-resolves, so an
// install stays frozen at whatever version it was first fetched at. This is the
// on-demand equivalent of the opt-in MARGINALIA_UPDATE_CHECK.
async function version() {
  const manifest = await read(fileURLToPath(new URL("../package.json", import.meta.url)))
  const { name, version: current } = manifest ? JSON.parse(manifest) : { name: "opencode-marginalia", version: "unknown" }
  const lines = [`${name} ${current}`, `runtime  ${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`}`]
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(5000) })
    const latest = (await res.json())?.version
    if (!latest) throw new Error("no version in registry response")
    lines.push(
      latest === current
        ? "up to date"
        : `UPDATE AVAILABLE: ${latest}\n  opencode plugin ${name}@${latest} --force   (then restart opencode)`,
    )
  } catch {
    lines.push("could not determine the latest version (offline, or not yet published)")
  }
  return lines.join("\n")
}

// ------------------------------------------------------------------------ main

const [cmd = "inspect", ...rest] = process.argv.slice(2)
const run = {
  inspect: () => inspect(),
  why: () => why(rest.join(" ").trim()),
  log: () => log(rest[0]),
  version: () => version(),
  path: () => MEM_DIR,
}[cmd]

console.log(run ? await run() : `unknown command "${cmd}" — use inspect | why <text> | log [n] | version | path`)
