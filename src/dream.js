// `marginalia dream`: an offline pass over memory, with hindsight.
//
// Agents write memory in the moment, judging what will matter before they know.
// A dream reads recent session transcripts beside the store and fixes what the
// sessions got wrong, saves what they missed, and keeps the top of each index
// for what every session should see. It is a separate, explicit run that costs
// model calls; nothing in a session's own path does.
//
// The model works on a copy: a git worktree of the memory repository on a
// branch of its own, beside the transcripts and usage figures this file writes
// for it, run as the locked-down `marginalia-dream` agent (core.DREAM_PERMISSIONS).
// Its result is checked here rather than trusted, given its own provenance, and
// merged back as one commit, which `git revert` undoes. A merge that conflicts
// with what live sessions wrote meanwhile is left on its branch, unmerged.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as core from "./core.js"
import * as store from "./store.js"
import { knownDirectories, memoryCalls, openDb, recentSessions, renderTranscript, topicInjections } from "./transcripts.js"

const DAY = 86_400_000
export const DEFAULTS = { days: 14, usageDays: 30, maxSessions: 40, maxKB: 2000, transcriptKB: 60, fixRounds: 2 }

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const quote = (s, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`
}

// ------------------------------------------------------------------ selection

const WRITES = new Set(["memory_append", "memory_write", "memory_edit"])

// Which sessions are worth a transcript. Writing memory matters most, since
// those notes are what a dream checks; then how much the user said, since
// corrections and preferences live there. A subagent's session is included
// only when it wrote memory: its prompt comes from another agent, and what the
// user said is in its parent.
export function selectSessions(sessions, calls, { maxSessions = DEFAULTS.maxSessions } = {}) {
  const writes = new Map()
  for (const c of calls) if (WRITES.has(c.name)) writes.set(c.session, (writes.get(c.session) ?? 0) + 1)
  return sessions
    .map((s) => ({ ...s, writes: writes.get(s.id) ?? 0 }))
    .filter((s) => s.writes > 0 || (!s.parent && s.users > 0))
    .map((s) => ({ ...s, score: (s.writes ? 1000 + s.writes * 10 : 0) + s.users * 2 + (s.parent ? 0 : 3) }))
    .sort((a, b) => b.score - a.score || b.updated - a.updated)
    .slice(0, maxSessions)
}

// ------------------------------------------------------------------- manifests

function describeCall(c) {
  const i = c.input ?? {}
  const where = `${i.scope ?? "?"}/${i.file ?? "MEMORY.md"}`
  const result = c.ok ? c.output.split("\n")[0] : "(failed)"
  if (c.name === "memory_append") return `memory_append ${i.scope ?? "?"}${i.negative ? " ✗" : ""} ${quote(i.entry, 220)} → ${result}`
  if (c.name === "memory_write")
    return `memory_write ${where}${i.paths?.length ? ` paths ${JSON.stringify(i.paths)}` : ""}${i.description ? ` ${quote(i.description, 120)}` : ""} → ${result}`
  if (c.name === "memory_edit") return `memory_edit ${where} ${quote(i.old, 120)} → ${quote(i.new, 160)} → ${result}`
  return `${c.name} ${JSON.stringify(i)}`
}

/**
 * @param {any[]} chosen sessions from selectSessions, with transcript sizes
 * @param {any[]} calls memoryCalls over the same window
 * @param {{ since?: string, skipped?: number }} [options]
 */
export function formatSessions(chosen, calls, { since = "", skipped = 0 } = {}) {
  const bySession = new Map()
  for (const c of calls) (bySession.get(c.session) ?? bySession.set(c.session, []).get(c.session)).push(c)
  const out = [`# Sessions since ${since}`, ""]
  out.push(
    `${chosen.length} sessions, oldest first. Later sessions can supersede earlier ones.` +
      (skipped ? ` ${skipped} more were left out (no memory written and little said, or over the limit).` : ""),
    "",
  )
  for (const s of chosen.slice().sort((a, b) => a.created - b.created)) {
    out.push(`## ${day(s.created)} ${s.id} ${quote(s.title, 100)}`)
    out.push(`${s.agent ?? "?"} agent · ${s.users} user ${s.users === 1 ? "message" : "messages"}${s.parent ? ` · subagent of ${s.parent}` : ""} · ${s.directory}`)
    if (s.projectMemory) out.push(`project memory: ${s.projectMemory}${s.projectExists ? "" : " (none yet)"}`)
    out.push(s.transcript ? `transcript: ${s.transcript} (${kb(s.bytes)})` : "transcript: not available")
    const mine = bySession.get(s.id) ?? []
    const wrote = mine.filter((c) => WRITES.has(c.name))
    if (wrote.length) {
      out.push("wrote:")
      for (const c of wrote) out.push(`  ${describeCall(c)}`)
    }
    const reads = new Map()
    for (const c of mine) {
      if (c.name !== "memory_read" && c.name !== "memory_search") continue
      const key = c.name === "memory_search" ? `search ${quote(c.input?.query, 60)}` : `${c.input?.scope ?? "?"}/${c.input?.file ?? "MEMORY.md"}`
      reads.set(key, (reads.get(key) ?? 0) + 1)
    }
    if (reads.size) out.push(`read: ${[...reads].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ")}`)
    out.push("")
  }
  return out.join("\n").trimEnd() + "\n"
}

