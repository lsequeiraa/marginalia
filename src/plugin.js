// Marginalia — notes in the margins of your codebase.
//
// A small always-on index plus path-scoped topic files that cost nothing until
// you read matching code. Storage is plain markdown in a git repo at
// ~/.local/share/marginalia (override: MARGINALIA_DIR).
//
// Pure logic lives in ./core.js and is covered by tests in ../test.
// Every hook is wrapped in try/catch: a memory bug must never break a session.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as core from "./core.js"

const MEM_DIR = process.env.MARGINALIA_DIR || path.join(os.homedir(), ".local/share/marginalia")
const SCOPES = ["user", "global", "project"]
const TOPIC_TTL_MS = 5_000
const COMMIT_DEBOUNCE_MS = 2_000
const MAX_CACHED_SESSIONS = 64
const FILES_TTL_MS = 5 * 60_000
const MAX_TRACKED_FILES = 20_000

const today = () => new Date().toISOString().slice(0, 10)

// v2 removed the `$` shell helper from the plugin arguments. store.js has a
// synchronous equivalent, but it is not reused here because this half must not
// block. The server plugin shares a process with every session the server
// hosts, so a synchronous git call stalls all of them.
//
// Resolves to trimmed stdout, or null if git failed.
const exec = promisify(execFile)
const git = async (args, cwd) => {
  try {
    // Node's default 1MB output cap fails `git ls-files` on a large repository.
    const { stdout } = await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 })
    return stdout.trim()
  } catch {
    return null
  }
}

