// Read-only access to opencode's session database, shared by `marginalia why`
// and `marginalia dream`. Nothing here writes to it.
//
// opencode 2 keeps sessions in `session_v2` and `session_message` (one JSON row
// per message: user, assistant, synthetic, compaction, ...). Sessions recorded
// by opencode 1 live on in the legacy `session` / `message` / `part` tables and
// were never moved across, so lookups try v2 first and fall back to v1.
//
// Runs under either Bun or Node: bun:sqlite and node:sqlite are mutually
// exclusive built-ins, so the driver is selected at runtime.
import os from "node:os"
import path from "node:path"

export const DB_PATH = process.env.OPENCODE_DB || path.join(os.homedir(), ".local/share/opencode/opencode.db")

// Both drivers expose prepare() -> { get(...p), all(...p) }; only construction
// and the readonly option name differ.
export async function openDb(file = DB_PATH) {
  try {
    if (typeof Bun !== "undefined") {
      const { Database } = await import("bun:sqlite")
      return new Database(file, { readonly: true })
    }
    const { DatabaseSync } = await import("node:sqlite")
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

const hasTable = (db, name) => {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  } catch {
    return false
  }
}

const json = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * @param {any} db
 * @param {string} id
 * @returns {{ id: string, title: string, directory: string, created: number, agent?: string, parent?: string } | null}
 */
export function sessionInfo(db, id) {
  if (hasTable(db, "session_v2")) {
    const s = db.prepare("SELECT id, title, directory, time_created, agent, parent_id FROM session_v2 WHERE id = ?").get(id)
    if (s) return { id: s.id, title: s.title, directory: s.directory, created: s.time_created, agent: s.agent, parent: s.parent_id }
  }
  if (hasTable(db, "session")) {
    const s = db.prepare("SELECT id, title, directory, time_created, parent_id FROM session WHERE id = ?").get(id)
    if (s) return { id: s.id, title: s.title, directory: s.directory, created: s.time_created, parent: s.parent_id }
  }
  return null
}

// What the user typed, not the expanded prompt: v2 keeps both, and the expanded
// form carries pasted attachments.
const userText = (data) => data?.metadata?.displayText ?? data?.text ?? ""

export function firstUserText(db, id) {
  if (hasTable(db, "session_message")) {
    const row = db
      .prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1")
      .get(id)
    if (row) return userText(json(row.data))
  }
  if (hasTable(db, "message")) {
    const msg = db
      .prepare("SELECT id FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'user' ORDER BY time_created LIMIT 1")
      .get(id)
    if (msg) {
      const parts = db.prepare("SELECT data FROM part WHERE message_id = ? LIMIT 8").all(msg.id)
      return parts.map((r) => json(r.data)).find((d) => d?.type === "text" && d.text)?.text ?? ""
    }
  }
  return ""
}

// ------------------------------------------------------------------ sessions

/**
 * Sessions touched since `since` (ms), newest first, with what a dream needs to
 * decide which to read: how much the user said and what memory was written.
 * @param {any} db
 * @param {number} since
 * @param {{ exclude?: (s: any) => boolean, limit?: number }} [options]
 */
export function recentSessions(db, since, { exclude = () => false, limit = 500 } = {}) {
  if (!hasTable(db, "session_v2")) return []
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.directory, s.agent, s.parent_id, s.time_created, s.time_updated,
              (SELECT count(*) FROM session_message m WHERE m.session_id = s.id AND m.type = 'user') AS users
         FROM session_v2 s
        WHERE s.time_updated >= ?
        ORDER BY s.time_updated DESC
        LIMIT ?`,
    )
    .all(since, limit)
  return rows
    .map((s) => ({
      id: s.id,
      title: s.title ?? "",
      directory: s.directory,
      agent: s.agent ?? null,
      parent: s.parent_id ?? null,
      created: s.time_created,
      updated: s.time_updated,
      users: s.users,
    }))
    .filter((s) => !exclude(s))
}

// Every memory tool call since `since` (ms), across all sessions. One scan of
// the message table, narrowed by its time index; on a large database this is
// the slow part of a dream, so callers keep the window short.
export function memoryCalls(db, since) {
  if (!hasTable(db, "session_message")) return []
  const rows = db
    .prepare(
      `SELECT m.session_id AS session, m.time_created AS at, j.value AS part
         FROM session_message m, json_each(json_extract(m.data, '$.content')) j
        WHERE m.time_created >= ? AND m.type = 'assistant'
          AND m.data LIKE '%"name":"memory\\_%' ESCAPE '\\'
          AND json_extract(j.value, '$.type') = 'tool'
          AND json_extract(j.value, '$.name') LIKE 'memory\\_%' ESCAPE '\\'`,
    )
    .all(since)
  return rows.map((r) => {
    const part = json(r.part) ?? {}
    return {
      session: r.session,
      at: r.at,
      name: part.name,
      input: part.state?.input ?? {},
      output: contentText(part.state?.content),
      ok: part.state?.status === "completed",
    }
  })
}

// Reads that had a path-scoped topic attached, since `since` (ms), as
// "<scope>/<file>" -> count.
export function topicInjections(db, since) {
  if (!hasTable(db, "session_message")) return new Map()
  const rows = db
    .prepare(
      `SELECT m.data AS data FROM session_message m
        WHERE m.time_created >= ? AND m.type = 'assistant' AND m.data LIKE '%Memory for %'`,
    )
    .all(since)
  const counts = new Map()
  const re = /Memory for [^\n]*? \(((?:user|global|project)\/[^)\s]+\.md)\):/g
  for (const r of rows) for (const m of String(r.data).matchAll(re)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  return counts
}

// ---------------------------------------------------------------- transcripts

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => (p?.type === "text" ? p.text : p?.type === "file" ? `[file ${p.name ?? p.mime ?? ""}]` : ""))
    .filter(Boolean)
    .join("\n")
}

const clip = (s, n) => {
  const t = String(s ?? "")
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t
}

/**
 * One session as plain labelled text: what the user said, what the agent said,
 * and each tool call with its result. Reasoning is left out. Memory tool calls
 * are kept whole, because they are what a dream checks; other tool output is
 * clipped. Over `maxBytes`, other tool results are cut further and then the
 * middle of the session goes, so the beginning and the end survive.
 * @param {any} db
 * @param {string} id
 * @param {{ maxBytes?: number }} [options]
 */
export function renderTranscript(db, id, { maxBytes = 60_000 } = {}) {
  const info = sessionInfo(db, id)
  if (!info || !hasTable(db, "session_message")) return null
  const rows = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq").all(id)

  const render = (toolChars) => {
    const blocks = []
    for (const row of rows) {
      const data = json(row.data) ?? {}
      if (row.type === "user") blocks.push({ keep: true, text: `USER:\n${clip(userText(data), 6000)}` })
      else if (row.type === "compaction" && data.summary)
        blocks.push({ keep: true, text: `COMPACTION SUMMARY:\n${clip(data.summary, 4000)}` })
      else if (row.type === "synthetic" && !data.metadata?.instruction)
        blocks.push({ keep: false, text: `SYNTHETIC (${data.description ?? data.metadata?.source ?? "note"}):\n${clip(data.text, 1500)}` })
      else if (row.type === "assistant") {
        for (const part of data.content ?? []) {
          if (part.type === "text" && part.text?.trim()) blocks.push({ keep: true, text: `AGENT:\n${clip(part.text, 4000)}` })
          if (part.type !== "tool") continue
          const memory = String(part.name).startsWith("memory_")
          const input = JSON.stringify(part.state?.input ?? {})
          const output = part.state?.status === "completed" ? contentText(part.state?.content) : `ERROR: ${part.state?.error?.message ?? part.state?.status}`
          blocks.push({
            keep: memory,
            text: memory
              ? `TOOL ${part.name} ${input}\n→ ${output}`
              : `TOOL ${part.name} ${clip(input, 400)}\n→ ${toolChars ? clip(output, toolChars) : clip(output.split("\n")[0], 160)}`,
          })
        }
      }
    }
    return blocks
  }

  const head = `SESSION ${info.id}  "${info.title}"\ndirectory: ${info.directory}\nstarted: ${new Date(info.created).toISOString()}${info.agent ? `\nagent: ${info.agent}` : ""}\n`
  const join = (blocks) => [head, ...blocks.map((b) => b.text)].join("\n\n")
  let blocks = render(1200)
  let text = join(blocks)
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    blocks = render(0)
    text = join(blocks)
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    // Keep the start and the end, and every memory call and user message in
    // between, dropping other blocks from the middle outwards.
    const size = (b) => Buffer.byteLength(b.text, "utf8") + 2
    let total = blocks.reduce((n, b) => n + size(b), Buffer.byteLength(head, "utf8"))
    const drop = new Set()
    const mid = Math.floor(blocks.length / 2)
    for (let d = 0; d <= mid && total > maxBytes; d++) {
      for (const i of [mid - d, mid + d]) {
        if (i < 0 || i >= blocks.length || drop.has(i) || blocks[i].keep || total <= maxBytes) continue
        drop.add(i)
        total -= size(blocks[i])
      }
    }
    const kept = []
    let gap = 0
    blocks.forEach((b, i) => {
      if (drop.has(i)) return void gap++
      if (gap) kept.push({ keep: false, text: `[… ${gap} blocks left out to fit]` })
      gap = 0
      kept.push(b)
    })
    text = join(kept)
  }
  return { info, text, bytes: Buffer.byteLength(text, "utf8") }
}