/**
 * @param {{ since: string, today: string, sections: string[], topics: any[], reads: Map<string, {calls: number, sessions: Set<string>}>,
 *           loaded: Map<string, number>, dead: { file: string, globs: string[] }[], repos: string[], sessionsReading: number }} u
 */
export function formatUsage(u) {
  const out = [`# Memory usage, ${u.since} to ${u.today}`, ""]
  out.push("## What the session-start block shows", "")
  out.push(...u.sections, "")
  out.push(
    "Each index is shown from the top until its share of the block runs out, so",
    "the entries past the cut are seen only by a session that searches for them.",
    "",
  )
  out.push(`## Topic files (${u.sessionsReading} sessions read memory in this window)`, "")
  out.push(
    "read = memory_read calls (distinct sessions); loaded = times reading a matching",
    "file loaded it.",
    "",
  )
  if (![...u.loaded.values()].some(Boolean))
    out.push("No topic loaded by glob at all in this window, so a loaded 0 says nothing about a topic.", "")
  const rows = u.topics
    .map((t) => {
      const id = `${t.scope}/${t.file}`
      const r = u.reads.get(id)
      return { id, t, calls: r?.calls ?? 0, sessions: r?.sessions.size ?? 0, loaded: u.loaded.get(id) ?? 0 }
    })
    .sort((a, b) => b.sessions - a.sessions || b.calls - a.calls || a.id.localeCompare(b.id))
  for (const r of rows.filter((r) => r.calls || r.loaded))
    out.push(`${r.id}  ${kb(r.t.bytes)}  read ${r.calls} (${r.sessions})  loaded ${r.loaded}${r.t.changed ? `  changed ${r.t.changed}` : ""}`)
  const never = rows.filter((r) => !r.calls && !r.loaded)
  if (never.length) out.push("", `Not read at all: ${never.map((r) => r.id).join(", ")}`)
  const indexes = [...u.reads].filter(([id]) => id.endsWith("/MEMORY.md"))
  if (indexes.length)
    out.push("", `Indexes opened with memory_read: ${indexes.map(([id, r]) => `${id} ${r.calls} (${r.sessions.size})`).join(", ")}`)
  out.push("", "## Globs that match nothing", "")
  if (!u.repos.length) out.push("No repository from these sessions could be checked.")
  else {
    out.push(`Checked against the tracked files of the ${u.repos.length} repositories sessions have worked in,`)
    out.push("relative to each and as absolute paths. A glob for files outside any repository")
    out.push("(under ~/.config, say) cannot be checked this way and may be fine.", "")
    if (!u.dead.length) out.push("None.")
    for (const d of u.dead) out.push(`${d.file}: ${d.globs.join(", ")}`)
  }
  return out.join("\n") + "\n"
}