/** @param {import("@opencode/plugin").Plugin.Context} ctx */
export const Marginalia = async (ctx) => {
  // ---------------------------------------------------------------- locations

  // v2 replaced the `worktree` setup argument with the location domain.
  const worktree = ctx.location.directory

  // Resolved from the git common dir so every linked worktree of a repo shares
  // one memory directory, matching how the repo itself is one thing.
  const repoRoot = await (async () => {
    const out = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)
    return out ? path.dirname(out) : worktree
  })()

  // The checkout this location is in, which for a linked worktree is not
  // repoRoot. Its tracked files decide which topics bear on this repository.
  const toplevel = (await git(["rev-parse", "--show-toplevel"], worktree)) || worktree

  const projectName = path.basename(repoRoot)
  const dirs = {
    user: path.join(MEM_DIR, "user"),
    global: path.join(MEM_DIR, "global"),
    project: path.join(MEM_DIR, "projects", core.projectKey(repoRoot)),
  }
  // Unknown scopes fall to "project": a misrouted fact about this repo is a far
  // smaller problem than one written into the user's profile or a crash.
  const scopeOf = (s) => (s === "user" || s === "global" ? s : "project")
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
        const stat = await fs.stat(path.join(dirs[scope], file)).catch(() => null)
        out.push({
          scope,
          file,
          bytes: Buffer.byteLength(content, "utf8"),
          mtime: stat?.mtimeMs ?? 0,
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

  // ------------------------------------------------------------ tracked files

  let filesCache = { at: 0, value: null }

  async function trackedFiles() {
    if (filesCache.value && Date.now() - filesCache.at < FILES_TTL_MS) return filesCache.value
    const out = await git(["ls-files"], toplevel)
    filesCache = { at: Date.now(), value: out ? out.split("\n").slice(0, MAX_TRACKED_FILES) : [] }
    return filesCache.value
  }

  // Matching every glob against every tracked file is the one costly step in a
  // render (a few hundred ms on a repository of ten thousand files), so it is
  // only redone when some topic's globs or the file list change, not each time
  // the topic cache refreshes.
  let relevance = { key: null, files: null, value: new Set() }

  async function relevantTopics(topics) {
    const files = await trackedFiles()
    const key = topics.map((t) => `${t.scope}/${t.file}\t${t.paths.join("\t")}`).join("\n")
    if (relevance.key !== key || relevance.files !== files) {
      relevance = { key, files, value: core.relevantTopics(topics, files, { root: toplevel, home: os.homedir() }) }
    }
    return relevance.value
  }

  // -------------------------------------------------------------- block render

  const blocks = new Map()

  async function render() {
    const [userEntries, globalEntries, projectEntries, topics] = await Promise.all([
      indexEntries("user"),
      indexEntries("global"),
      indexEntries("project"),
      listTopics(),
    ])
    const relevant = await relevantTopics(topics)
    return core.renderBlock({ userEntries, globalEntries, projectEntries, projectName, topics, relevant, now: new Date() })
  }

  async function block(sessionID) {
    if (blocks.has(sessionID)) return blocks.get(sessionID)
    const { text } = await render()
    if (blocks.size >= MAX_CACHED_SESSIONS) blocks.delete(blocks.keys().next().value)
    blocks.set(sessionID, text)
    return text
  }

  const sectionLabel = (scope) => ({ user: "profile", global: "cross-project", project: projectName })[scopeOf(scope)]

  // What the next session start will actually show of the index just written.
  async function visibility(scope) {
    const rendered = await render()
    return core.visibilityNote(rendered.sections[scopeOf(scope)], sectionLabel(scope))
  }

  // ----------------------------------------------------------------------- git

  // There is no server-side toast in v2: the plugin runs in a separate process
  // from the TUI and Context has no `ui` domain. Nothing was rebuilt to replace
  // it because every toast was redundant — the tools return their outcome to the
  // model as text, and #fact capture rewrites the prompt so the model reports
  // back in one line. `/memory version` still covers the update notice.

  let commitTimer = null
  const commitPending = new Set()

  async function commitNow() {
    const label = [...commitPending].join(", ") || "update"
    commitPending.clear()
    const mem = (...args) => git(args, MEM_DIR)
    try {
      await fs.mkdir(MEM_DIR, { recursive: true })
      if ((await mem("rev-parse", "--git-dir")) === null) {
        await mem("init", "-q")
        // Only set a local identity if the user has no global one, so real
        // commits keep their real author.
        if (!(await mem("config", "user.email"))) {
          await mem("config", "user.email", "opencode@localhost")
          await mem("config", "user.name", "opencode")
        }
        await writeAtomic(path.join(MEM_DIR, ".gitignore"), "*.tmp-*\n")
      }
      await mem("add", "-A")
      await mem("commit", "-q", "-m", `memory: ${label}`)
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
   *             limits?: ReturnType<typeof core.checkIndexLimits>, visibility?: string | null }} AppendResult
   */

  /** @returns {Promise<AppendResult>} */
  async function appendEntry({ scope, text, negative, sessionID, agent }) {
    const verdict = core.lintEntry(text)
    if (!verdict.ok) return verdict

    const target = fileIn(scope, "MEMORY.md")
    const existing = await read(target)
    const nodes = core.parseMemoryFile(existing ?? `# Memory — ${scopeOf(scope) === "project" ? projectName : scopeOf(scope)}\n`)
    const conflicts = core.similarEntries(text, core.entriesOf(nodes))

    // Drop trailing blank lines first, otherwise every append leaves one behind
    // and the index burns twice the lines it needs against the load limit.
    while (nodes.length && nodes.at(-1).type === "raw" && !nodes.at(-1).line.trim()) nodes.pop()
    nodes.push({ type: "entry", text: text.trim(), negative: Boolean(negative), date: today(), session: sessionID || null, agent: agent || null })
    const next = core.serializeMemoryFile(nodes)
    await writeAtomic(target, next.endsWith("\n") ? next : next + "\n")
    invalidate()

    scheduleCommit(`${scopeOf(scope)}/MEMORY.md`)
    return { ok: true, conflicts, limits: core.checkIndexLimits(next), visibility: await visibility(scope) }
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
    // Only the hard limit. The approaching-the-limit warning measured a 25KB
    // file against a block that shows far less of it, which is how indexes grew
    // that no session ever saw; what is actually shown is the visibility note.
    if (r.limits.over) parts.push(`\n${r.limits.message}`)
    if (r.visibility) parts.push(`\n${r.visibility}`)
    return parts.join("\n")
  }

  // -------------------------------------------------------------------- tools

  // v2 takes plain JSON Schema for `input`, so the zod dependency is gone.
  //
  // `options.codemode: false` is mandatory, not decorative. The runtime splits
  // tools into `direct` (callable by name) and `codemode` (sandbox only), and
  // defaults to codemode. Without this every call fails "Unknown tool: <name>".
  const scopeArg = {
    type: "string",
    enum: SCOPES,
    description:
      '"user" for facts about the person you work for — preferences, working style, their stack and machines; ' +
      '"global" for technical knowledge that holds everywhere but is about no person; ' +
      '"project" for facts about this repository. Choose by what the fact is about, not where you learned it.',
  }
  const direct = { codemode: false }

  /**
   * Annotated because the array literal would otherwise be inferred from its
   * first element, and the four schemas have different property sets.
   * @type {Parameters<import("@opencode/plugin/promise/tool").ToolEditor["add"]>[0][]}
   */
  const tools = [
    {
      name: "memory_read",
      description:
        "Read a memory file. Use this instead of the read tool — memory lives outside the project directory. Omit `file` for the always-loaded MEMORY.md index.",
      options: direct,
      input: {
        type: "object",
        properties: {
          scope: scopeArg,
          file: { type: "string", description: 'Topic file name, e.g. "solver-perf.md". Defaults to MEMORY.md.' },
        },
        required: ["scope"],
      },
      async execute(args) {
        const file = safeName(args.file)
        const content = await read(fileIn(args.scope, file))
        if (content == null) return { content: `No such memory file: ${scopeOf(args.scope)}/${file}` }
        return { content }
      },
    },

    {
      name: "memory_search",
      description:
        "Search memory for words: the user, global and project indexes and every topic file, including entries and files the session-start listing leaves out. Use it when you need something memory may hold but the listing does not show where.",
      options: direct,
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Words to look for, e.g. "forgejo review comment". Words of four letters or more also match longer words they start.',
          },
          scope: {
            type: "string",
            enum: SCOPES,
            description: "Search only this scope. Omit to search all three.",
          },
        },
        required: ["query"],
      },
      async execute(args) {
        const scopes = args.scope ? [scopeOf(args.scope)] : SCOPES
        const docs = []
        for (const scope of scopes) {
          const index = await read(fileIn(scope, "MEMORY.md"))
          if (index) docs.push({ scope, file: "MEMORY.md", description: "", body: index })
        }
        for (const t of await listTopics()) if (scopes.includes(t.scope)) docs.push(t)
        return { content: core.formatSearch(core.searchMemory(docs, args.query), args.query) }
      },
    },

    {
      name: "memory_append",
      description:
        "Append one durable fact to the MEMORY.md index. One line per fact — put anything longer in a topic file with memory_write. Rejects transient facts, commit SHAs, file:line references and credentials.",
      options: direct,
      input: {
        type: "object",
        properties: {
          scope: scopeArg,
          entry: { type: "string", description: "A single durable fact, under 200 characters." },
          negative: {
            type: "boolean",
            description: "True if this records something that was tried and did NOT work, so it is not retried.",
          },
        },
        required: ["scope", "entry"],
      },
      async execute(args, ctx) {
        const r = await appendEntry({
          scope: args.scope,
          text: args.entry,
          negative: args.negative,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
        })
        return { content: appendResult(args.scope, args.entry, r) }
      },
    },

    {
      name: "memory_write",
      description:
        "Create or replace a topic file holding detail that does not belong in the index. Set `paths` and the file is injected automatically whenever a matching file is read — that costs nothing until it is relevant, so prefer it over adding to the index.",
      options: direct,
      input: {
        type: "object",
        properties: {
          scope: scopeArg,
          file: { type: "string", description: 'Topic file name ending in .md, e.g. "solver-perf.md".' },
          content: { type: "string", description: "Full markdown body. This replaces the file." },
          description: {
            type: "string",
            description: "One line shown in the index listing so you know when to open it.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description:
              'Globs relative to the repo root, e.g. ["src/solver/**"]. Auto-injects this file when a match is read.',
          },
        },
        required: ["scope", "file", "content"],
      },
      async execute(args) {
        const file = safeName(args.file)
        if (file === "MEMORY.md")
          return { content: "REJECTED: use memory_append or memory_edit for the MEMORY.md index." }
        const body = String(args.content).trimEnd() + "\n"
        await writeAtomic(fileIn(args.scope, file), core.serializeFrontmatter({ description: args.description, paths: args.paths }, body))
        invalidate()
        scheduleCommit(`${scopeOf(args.scope)}/${file}`)
        const parts = [`Wrote ${scopeOf(args.scope)}/${file}.`]
        if (args.paths?.length) {
          parts.push(`Auto-loads for: ${args.paths.join(", ")}`)
          const dead = core.deadGlobs(args.paths, await trackedFiles(), { root: toplevel, home: os.homedir() })
          if (dead.length)
            parts.push(
              `\n${dead.join(", ")} ${dead.length === 1 ? "matches" : "match"} no tracked file in ${path.basename(toplevel)}` +
                (scopeOf(args.scope) === "project"
                  ? ", so it will never load. Globs are relative to the repository root; fix it with memory_write."
                  : ". Fine if it targets another repository (globs are tried relative to that repository's root and as absolute paths, and ~/ is your home); otherwise fix it."),
            )
        }
        return { content: parts.join(" ") }
      },
    },

    {
      name: "memory_edit",
      description:
        "Replace an exact string in a memory file. Use this to correct or remove a fact that is wrong or out of date — editing an index entry refreshes its date, so a stale one stops showing as unverified.",
      options: direct,
      input: {
        type: "object",
        properties: {
          scope: scopeArg,
          file: { type: "string", description: "Defaults to MEMORY.md." },
          old: { type: "string", description: "Exact text to replace. Must appear exactly once." },
          new: { type: "string", description: "Replacement text. Empty string deletes it." },
        },
        required: ["scope", "old", "new"],
      },
      async execute(args, ctx) {
        const file = safeName(args.file)
        const target = fileIn(args.scope, file)
        const content = await read(target)
        if (content == null) return { content: `No such memory file: ${scopeOf(args.scope)}/${file}` }

        const hits = content.split(args.old).length - 1
        if (hits === 0) return { content: `REJECTED: "${args.old}" not found in ${scopeOf(args.scope)}/${file}.` }
        if (hits > 1)
          return {
            content: `REJECTED: "${args.old}" appears ${hits} times. Include more surrounding text to make it unique.`,
          }

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
        // Deleting an entry's text alone used to leave "-  <!-- date · … -->".
        if (file === "MEMORY.md") next = core.dropEmptyEntries(next)
        next = next.replace(/\n{3,}/g, "\n\n")
        await writeAtomic(target, next)
        invalidate()
        scheduleCommit(`${scopeOf(args.scope)}/${file}`)
        // `+` binds tighter than `??`, so the old form was ("  " + message) ?? ""
        // — the fallback was dead and a null message rendered as the string "null".
        const notes = []
        if (file === "MEMORY.md") {
          const limits = core.checkIndexLimits(next)
          if (limits.over) notes.push(limits.message)
          const note = await visibility(args.scope)
          if (note) notes.push(note)
        }
        return { content: [`Updated ${scopeOf(args.scope)}/${file}.`, ...notes].join(" ") }
      },
    },
  ]

  // -------------------------------------------------------------------- hooks

  const injected = new Map() // sessionID -> Set of "<scope>/<file>" already surfaced

  // The daily background update check was dropped in the v2 port: its only
  // output was a toast, and v2 has no server-side toast to deliver it.
  // `/memory version` in the TUI half still checks npm on demand.

  // /memory is a real modal registered by the TUI half of this package
  // (src/tui.js), not a prompt command. Registering both would put two identical
  // rows in the slash popup with different behaviour depending on which you pick.

  // Every registration returns a handle with dispose(); collect them so a
  // reload tears the old generation down instead of leaving hooks bound to a
  // dead closure.
  /** @type {import("@opencode/plugin/promise/registration").Registration[]} */
  const registrations = []
  const register = async (promise) => registrations.push(await promise)

  // Transforms are replayed whenever the tool registry rebuilds (including
  // after MCP catalogue refreshes), so registering once at setup is enough.
  await register(
    ctx.tool.transform((editor) => {
      for (const t of tools) editor.add(t)
    }),
  )

  // The agent `marginalia dream` runs as. Hidden: it is started by the CLI,
  // never picked by hand. Its rules come after the defaults and after config,
  // so they decide (see core.DREAM_PERMISSIONS).
  await register(
    ctx.agent.transform((editor) => {
      editor.update(core.DREAM_AGENT, (agent) => {
        agent.name = /** @type {any} */ ("Marginalia dream")
        agent.description = "Reviews memory against recent session transcripts. Started by `marginalia dream`."
        agent.mode = "primary"
        agent.hidden = true
        agent.system = core.DREAM_SYSTEM
        agent.permissions.push(...core.DREAM_PERMISSIONS.map((rule) => ({ ...rule })))
      })
    }),
  )

  // Append the memory block as a separate system entry, never over system[0],
  // which holds the base prompt. The v1 rationale was prompt-cache breakpoints
  // on the first two system messages; that has not been re-verified against v2,
  // but pushing one entry and leaving index 0 alone stays the safe choice. v2
  // types `system` as SystemPart objects rather than v1's bare strings.
  await register(
    ctx.session.hook("context", async (event) => {
      try {
        if (!event.sessionID) return
        // A dream reads the store from files; the block would only be a second,
        // stale copy of what it is editing.
        if (event.agent === core.DREAM_AGENT) return
        event.system.push({ type: "text", text: await block(event.sessionID) })
      } catch {}
    }),
  )

  // Path-scoped topic files ride the read tool result. (opencode 2 itself now
  // loads nested AGENTS.md as a separate synthetic message; plugins have no
  // equivalent that is delivered before the model's next step.)
  await register(
    ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.tool !== "read" || event.status !== "completed" || event.agent === core.DREAM_AGENT) return
        const content = event.result.content
        // Tool.Result.content is `string | Content[] | undefined`, and from
        // opencode 2.0 the read tool returns the array form for text files too:
        // one text part, plus a file part for images and PDFs. Accepting only
        // the string form is why nothing was injected for two months. The
        // runtime prefers a non-empty string over the array, so the reminder is
        // added as a part of its own; a string in its place would drop the file.
        if (typeof content !== "string" && !Array.isArray(content)) return
        const args = /** @type {any} */ (event.input) ?? {}
        const raw = args.path ?? args.filePath ?? args.file
        if (typeof raw !== "string" || !raw) return
        const absolute = path.resolve(worktree, raw)
        const rel = path.relative(toplevel, absolute)
        // Relative to the checkout when the file is in it, and absolute always,
        // so a global topic can name files in another repository or in ~.
        const candidates = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? [rel, absolute] : [absolute]

        const seen = injected.get(event.sessionID) ?? new Set()
        const additions = []
        for (const t of await listTopics()) {
          const id = `${t.scope}/${t.file}`
          if (seen.has(id) || !core.matchesPaths(candidates, t.paths, { home: os.homedir() })) continue
          seen.add(id)
          additions.push(core.renderPathScoped({ scope: t.scope, file: t.file, paths: t.paths, body: t.body }))
        }
        if (!additions.length) return
        injected.set(event.sessionID, seen)
        const text = additions.join("\n")
        // Result fields are readonly, so replace the object rather than mutate it.
        event.result = {
          ...event.result,
          content: typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }],
        }
      } catch {}
    }),
  )

  // `#fact` captures straight to memory. `#me fact` targets the profile and
  // `#global fact` cross-project knowledge.
  // The turn still costs one cheap round-trip; it cannot be suppressed.
  //
  // v1 dug a TextPart out of `output.parts`; v2's prompt hook carries a single
  // `prompt.text`, so the part-hunting and its union cast are both gone.
  await register(
    ctx.session.hook("prompt", async (event) => {
      try {
        const raw = event.prompt?.text
        if (typeof raw !== "string") return
        const text = raw.trim().replace(/^["']|["']$/g, "").trim()
        // Single short line only, so pasted markdown headings are not captured.
        if (!text.startsWith("#") || text.includes("\n") || text.length > 400) return

        const rest = text.replace(/^#+\s*/, "").trim()
        if (!rest) return
        // `#me`, not `#user`: "user" is too ordinary a noun to spend on a
        // keyword — "#user avatars are cached in Redis" would file "avatars are
        // cached in Redis" as a fact about the person. Falling through to the
        // project scope with the sentence intact is the recoverable failure.
        // (`#user` did mean the global scope before the profile existed. It now
        // means nothing, which is why docs/setup.md says so.)
        //
        // Whitespace, not \b, after the keyword: \b lets punctuation through, so
        // "#me-time" would have been captured as "-time".
        const prefix = /^(me|global)[:,]?(?=\s|$)\s*/i.exec(rest)
        const scope = prefix ? (prefix[1].toLowerCase() === "me" ? "user" : "global") : "project"
        const fact = prefix ? rest.slice(prefix[0].length).trim() : rest
        if (!fact) return

        // `agent` is dropped on purpose, not overlooked: v1 read it from the
        // chat.message input, and v2's SessionPrompt carries no agent field. So
        // #-captured entries record the session but not the agent half of their
        // provenance. Tool-captured entries are unaffected — ToolContext has it.
        const r = await appendEntry({ scope, text: fact, negative: false, sessionID: event.sessionID, agent: undefined })
        if (!r.ok) {
          event.prompt.text = `The user tried to save "${fact}" to ${scope} memory but it was rejected (${r.rule}): ${r.message} Tell them in one short line and suggest a durable rephrasing. Do nothing else.`
          return
        }
        const conflicts = r.conflicts.length ? ` Related existing entries: ${r.conflicts.map((c) => c.text).join(" | ")}.` : ""
        event.prompt.text = `Saved to ${scope} memory: "${fact}".${conflicts} Confirm in one short line. Do nothing else.`
      } catch {}
    }),
  )

  // Compaction re-renders the block and re-arms path-scoped injection, matching
  // how opencode lets compacted parts be re-surfaced.
  //
  // Two v1 names changed: `session.compacted` is not exposed on the v2 client
  // event stream at all and becomes `session.compaction.ended`, and both events
  // now carry data.sessionID, so the session.deleted special case is gone.
  //
  // Unlike v1's push-based `event` hook, an iterator can fail — a dropped
  // connection or a full subscriber buffer rejects the pending next(). Ending
  // the loop there would silently stop invalidating for the rest of the
  // process, so it resubscribes until the controller is aborted.
  const events = new AbortController()
  const watch = (async () => {
    while (!events.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type !== "session.compaction.ended" && event.type !== "session.deleted") continue
          const id = /** @type {any} */ (event).data?.sessionID
          if (!id) continue
          blocks.delete(id)
          injected.delete(id)
        }
      } catch {
        /* aborted on dispose, or the stream broke; the guard below decides */
      }
      if (events.signal.aborted) break
      // Do not spin if the stream fails immediately and repeatedly. Woken by
      // the abort too, so disposing does not wait out the backoff.
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 1000)
        events.signal.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true })
      })
    }
  })()

  return async () => {
    events.abort()
    await watch
    if (commitTimer) {
      clearTimeout(commitTimer)
      commitTimer = null
      await commitNow()
    }
    // Reversed so teardown mirrors setup order.
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
  }
}
