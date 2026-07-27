// Pure logic for the memory plugin. No I/O, no opencode imports, no side effects.
// Everything here is unit-testable with `bun test`.
import { createHash } from "node:crypto"

export const LIMITS = {
  indexLines: 200, // MEMORY.md lines loaded at session start
  indexBytes: 25_000, // MEMORY.md bytes loaded at session start
  blockBytes: 8_192, // hard cap on the injected <memory> block
  entryChars: 200, // max length of a single index entry
  pathScopedBytes: 2_048, // max bytes appended to a read-tool result
  staleDays: 90, // age at which an entry renders as unverified
}

// ---------------------------------------------------------------- project key

export function projectKey(root) {
  const repoRoot = String(root).replace(/\/+$/, "") || "/"
  const base = repoRoot.split("/").filter(Boolean).pop() || "root"
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root"
  return `${slug}-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 8)}`
}

// -------------------------------------------------------------- durability lint

// Ordered: first match wins, so the most important message is the one returned.
const LINT_RULES = [
  {
    rule: "secret-pattern",
    test: /(\bsk-[A-Za-z0-9_-]{16,})|(\bgh[pousr]_[A-Za-z0-9]{20,})|(\bAKIA[0-9A-Z]{16}\b)|(\bxox[abposr]-[A-Za-z0-9-]{10,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
    message: "Looks like a credential. Never store secrets in memory.",
  },
  {
    rule: "secret-assignment",
    // The value immediately after the verb must be 8+ non-space chars containing
    // a digit. Digits are immune to the /i flag (a character class like [A-Z]
    // would silently fold to [A-Za-z] and match ordinary prose). So "the API key
    // is stored in .env" passes while "password is hunter2xyz" does not.
    test: /\b(password|passwd|secret|api[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|credential)s?\b\s*(?:is|are|=|:)\s*["'`]?(?=[^\s"'`]*[0-9])[^\s"'`]{8,}/i,
    message: "Looks like a credential value. Record where it lives, never what it is.",
  },
  {
    rule: "too-long",
    test: (t) => t.length > LIMITS.entryChars,
    message: `Over ${LIMITS.entryChars} chars. The index is one line per fact — put detail in a topic file with memory_write.`,
  },
  {
    rule: "commit-sha",
    // Hex run of 7-40 that contains a digit, so English words like "defaced" pass.
    test: /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/,
    message: "Contains a commit SHA. SHAs go stale immediately — describe the change, not the commit.",
  },
  {
    rule: "file-line",
    test: /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp|cs|php|swift|kt|sh|md|json|yaml|yml|toml|vue|svelte):\d+/i,
    message: "Contains a file:line reference. Line numbers move — name the function or module instead.",
  },
  {
    rule: "transient",
    test: /\b(currently|right now|at the moment|for now|as of now|so far|today|yesterday|this session)\b/i,
    message: "Describes a transient state. Memory should hold facts that stay true.",
  },
]

export function lintEntry(text) {
  const t = String(text ?? "").trim()
  if (!t) return { ok: false, rule: "empty", message: "Entry is empty." }
  for (const r of LINT_RULES) {
    const hit = typeof r.test === "function" ? r.test(t) : r.test.test(t)
    if (hit) return { ok: false, rule: r.rule, message: r.message }
  }
  return { ok: true }
}

// -------------------------------------------------------- similarity / conflicts

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have in into is it its of on or that the this to use used uses using with not no do does don't dont always never should must can").split(" "),
)

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

// Containment rather than Jaccard: a short entry fully covered by a longer one
// still scores high, which is exactly the contradiction case we care about.
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return { score: 0, shared: 0 }
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return { score: shared / Math.min(A.size, B.size), shared }
}

export function similarEntries(text, entries, { limit = 3, threshold = 0.4, minShared = 2 } = {}) {
  return entries
    .map((e) => ({ entry: e, ...similarity(text, e.text) }))
    .filter((s) => s.score >= threshold && s.shared >= minShared)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.entry)
}

// ------------------------------------------------------------- entry (de)serialise

const PROV = /\s*<!--\s*([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s*·\s*([^\s·]+))?(?:\s*·\s*([^\s·]+))?\s*-->\s*$/

export function parseEntry(line) {
  const m = /^\s*-\s+(.*)$/.exec(line)
  if (!m) return null
  let body = m[1]
  let date = null
  let session = null
  let agent = null
  const p = PROV.exec(body)
  if (p) {
    body = body.slice(0, p.index)
    date = p[1]
    session = p[2] || null
    agent = p[3] || null
  }
  let negative = false
  const neg = /^(?:✗|\[x\])\s+/.exec(body)
  if (neg) {
    negative = true
    body = body.slice(neg[0].length)
  }
  return { text: body.trim(), negative, date, session, agent }
}

export function formatEntry({ text, negative = false, date, session, agent }) {
  const prov = [date, session, agent].filter(Boolean).join(" · ")
  return `- ${negative ? "✗ " : ""}${String(text).trim()}${prov ? ` <!-- ${prov} -->` : ""}`
}

// A memory file is an ordered list of nodes so hand-written headings, blank
// lines and prose survive a read/modify/write cycle untouched.
export function parseMemoryFile(content) {
  return String(content ?? "")
    .split("\n")
    .map((line) => {
      const entry = parseEntry(line)
      return entry ? { type: "entry", ...entry } : { type: "raw", line }
    })
}

export function serializeMemoryFile(nodes) {
  return nodes.map((n) => (n.type === "entry" ? formatEntry(n) : n.line)).join("\n")
}

export function entriesOf(nodes) {
  return nodes.filter((n) => n.type === "entry")
}

// ----------------------------------------------------------------- frontmatter

// Deliberately minimal: only `description` (string) and `paths` (list). Not a
// YAML parser and not trying to be one.
export function parseFrontmatter(content) {
  const src = String(content ?? "")
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { data: {}, body: src }
  const data = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1]
    let value = kv[2].trim()
    if (value === "") {
      const list = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        list.push(unquote(lines[++i].replace(/^\s*-\s+/, "")))
      }
      data[key] = list
    } else if (value.startsWith("[")) {
      data[key] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
    } else {
      data[key] = unquote(value)
    }
  }
  return { data, body: src.slice(m[0].length) }
}

const unquote = (s) => s.replace(/^["']|["']$/g, "")

export function serializeFrontmatter(data, body) {
  const keys = Object.keys(data).filter((k) => data[k] != null && (!Array.isArray(data[k]) || data[k].length))
  if (!keys.length) return body
  const lines = keys.map((k) =>
    Array.isArray(data[k]) ? `${k}: [${data[k].map((v) => JSON.stringify(v)).join(", ")}]` : `${k}: ${data[k]}`,
  )
  return `---\n${lines.join("\n")}\n---\n${body}`
}

// ------------------------------------------------------------------ glob match

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function globToRegExp(glob) {
  let re = "^"
  for (let i = 0; i < glob.length; ) {
    const c = glob[i]
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"
        i += 3
      } else {
        re += ".*"
        i += 2
      }
    } else if (c === "*") {
      re += "[^/]*"
      i += 1
    } else if (c === "?") {
      re += "[^/]"
      i += 1
    } else if (c === "{") {
      const end = glob.indexOf("}", i)
      if (end === -1) {
        re += "\\{"
        i += 1
      } else {
        re += `(?:${glob.slice(i + 1, end).split(",").map(escapeRe).join("|")})`
        i = end + 1
      }
    } else {
      re += escapeRe(c)
      i += 1
    }
  }
  return new RegExp(re + "$")
}

export function matchesPaths(relPath, globs) {
  if (!Array.isArray(globs) || !globs.length) return false
  const p = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "")
  return globs.some((g) => globToRegExp(String(g).replace(/^\.\//, "")).test(p))
}

// --------------------------------------------------------------------- limits

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4)

export function checkIndexLimits(content) {
  const lines = String(content).split("\n").length
  const bytes = Buffer.byteLength(content, "utf8")
  const over = lines > LIMITS.indexLines || bytes > LIMITS.indexBytes
  const near = !over && (lines > LIMITS.indexLines * 0.8 || bytes > LIMITS.indexBytes * 0.8)
  return {
    lines,
    bytes,
    over,
    near,
    message: over
      ? `MEMORY.md is ${lines} lines / ${bytes} bytes, over the ${LIMITS.indexLines} line / ${LIMITS.indexBytes} byte load limit. Everything past the limit will NOT load next session. Rewrite the index: one line per fact, merge or drop stale entries, move detail into topic files.`
      : near
        ? `MEMORY.md is ${lines} lines / ${bytes} bytes, approaching the ${LIMITS.indexLines} line / ${LIMITS.indexBytes} byte load limit. Consider moving detail into topic files.`
        : null,
  }
}

// ---------------------------------------------------------------- staleness

export function daysBetween(from, to) {
  return Math.floor((to.getTime() - new Date(from + "T00:00:00Z").getTime()) / 86_400_000)
}

export function isStale(entry, now, staleDays = LIMITS.staleDays) {
  return Boolean(entry.date) && daysBetween(entry.date, now) > staleDays
}

// ------------------------------------------------------------------- protocol

export const PROTOCOL = `## Protocol
Memory persists across every session and is loaded once at session start.

SAVE with memory_append when:
- The user corrects you a second time on the same thing.
- You discover a build/test/run/deploy command that was not obvious.
- An approach fails — save it with negative=true so it is not retried.
- The user states a durable preference or constraint.

DO NOT SAVE:
- Anything you could rediscover by reading the codebase.
- Transient state: current branch, current task, line numbers, commit SHAs.
- Secrets, tokens, passwords. Record where a credential lives, never its value.
- Speculation. Save what you verified, not what you assume.

RULES:
- MEMORY.md is an index: one line per fact. Put detail in a topic file with
  memory_write and give it a description.
- A topic file with \`paths\` auto-loads whenever you read a matching file.
  Prefer that over adding to the index — it costs nothing until it is relevant.
- Entries marked [unverified since ...] are old. If you see evidence for or
  against one, correct it with memory_edit.
- scope "global" = facts about the user, true in every project.
  scope "project" = facts about this repository only.
- Do not mention memory operations unless asked.`

// --------------------------------------------------------------- block render

function renderEntries(entries, now, staleDays) {
  return entries.map((e) => {
    const stale = isStale(e, now, staleDays) ? ` [unverified since ${e.date.slice(0, 7)}]` : ""
    return `- ${e.negative ? "✗ " : ""}${e.text}${e.date ? ` [${e.date}]` : ""}${stale}`
  })
}

function fit(lines, budget) {
  const kept = []
  let used = 0
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  const omitted = lines.length - kept.length
  if (omitted > 0) kept.push(`- (${omitted} more not shown — over budget, run /memory and prune)`)
  return kept
}

export function renderBlock({
  globalEntries = [],
  projectEntries = [],
  projectName = "project",
  topics = [],
  now = new Date(),
  limits = LIMITS,
}) {
  const topicLines = topics.map((t) => {
    const size = t.bytes >= 1024 ? `${(t.bytes / 1024).toFixed(1)}KB` : `${t.bytes}B`
    const auto = t.paths?.length ? `  (auto-loads for ${t.paths.join(", ")})` : ""
    return `${t.scope}/${t.file}  ${size}  ${t.description || "(no description)"}${auto}`
  })

  const fixed =
    (topicLines.length ? `\n## Topic files — open with memory_read\n${topicLines.join("\n")}\n` : "\n") +
    `\n${PROTOCOL}\n</memory>`
  const header = `<memory>\n`
  const budget = limits.blockBytes - Buffer.byteLength(header + fixed, "utf8") - 128
  const globalLines = renderEntries(globalEntries, now, limits.staleDays)
  const projectLines = renderEntries(projectEntries, now, limits.staleDays)

  // Project facts are more actionable than global ones, so they get the larger
  // share when the budget binds.
  const globalBudget = Math.floor(budget * 0.4)
  const keptGlobal = fit(globalLines, globalBudget)
  const usedGlobal = keptGlobal.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0)
  const keptProject = fit(projectLines, budget - usedGlobal)

  const body =
    (keptGlobal.length ? `## About the user\n${keptGlobal.join("\n")}\n` : "") +
    (keptProject.length ? `\n## ${projectName}\n${keptProject.join("\n")}\n` : "") +
    (!keptGlobal.length && !keptProject.length ? "(no memory recorded yet)\n" : "")

  const draft = header + body + fixed
  const tokens = estimateTokens(draft)
  const text = draft.replace("<memory>", `<memory tokens≈${tokens}>`)
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    approxTokens: estimateTokens(text),
    truncated: keptGlobal.length < globalLines.length || keptProject.length < projectLines.length,
  }
}

export function renderPathScoped({ scope, file, paths, body, limit = LIMITS.pathScopedBytes }) {
  let content = String(body).trim()
  if (Buffer.byteLength(content, "utf8") > limit) {
    content = content.slice(0, limit) + "\n… (truncated — memory_read for the rest)"
  }
  return `<system-reminder>\nMemory for ${paths.join(", ")} (${scope}/${file}):\n${content}\n</system-reminder>`
}
