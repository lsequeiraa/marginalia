// Read-side filesystem access, shared by the CLI and the TUI plugin.
//
// The server plugin deliberately does not import this, even though it needs the
// same git helper. Two reasons: MEM_DIR below is read from the environment at
// module scope and the test files set that per file, and the server must not
// block — it shares a process with every session the server hosts, so it uses an
// async git helper of its own rather than the synchronous one here.
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as core from "./core.js"

export const MEM_DIR = process.env.MARGINALIA_DIR || path.join(os.homedir(), ".local/share/marginalia")

export const read = (p) => fs.readFile(p, "utf8").then((s) => s, () => null)

export function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

// The git *common* directory, so every linked worktree of a repository resolves
// to the same memory. Falls back to the directory itself outside a repo.
export function repoRootFor(cwd) {
  const out = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)
  return out ? path.dirname(out) : cwd
}

// The checkout `cwd` is in, which for a linked worktree is not repoRootFor().
export function toplevelFor(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd) || cwd
}

// Which topics bear on the checkout at `toplevel`, decided the same way the
// server plugin decides it, so the modal and the CLI report the block it builds.
export function relevantFor(toplevel, topics) {
  const files = (git(["ls-files"], toplevel) ?? "").split("\n").filter(Boolean).slice(0, 20_000)
  return core.relevantTopics(topics, files, { root: toplevel, home: os.homedir() })
}

export function dirsFor(repoRoot) {
  return {
    user: path.join(MEM_DIR, "user"),
    global: path.join(MEM_DIR, "global"),
    project: path.join(MEM_DIR, "projects", core.projectKey(repoRoot)),
  }
}

export async function loadScope(dirs, scope) {
  const index = (await read(path.join(dirs[scope], "MEMORY.md"))) ?? ""
  const entries = core.entriesOf(core.parseMemoryFile(index))
  const topics = []
  for (const file of (await fs.readdir(dirs[scope]).then((n) => n, () => [])).sort()) {
    if (!file.endsWith(".md") || file === "MEMORY.md" || file.includes(".tmp-")) continue
    const content = (await read(path.join(dirs[scope], file))) ?? ""
    const { data, body } = core.parseFrontmatter(content)
    const stat = await fs.stat(path.join(dirs[scope], file)).catch(() => null)
    topics.push({
      scope,
      file,
      bytes: Buffer.byteLength(content, "utf8"),
      mtime: stat?.mtimeMs ?? 0,
      description: data.description || "",
      paths: Array.isArray(data.paths) ? data.paths : [],
      body,
    })
  }
  return { index, entries, topics }
}

// Installed version and package name, read from the shipped manifest.
export async function manifest() {
  const raw = await read(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"))
  try {
    const { name, version } = JSON.parse(raw)
    return { name, version }
  } catch {
    return { name: "opencode-marginalia", version: "unknown" }
  }
}

export async function latestVersion(name) {
  const res = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(5000) })
  const body = /** @type {{ version?: string }} */ (await res.json())
  if (!body?.version) throw new Error("no version in registry response")
  return body.version
}
