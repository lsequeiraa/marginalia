// Marginalia — notes in the margins of your codebase.
//
// A small always-on index plus path-scoped topic files that cost nothing until
// you read matching code. Storage is plain markdown in a git repo at
// ~/.local/share/marginalia (override: MARGINALIA_DIR).
//
// Pure logic lives in ./core.js and is covered by tests in ../test.
// Every hook is wrapped in try/catch: a memory bug must never break a session.
import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as core from "./core.js"

const MEM_DIR = process.env.MARGINALIA_DIR || path.join(os.homedir(), ".local/share/marginalia")
const SCOPES = ["global", "project"]
const TOPIC_TTL_MS = 5_000
const COMMIT_DEBOUNCE_MS = 2_000
const MAX_CACHED_SESSIONS = 64
const UPDATE_TTL_MS = 86_400_000

const today = () => new Date().toISOString().slice(0, 10)

/** @type {import("@opencode-ai/plugin").Plugin} */
export const Marginalia = async ({ client, worktree, $ }) => {
  // ---------------------------------------------------------------- locations

  // Resolved from the git common dir so every linked worktree of a repo shares
  // one memory directory, matching how the repo itself is one thing.
  const repoRoot = await (async () => {
    const r = await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(worktree).quiet().nothrow()
    const out = r.exitCode === 0 ? r.stdout.toString().trim() : ""
    return out ? path.dirname(out) : worktree
  })()

  const projectName = path.basename(repoRoot)
  const dirs = { global: path.join(MEM_DIR, "global"), project: path.join(MEM_DIR, "projects", core.projectKey(repoRoot)) }
  const scopeOf = (s) => (s === "global" ? "global" : "project")
  const fileIn = (scope, file) => path.join(dirs[scopeOf(scope)], file)

  // ------------------------------------------------------------------- fs util

  const read = (p) => fs.readFile(p, "utf8").then((s) => s, () => null)

  async function writeAtomic(p, content) {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, p)
  }

  function safeName(file) {
    const f = String(file ?? "MEMORY.md").trim() || "MEMORY.md"
    if (f.includes("/") || f.includes("\\") || f.includes("..") || path.isAbsolute(f))
      throw new Error(`Invalid name "${f}": use a bare file name, no paths.`)
    if (!f.endsWith(".md")) throw new Error(`Invalid name "${f}": memory files must end in .md`)
    return f
  }

  // Mirrors the load limit so what the agent sees is what would actually load.
  function loadIndex(content) {
    if (!content) return ""
    const clipped = content.split("\n").slice(0, core.LIMITS.indexLines).join("\n")
    return Buffer.byteLength(clipped, "utf8") > core.LIMITS.indexBytes
      ? Buffer.from(clipped, "utf8").subarray(0, core.LIMITS.indexBytes).toString("utf8")
      : clipped
  }

  const indexEntries = async (scope) => core.entriesOf(core.parseMemoryFile(loadIndex(await read(fileIn(scope, "MEMORY.md")))))

  // ------------------------------------------------------------------- topics

  let topicCache = { at: 0, value: null }

  async function listTopics() {
    if (topicCache.value && Date.now() - topicCache.at < TOPIC_TTL_MS) return topicCache.value
    const out = []
    for (const scope of SCOPES) {
      const names = await fs.readdir(dirs[scope]).then((n) => n, () => [])
      for (const file of names.sort()) {
        if (!file.endsWith(".md") || file === "MEMORY.md" || file.includes(".tmp-")) continue
        const content = await read(path.join(dirs[scope], file))
        if (content == null) continue
        const { data, body } = core.parseFrontmatter(content)
        out.push({
          scope,
          file,
          bytes: Buffer.byteLength(content, "utf8"),
          description: data.description || "",
          paths: Array.isArray(data.paths) ? data.paths : [],
          body,
        })
      }
    }
    topicCache = { at: Date.now(), value: out }
    return out
  }

  const invalidate = () => {
    topicCache = { at: 0, value: null }
    blocks.clear()
  }

  // -------------------------------------------------------------- block render

  const blocks = new Map()

  async function block(sessionID) {
    if (blocks.has(sessionID)) return blocks.get(sessionID)
    const [globalEntries, projectEntries, topics] = await Promise.all([
      indexEntries("global"),
      indexEntries("project"),
      listTopics(),
    ])
    const { text } = core.renderBlock({ globalEntries, projectEntries, projectName, topics, now: new Date() })
    if (blocks.size >= MAX_CACHED_SESSIONS) blocks.delete(blocks.keys().next().value)
    blocks.set(sessionID, text)
    return text
  }

  // --------------------------------------------------------------- toast + git

  /** @param {string} message @param {"info"|"success"|"warning"|"error"} [variant] */
  const toast = (message, variant = "success") =>
    client.tui.showToast({ body: { title: "Memory", message, variant, duration: 4000 } }).catch(() => {})

  let commitTimer = null
  const commitPending = new Set()

  async function commitNow() {
    const label = [...commitPending].join(", ") || "update"
    commitPending.clear()
    const git = (...args) => $`git ${args}`.cwd(MEM_DIR).quiet().nothrow()
    try {
      await fs.mkdir(MEM_DIR, { recursive: true })
      if ((await git("rev-parse", "--git-dir")).exitCode !== 0) {
        await git("init", "-q")
        // Only set a local identity if the user has no global one, so real
        // commits keep their real author.
        if (!(await git("config", "user.email")).stdout.toString().trim()) {
          await git("config", "user.email", "opencode@localhost")
          await git("config", "user.name", "opencode")
        }
        await writeAtomic(path.join(MEM_DIR, ".gitignore"), "*.tmp-*\n")
      }
      await git("add", "-A")
      await git("commit", "-q", "-m", `memory: ${label}`)
    } catch {
      /* memory still written to disk; versioning is best-effort */
    }
  }

  function scheduleCommit(label) {
    commitPending.add(label)
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => {
      commitTimer = null
      commitNow()
    }, COMMIT_DEBOUNCE_MS)
  }

  // ---------------------------------------------------------------- appending

  /**
   * Optional fields rather than a discriminated union: narrowing on `ok` needs
   * strictNullChecks, which this project does not enable (see tsconfig.json).
   * @typedef {{ ok: boolean, rule?: string, message?: string, conflicts?: any[],
   *             limits?: ReturnType<typeof core.checkIndexLimits> }} AppendResult
   */

  /** @returns {Promise<AppendResult>} */
  async function appendEntry({ scope, text, negative, sessionID, agent }) {
    const verdict = core.lintEntry(text)
    if (!verdict.ok) return verdict

    const target = fileIn(scope, "MEMORY.md")
    const existing = await read(target)
    const nodes = core.parseMemoryFile(existing ?? `# Memory — ${scope === "global" ? "global" : projectName}\n`)
    const conflicts = core.similarEntries(text, core.entriesOf(nodes))

    // Drop trailing blank lines first, otherwise every append leaves one behind
    // and the index burns twice the lines it needs against the load limit.
    while (nodes.length && nodes.at(-1).type === "raw" && !nodes.at(-1).line.trim()) nodes.pop()
    nodes.push({ type: "entry", text: text.trim(), negative: Boolean(negative), date: today(), session: sessionID || null, agent: agent || null })
    const next = core.serializeMemoryFile(nodes)
    await writeAtomic(target, next.endsWith("\n") ? next : next + "\n")
    invalidate()

    toast(`${negative ? "✗ " : ""}${text.trim().slice(0, 70)}`)
    scheduleCommit(`${scopeOf(scope)}/MEMORY.md`)
    return { ok: true, conflicts, limits: core.checkIndexLimits(next) }
  }

  function appendResult(scope, text, r) {
    if (!r.ok) return `REJECTED (${r.rule}): ${r.message}\n\nRephrase as a durable fact and try again. Not saved: "${text}"`
    const parts = [`Saved to ${scopeOf(scope)}/MEMORY.md.`]
    if (r.conflicts.length) {
      parts.push(
        "\nPossibly related existing entries — reconcile with memory_edit or remove if superseded:",
        ...r.conflicts.map((c) => `  - ${c.negative ? "✗ " : ""}${c.text}${c.date ? ` [${c.date}]` : ""}`),
      )
    }
    if (r.limits.message) parts.push(`\n${r.limits.message}`)
    return parts.join("\n")
  }

  // -------------------------------------------------------------------- tools

  const scopeArg = tool.schema
    .enum(SCOPES)
    .describe('"global" for facts about the user that hold everywhere; "project" for facts about this repository.')

  const tools = {
    memory_read: tool({
      description:
        "Read a memory file. Use this instead of the read tool — memory lives outside the project directory. Omit `file` for the always-loaded MEMORY.md index.",
      args: {
        scope: scopeArg,
        file: tool.schema.string().optional().describe('Topic file name, e.g. "solver-perf.md". Defaults to MEMORY.md.'),
      },
      async execute(args) {
        const file = safeName(args.file)
        const content = await read(fileIn(args.scope, file))
        if (content == null) return `No such memory file: ${scopeOf(args.scope)}/${file}`
        return content
      },
    }),

    memory_append: tool({
      description:
        "Append one durable fact to the MEMORY.md index. One line per fact — put anything longer in a topic file with memory_write. Rejects transient facts, commit SHAs, file:line references and credentials.",
      args: {
        scope: scopeArg,
        entry: tool.schema.string().describe("A single durable fact, under 200 characters."),
        negative: tool.schema
          .boolean()
          .optional()
          .describe("True if this records something that was tried and did NOT work, so it is not retried."),
      },
      async execute(args, ctx) {
        const r = await appendEntry({
          scope: args.scope,
          text: args.entry,
          negative: args.negative,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
        })
        return appendResult(args.scope, args.entry, r)
      },
    }),

    memory_write: tool({
      description:
        "Create or replace a topic file holding detail that does not belong in the index. Set `paths` and the file is injected automatically whenever a matching file is read — that costs nothing until it is relevant, so prefer it over adding to the index.",
      args: {
        scope: scopeArg,
        file: tool.schema.string().describe('Topic file name ending in .md, e.g. "solver-perf.md".'),
        content: tool.schema.string().describe("Full markdown body. This replaces the file."),
        description: tool.schema.string().optional().describe("One line shown in the index listing so you know when to open it."),
        paths: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe('Globs relative to the repo root, e.g. ["src/solver/**"]. Auto-injects this file when a match is read.'),
      },
      async execute(args) {
        const file = safeName(args.file)
        if (file === "MEMORY.md") return "REJECTED: use memory_append or memory_edit for the MEMORY.md index."
        const body = String(args.content).trimEnd() + "\n"
        await writeAtomic(fileIn(args.scope, file), core.serializeFrontmatter({ description: args.description, paths: args.paths }, body))
        invalidate()
        toast(`topic ${scopeOf(args.scope)}/${file}`)
        scheduleCommit(`${scopeOf(args.scope)}/${file}`)
        return `Wrote ${scopeOf(args.scope)}/${file}.${args.paths?.length ? ` Auto-loads for: ${args.paths.join(", ")}` : ""}`
      },
    }),

    memory_edit: tool({
      description:
        "Replace an exact string in a memory file. Use this to correct or remove a fact that is wrong or out of date — editing an index entry refreshes its date so it stops showing as unverified.",
      args: {
        scope: scopeArg,
        file: tool.schema.string().optional().describe("Defaults to MEMORY.md."),
        old: tool.schema.string().describe("Exact text to replace. Must appear exactly once."),
        new: tool.schema.string().describe("Replacement text. Empty string deletes it."),
      },
      async execute(args, ctx) {
        const file = safeName(args.file)
        const target = fileIn(args.scope, file)
        const content = await read(target)
        if (content == null) return `No such memory file: ${scopeOf(args.scope)}/${file}`

        const hits = content.split(args.old).length - 1
        if (hits === 0) return `REJECTED: "${args.old}" not found in ${scopeOf(args.scope)}/${file}.`
        if (hits > 1) return `REJECTED: "${args.old}" appears ${hits} times. Include more surrounding text to make it unique.`

        let next = content.replace(args.old, args.new)
        if (file === "MEMORY.md" && args.new.trim()) {
          // Re-stamp any entry line the edit touched so corrected facts are
          // treated as freshly verified.
          next = next
            .split("\n")
            .map((line) => {
              if (!line.includes(args.new.trim())) return line
              const entry = core.parseEntry(line)
              return entry ? core.formatEntry({ ...entry, date: today(), session: ctx.sessionID, agent: ctx.agent }) : line
            })
            .join("\n")
        }
        next = next.replace(/\n{3,}/g, "\n\n")
        await writeAtomic(target, next)
        invalidate()
        toast(`edited ${scopeOf(args.scope)}/${file}`, "info")
        scheduleCommit(`${scopeOf(args.scope)}/${file}`)
        // `+` binds tighter than `??`, so the old form was ("  " + message) ?? ""
        // — the fallback was dead and a null message rendered as the string "null".
        const limits = file === "MEMORY.md" ? (core.checkIndexLimits(next).message ?? "") : ""
        return `Updated ${scopeOf(args.scope)}/${file}. ${limits}`.trim()
      },
    }),
  }

  // ------------------------------------------------------------ self / updates

  const manifest = await fs
    .readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
    .then(JSON.parse, () => ({ name: "opencode-marginalia", version: "0.0.0" }))

  // opencode caches plugins by literal spec string and never re-resolves, so an
  // install is frozen at its original version forever. Opt-in, once a day, silent
  // on any failure. `/memory version` checks on demand without this enabled.
  async function checkForUpdate() {
    if (process.env.MARGINALIA_UPDATE_CHECK !== "1") return
    const stamp = path.join(MEM_DIR, ".update-check")
    try {
      const last = Number(await read(stamp)) || 0
      if (Date.now() - last < UPDATE_TTL_MS) return
      await fs.mkdir(MEM_DIR, { recursive: true })
      await fs.writeFile(stamp, String(Date.now()), "utf8")
      const res = await fetch(`https://registry.npmjs.org/${manifest.name}/latest`, {
        signal: AbortSignal.timeout(4000),
      })
      const latest = /** @type {{ version?: string }} */ (await res.json())?.version
      if (!latest || latest === manifest.version) return
      toast(`${latest} available (you have ${manifest.version}) — see /memory version`, "info")
    } catch {
      /* offline, rate-limited, whatever — never bother the user about it */
    }
  }

  // -------------------------------------------------------------------- hooks

  const injected = new Map() // sessionID -> Set of "<scope>/<file>" already surfaced

  // /memory is a real modal registered by the TUI half of this package
  // (src/tui.js), not a prompt command. Registering both would put two identical
  // rows in the slash popup with different behaviour depending on which you pick.
  checkForUpdate()

  return {
    tool: tools,

    // Append the memory block as a separate system entry. system[0] is the
    // provider prompt-cache prefix and must never be touched; pushing exactly
    // one string also avoids the >2-element collapse branch in the runtime.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return
        output.system.push(await block(input.sessionID))
      } catch {}
    },

    // Path-scoped topic files ride the read tool result, the same mechanism
    // opencode uses natively for subdirectory AGENTS.md.
    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool !== "read") return
        const raw = input.args?.filePath ?? input.args?.path ?? input.args?.file
        if (!raw) return
        const rel = path.relative(repoRoot, path.resolve(repoRoot, raw))
        if (!rel || rel.startsWith("..")) return

        const seen = injected.get(input.sessionID) ?? new Set()
        const additions = []
        for (const t of await listTopics()) {
          const id = `${t.scope}/${t.file}`
          if (seen.has(id) || !core.matchesPaths(rel, t.paths)) continue
          seen.add(id)
          additions.push(core.renderPathScoped({ scope: t.scope, file: t.file, paths: t.paths, body: t.body }))
        }
        if (!additions.length) return
        injected.set(input.sessionID, seen)
        output.output = `${output.output}\n\n${additions.join("\n")}`
      } catch {}
    },

    // `#fact` captures straight to memory. `#global fact` targets user scope.
    // The turn still costs one cheap round-trip; it cannot be suppressed.
    "chat.message": async (input, output) => {
      try {
        // .find() does not narrow the Part union, so the guard is restated as a cast.
        const part = /** @type {import("@opencode-ai/sdk").TextPart | undefined} */ (
          (output.parts ?? []).find((p) => p.type === "text" && typeof (/** @type {any} */ (p).text) === "string")
        )
        if (!part) return
        const text = part.text.trim().replace(/^["']|["']$/g, "").trim()
        // Single short line only, so pasted markdown headings are not captured.
        if (!text.startsWith("#") || text.includes("\n") || text.length > 400) return

        const rest = text.replace(/^#+\s*/, "").trim()
        if (!rest) return
        const g = /^(global|user)\b[:,]?\s*/i.exec(rest)
        const scope = g ? "global" : "project"
        const fact = g ? rest.slice(g[0].length).trim() : rest
        if (!fact) return

        const r = await appendEntry({ scope, text: fact, negative: false, sessionID: input.sessionID, agent: input.agent })
        if (!r.ok) {
          toast(r.message, "warning")
          part.text = `The user tried to save "${fact}" to ${scope} memory but it was rejected (${r.rule}): ${r.message} Tell them in one short line and suggest a durable rephrasing. Do nothing else.`
          return
        }
        const conflicts = r.conflicts.length ? ` Related existing entries: ${r.conflicts.map((c) => c.text).join(" | ")}.` : ""
        part.text = `Saved to ${scope} memory: "${fact}".${conflicts} Confirm in one short line. Do nothing else.`
      } catch {}
    },

    event: async ({ event }) => {
      try {
        // Compaction re-renders the block and re-arms path-scoped injection,
        // matching how opencode lets compacted parts be re-surfaced.
        if (event.type === "session.compacted") {
          const id = event.properties?.sessionID
          if (id) {
            blocks.delete(id)
            injected.delete(id)
          }
        }
        if (event.type === "session.deleted") {
          // Unlike session.compacted, this event carries no sessionID in the v1
          // SDK — the id is only reachable through the embedded session info.
          const id = event.properties?.info?.id
          if (id) {
            blocks.delete(id)
            injected.delete(id)
          }
        }
      } catch {}
    },

    dispose: async () => {
      if (commitTimer) {
        clearTimeout(commitTimer)
        commitTimer = null
        await commitNow()
      }
    },
  }
}