// The report's first line as a commit title: no heading marks, lower-case
// first letter after "dream: ", and cut at a word under 72 characters.
export function commitTitle(line) {
  let t = String(line ?? "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().replace(/\.$/, "")
  if (/^[A-Z][a-z]/.test(t)) t = t[0].toLowerCase() + t.slice(1)
  const max = 72 - "dream: ".length
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length).replace(/[,;:]$/, "")}…`
}

// ----------------------------------------------------------------------- shell

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts })
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || r.error?.message || "" }
}

const gitIn = (cwd) => (...args) => sh("git", args, { cwd })

async function exists(p) {
  return fs.stat(p).then(() => true, () => false)
}

// The repository a session ran in, found from the nearest directory that still
// exists: a removed linked worktree resolves through its parent, which is
// inside the repository it belonged to.
async function repoOf(dir) {
  let d = dir
  while (d && !(await exists(d))) {
    const up = path.dirname(d)
    if (up === d) return { repoRoot: dir, toplevel: null }
    d = up
  }
  if (!store.git(["rev-parse", "--git-dir"], d)) return { repoRoot: dir, toplevel: null }
  return { repoRoot: store.repoRootFor(d), toplevel: d === dir ? store.toplevelFor(d) : store.repoRootFor(d) }
}

// When each file in the store last changed, from its history: a fresh checkout
// sets every mtime to now.
function lastChanged(cwd) {
  const out = store.git(["log", "--format=%x00%cs", "--name-only"], cwd) ?? ""
  const when = new Map()
  let date = ""
  for (const line of out.split("\n")) {
    if (line.startsWith("\0")) date = line.slice(1)
    else if (line && !when.has(line)) when.set(line, date)
  }
  return when
}

// Every file in the store but git's own, as store-relative path -> content.
async function snapshot(root) {
  const out = new Map()
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".git") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.set(path.relative(root, full).split(path.sep).join("/"), await fs.readFile(full, "utf8"))
    }
  }
  await walk(root)
  return out
}

// ------------------------------------------------------------------- opencode

// Runs one turn of the dream agent and reports what it did as it goes. Resolves
// with the session id and what the run cost. Without `session` it starts one.
/**
 * @param {{ opencode: string, cwd: string, prompt: string, model?: string, standalone?: boolean,
 *           session?: string, title?: string, log: (line: string) => void }} input
 * @returns {Promise<{ sessionID: string | null, cost: number, text: string, errors: string[], code: number | null }>}
 */
function runAgent({ opencode, cwd, prompt, model, standalone, session, title, log }) {
  const args = ["run", "--agent", core.DREAM_AGENT, "--auto", "--format", "json"]
  if (session) args.push("--session", session)
  else args.push("--archived", "--title", title)
  if (model) args.push("--model", model)
  if (standalone) args.push("--standalone")
  return new Promise((resolve) => {
    const child = spawn(opencode, args, { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let sessionID = session ?? null
    let cost = 0
    let text = ""
    let buffer = ""
    const errors = []
    let stderr = ""
    const handle = (line) => {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      sessionID ??= e.sessionID ?? null
      if (e.type === "tool_use") {
        const input = e.part?.state?.input ?? {}
        const target = input.path ?? input.pattern ?? input.query ?? ""
        log(`  ${e.part?.tool}${target ? ` ${String(target).slice(0, 100)}` : ""}${e.part?.state?.status === "error" ? "  (failed)" : ""}`)
      } else if (e.type === "step_finish") cost += Number(e.part?.cost) || 0
      else if (e.type === "text") text = e.part?.text ?? text
      else if (e.type === "error") errors.push(e.error?.message ?? e.error?.data?.message ?? JSON.stringify(e.error ?? e))
    }
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, i))
        buffer = buffer.slice(i + 1)
      }
    })
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => errors.push(error.message))
    child.on("close", (code) => {
      if (buffer) handle(buffer)
      if (code !== 0 && !errors.length) errors.push(stderr.trim() || `opencode exited with ${code}`)
      resolve({ sessionID, cost, text, errors, code })
    })
    child.stdin.end(prompt)
  })
}

function agentAvailable({ opencode, cwd, standalone }) {
  const r = sh(opencode, ["debug", "agents", ...(standalone ? ["--standalone"] : [])], { cwd })
  if (!r.ok) return { ok: false, why: r.err || "opencode debug agents failed" }
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf("[")))
    return { ok: list.some((a) => a.id === core.DREAM_AGENT), why: null }
  } catch {
    return { ok: false, why: "could not read the agent list" }
  }
}

// ------------------------------------------------------------------- the dream

/**
 * @param {{ since?: string, days?: number, maxSessions?: number, maxKB?: number, model?: string, standalone?: boolean,
 *           dryRun?: boolean, keep?: boolean, opencode?: string, log?: (line: string) => void, now?: Date }} [options]
 * @returns {Promise<number>} the process exit code
 */
export async function dream(options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const now = options.now ?? new Date()
  const opencode = options.opencode || process.env.MARGINALIA_OPENCODE || "opencode"
  const MEM = store.MEM_DIR
  const DREAM_DIR = path.join(MEM, ".dream")
  const mem = gitIn(MEM)

  await fs.mkdir(DREAM_DIR, { recursive: true })

  // One dream at a time. A lock whose process is gone is stale.
  const lock = path.join(DREAM_DIR, "lock")
  try {
    const pid = Number(await fs.readFile(lock, "utf8"))
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {}
    if (alive) {
      log(`Another dream is running (pid ${pid}).`)
      return 1
    }
  } catch {}
  await fs.writeFile(lock, String(process.pid))

  const cleanup = []
  try {
    // The repository the plugin keeps, with .dream/ ignored and nothing pending.
    if (!mem("rev-parse", "--git-dir").ok) {
      mem("init", "-q")
      if (!mem("config", "user.email").ok) {
        mem("config", "user.email", "opencode@localhost")
        mem("config", "user.name", "opencode")
      }
    }
    const ignore = (await store.read(path.join(MEM, ".gitignore"))) ?? ""
    const wanted = ["*.tmp-*", ".dream/"].filter((l) => !ignore.split("\n").includes(l))
    if (wanted.length) await fs.writeFile(path.join(MEM, ".gitignore"), `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${wanted.join("\n")}\n`)
    mem("add", "-A")
    mem("commit", "-q", "-m", "memory: before dream")
    if (!mem("rev-parse", "HEAD").ok) {
      log("The memory store is empty; there is nothing to dream about.")
      return 0
    }

    const statePath = path.join(DREAM_DIR, "state.json")
    const state = JSON.parse((await store.read(statePath)) ?? "{}")
    const sinceMs = options.since
      ? Date.parse(options.since)
      : options.days
        ? now.getTime() - options.days * DAY
        : state.lastRun
          ? Date.parse(state.lastRun)
          : now.getTime() - DEFAULTS.days * DAY
    if (!Number.isFinite(sinceMs)) {
      log(`Cannot read --since ${options.since}; use a date like 2026-11-01.`)
      return 1
    }

    const db = await openDb()
    if (!db) {
      log("Cannot open the opencode database (set OPENCODE_DB if it is not in the default place).")
      return 1
    }
    cleanup.push(() => db.close())

    log(`Reading sessions since ${day(sinceMs)}…`)
    const usageSince = Math.min(sinceMs, now.getTime() - DEFAULTS.usageDays * DAY)
    const calls = memoryCalls(db, usageSince)
    const recent = recentSessions(db, sinceMs, { exclude: (s) => s.agent === core.DREAM_AGENT })
    const inWindow = calls.filter((c) => c.at >= sinceMs)
    const chosen = selectSessions(recent, inWindow, { maxSessions: options.maxSessions ?? DEFAULTS.maxSessions })
    if (!chosen.length) {
      log(`No sessions since ${day(sinceMs)} wrote memory or had anything from the user. Nothing to do.`)
      await fs.writeFile(statePath, JSON.stringify({ ...state, lastRun: now.toISOString() }, null, 2))
      return 0
    }

    // The run's directory: the store checked out on a branch of its own, and
    // the inputs beside it. Transcripts are private copies; they go with it.
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const runDir = path.join(DREAM_DIR, "runs", stamp)
    const branch = `dream/${stamp}`
    await fs.mkdir(path.join(runDir, "sessions"), { recursive: true, mode: 0o700 })
    const base = mem("rev-parse", "HEAD").out
    const added = mem("worktree", "add", "-q", "-b", branch, path.join(runDir, "store"), base)
    if (!added.ok) {
      log(`Could not check out the store for the dream: ${added.err}`)
      return 1
    }
    const storeDir = path.join(runDir, "store")
    const removeTree = () => {
      mem("worktree", "remove", "--force", storeDir)
      mem("worktree", "prune")
    }

    // Transcripts, within the byte budget.
    const maxBytes = (options.maxKB ?? DEFAULTS.maxKB) * 1024
    let used = 0
    const included = []
    for (const s of chosen) {
      const t = renderTranscript(db, s.id, { maxBytes: DEFAULTS.transcriptKB * 1024 })
      if (!t || used + t.bytes > maxBytes) continue
      used += t.bytes
      await fs.writeFile(path.join(runDir, "sessions", `${s.id}.txt`), t.text, { mode: 0o600 })
      const { repoRoot, toplevel } = await repoOf(s.directory)
      const key = core.projectKey(repoRoot)
      included.push({
        ...s,
        transcript: `sessions/${s.id}.txt`,
        bytes: t.bytes,
        repoRoot,
        toplevel,
        projectMemory: `store/projects/${key}/MEMORY.md`,
        projectExists: await exists(path.join(storeDir, "projects", key)),
      })
    }
    const sinceDay = day(sinceMs)
    await fs.writeFile(
      path.join(runDir, "sessions.md"),
      formatSessions(included, inWindow, { since: sinceDay, skipped: recent.length - included.length }),
    )

    // Usage.
    const shared = []
    const entries = {}
    for (const scope of ["user", "global"]) {
      const loaded = await store.loadScope({ user: path.join(storeDir, "user"), global: path.join(storeDir, "global") }, scope)
      shared.push(...loaded.topics)
      entries[scope] = loaded.entries
    }
    const projectDirs = await fs.readdir(path.join(storeDir, "projects")).catch(() => [])
    const projects = []
    for (const key of projectDirs.sort()) {
      const loaded = await store.loadScope({ project: path.join(storeDir, "projects", key) }, "project")
      projects.push({ key, ...loaded })
    }
    // Project topics are named by their directory here, as the dream sees them.
    const changedOn = lastChanged(storeDir)
    const topics = [...shared, ...projects.flatMap((p) => p.topics.map((t) => ({ ...t, scope: `projects/${p.key}` })))].map((t) => ({
      ...t,
      changed: changedOn.get(`${t.scope}/${t.file}`) ?? "",
    }))
    // Globs are checked against every repository any session has worked in,
    // not only this window's: a topic for a project not touched lately is not
    // dead. Main checkouts only; linked worktrees track the same files.
    const repos = []
    const seenRepos = new Set()
    for (const dir of knownDirectories(db)) {
      if (!(await exists(dir))) continue
      const repoRoot = store.repoRootFor(dir)
      if (seenRepos.has(repoRoot) || !(await exists(path.join(repoRoot, ".git")))) continue
      seenRepos.add(repoRoot)
      repos.push({ repoRoot, toplevel: repoRoot })
    }
    const filesOf = new Map(
      repos.map((s) => [s.toplevel, (store.git(["ls-files"], s.toplevel) ?? "").split("\n").filter(Boolean).slice(0, 50_000)]),
    )
    const sections = []
    // As a session in that repository would see the block.
    const shown = (projectEntries, projectTopics, projectName, relevant) =>
      core.renderBlock({
        userEntries: entries.user,
        globalEntries: entries.global,
        projectEntries,
        projectName,
        topics: [...shared, ...projectTopics],
        relevant,
        now,
      }).sections
    const base0 = shown([], [], "project", new Set())
    const line = (file, s) => `${file}: ${s.total} ${s.total === 1 ? "entry" : "entries"}, ${s.shown >= s.total ? "all shown" : `the first ${s.shown} shown`}`
    sections.push(line("user/MEMORY.md", base0.user), line("global/MEMORY.md", base0.global))
    for (const p of projects) {
      if (!p.entries.length) continue
      const repo = repos.find((s) => core.projectKey(s.repoRoot) === p.key)
      const relevant = repo ? core.relevantTopics(shared, filesOf.get(repo.toplevel), { root: repo.toplevel, home: os.homedir() }) : new Set()
      const s = shown(p.entries, p.topics, path.basename(repo?.repoRoot ?? p.key), relevant)
      sections.push(`${line(`projects/${p.key}/MEMORY.md`, s.project)}${s.global.shown < base0.global.shown ? ` (and global drops to ${s.global.shown} there)` : ""}`)
    }
    const reads = new Map()
    const repoKeys = new Map()
    const sessionsReading = new Set()
    const dirOf = new Map(recent.map((s) => [s.id, s.directory]))
    for (const c of calls) {
      if (c.name !== "memory_read") continue
      sessionsReading.add(c.session)
      const scope = c.input?.scope === "user" || c.input?.scope === "global" ? c.input.scope : null
      let id = `${scope ?? "project"}/${c.input?.file ?? "MEMORY.md"}`
      if (!scope) {
        const dir = c.directory ?? dirOf.get(c.session)
        if (dir) {
          if (!repoKeys.has(dir)) repoKeys.set(dir, core.projectKey((await repoOf(dir)).repoRoot))
          id = `projects/${repoKeys.get(dir)}/${c.input?.file ?? "MEMORY.md"}`
        }
      }
      const r = reads.get(id) ?? { calls: 0, sessions: new Set() }
      r.calls++
      r.sessions.add(c.session)
      reads.set(id, r)
    }
    const dead = []
    if (repos.length)
      for (const t of topics) {
        if (!t.paths.length) continue
        const globs = t.paths.filter((g) =>
          repos.every((s) => core.deadGlobs([g], filesOf.get(s.toplevel), { root: s.toplevel, home: os.homedir() }).length),
        )
        if (globs.length) dead.push({ file: `${t.scope}/${t.file}`, globs })
      }
    await fs.writeFile(
      path.join(runDir, "usage.md"),
      formatUsage({
        since: day(usageSince),
        today: day(now.getTime()),
        sections,
        topics,
        reads,
        loaded: topicInjections(db, usageSince),
        dead,
        repos: repos.map((s) => s.toplevel),
        sessionsReading: sessionsReading.size,
      }),
    )
    db.close()
    cleanup.length = 0

    const prompt = core.dreamPrompt({ sessions: included.length, transcriptKB: Math.round(used / 1024), since: sinceDay, today: day(now.getTime()) })
    await fs.writeFile(path.join(runDir, "prompt.md"), prompt)
    log(`${included.length} sessions (${kb(used)} of transcripts) of ${recent.length} touched since ${sinceDay}.`)

    if (options.dryRun) {
      removeTree()
      mem("branch", "-D", branch)
      log(`Dry run. Inputs are in ${runDir} (sessions.md, usage.md, prompt.md, sessions/); delete it when done.`)
      return 0
    }

    const available = agentAvailable({ opencode, cwd: runDir, standalone: options.standalone })
    if (!available.ok) {
      removeTree()
      mem("branch", "-D", branch)
      await fs.rm(runDir, { recursive: true, force: true })
      log(
        available.why
          ? `Could not ask opencode for its agents: ${available.why}`
          : `The opencode server has not loaded a Marginalia that can dream. Restart it, or pass --standalone.`,
      )
      return 1
    }

    const before = await snapshot(storeDir)
    log(`Dreaming${options.model ? ` with ${options.model}` : ""}…`)
    let run = await runAgent({
      opencode,
      cwd: runDir,
      prompt,
      model: options.model,
      standalone: options.standalone,
      title: `marginalia dream ${stamp.slice(0, 10)}`,
      log,
    })
    let cost = run.cost
    const sessionID = run.sessionID
    const failed = (r) => {
      log(`The dream failed: ${r.errors.join("; ")}`)
      log(`Its workspace is kept: ${runDir} (branch ${branch}).`)
      return 1
    }
    if (run.errors.length) return failed(run)

    // Check what it did, and give it the chance to fix what fails the check.
    const stampAll = async () => {
      const after = await snapshot(storeDir)
      for (const [file, content] of after) {
        if (!file.endsWith("/MEMORY.md") || content === before.get(file)) continue
        const stamped = core.stampEntries(content, before.get(file), { date: day(now.getTime()), session: sessionID, agent: core.DREAM_AGENT })
        const out = stamped.endsWith("\n") ? stamped : `${stamped}\n`
        if (out !== content) {
          await fs.writeFile(path.join(storeDir, file), out)
          after.set(file, out)
        }
      }
      return after
    }
    let after = await stampAll()
    let verdict = core.checkDream(before, after)
    for (let round = 0; verdict.errors.length && round < DEFAULTS.fixRounds; round++) {
      log(`The result fails ${verdict.errors.length} ${verdict.errors.length === 1 ? "check" : "checks"}; asking for a fix…`)
      run = await runAgent({
        opencode,
        cwd: runDir,
        session: sessionID,
        model: options.model,
        standalone: options.standalone,
        prompt: `Your changes cannot be applied yet. Fix these, then update report.md if it no longer matches:\n${verdict.errors.map((e) => `- ${e}`).join("\n")}`,
        log,
      })
      cost += run.cost
      if (run.errors.length) return failed(run)
      after = await stampAll()
      verdict = core.checkDream(before, after)
    }
    if (verdict.errors.length) {
      log("The dream's result still fails its checks, so it was not applied:")
      for (const e of verdict.errors) log(`  - ${e}`)
      log(`Its workspace is kept for inspection: ${runDir} (branch ${branch}).`)
      return 1
    }

    // The session's own total, when it is in the database this CLI reads; the
    // step events are the fallback.
    const recorded = await openDb().then((d) => {
      if (!d) return null
      try {
        return d.prepare("SELECT cost FROM session_v2 WHERE id = ?").get(sessionID)?.cost ?? null
      } catch {
        return null
      } finally {
        d.close()
      }
    })
    if (typeof recorded === "number" && recorded > 0) cost = recorded
    const report = ((await store.read(path.join(runDir, "report.md"))) ?? "").trim()
    const costLine = cost ? ` · $${cost.toFixed(2)} at list price` : ""
    const finish = async (summary) => {
      await fs.writeFile(path.join(DREAM_DIR, "last-report.md"), `${summary}\n\nsession ${sessionID}${costLine}\n`)
      await fs.writeFile(statePath, JSON.stringify({ ...state, lastRun: now.toISOString(), lastSession: sessionID }, null, 2))
    }

    if (!verdict.changed.length) {
      removeTree()
      mem("branch", "-D", branch)
      if (!options.keep) await fs.rm(runDir, { recursive: true, force: true })
      await finish(report || "No changes.")
      log(`No changes: the store already holds up against these sessions.${costLine}`)
      return 0
    }

    // One commit on the dream's branch, then onto the live store.
    const [first = "", ...rest] = report.split("\n")
    const title = commitTitle(first) || `review memory against ${included.length} sessions`
    const body = [rest.join("\n").trim(), "", `Dream-Session: ${sessionID}`, `Sessions-Reviewed: ${included.length}`, `Since: ${sinceDay}`]
      .join("\n")
      .trim()
    const tree = gitIn(storeDir)
    tree("add", "-A")
    const committed = tree("commit", "-q", "-m", `dream: ${title}`, "-m", body)
    if (!committed.ok) {
      log(`Could not commit the dream: ${committed.err}`)
      log(`Its workspace is kept: ${runDir} (branch ${branch}).`)
      return 1
    }

    // Live sessions may have written meanwhile; commit that first, so the merge
    // only ever combines two commits and never touches uncommitted work.
    mem("add", "-A")
    mem("commit", "-q", "-m", "memory: during dream")
    const head = mem("rev-parse", "HEAD").out
    const merged = head === base ? mem("merge", "-q", "--ff-only", branch) : mem("merge", "-q", "--no-ff", "-m", `dream: merge ${title}`, branch)
    if (!merged.ok) {
      mem("merge", "--abort")
      log("The dream conflicts with what sessions wrote while it ran, so it was not applied.")
      log(`It is on branch ${branch} in ${MEM}; merge it by hand, or run the dream again.`)
      log(`Workspace: ${runDir}`)
      return 1
    }
    const sha = mem("rev-parse", "--short", "HEAD").out
    removeTree()
    mem("branch", "-q", "-D", branch)
    if (!options.keep) await fs.rm(runDir, { recursive: true, force: true })
    await finish(report)

    log("")
    log(report || `dream: ${title}`)
    log("")
    log(`Applied as ${sha} (${verdict.changed.length} ${verdict.changed.length === 1 ? "file" : "files"})${costLine}.`)
    log(`Undo: git -C ${MEM} revert ${head === base ? "" : "-m 1 "}${sha}`)
    return 0
  } finally {
    for (const fn of cleanup) {
      try {
        fn()
      } catch {}
    }
    await fs.rm(lock, { force: true })
  }
}
