// Read-side filesystem access, shared by the CLI and the TUI plugin.
//
// The server plugin does not use this: it already receives opencode's own shell
// helper and owns the write path. Everything here is read-only.
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

export function dirsFor(repoRoot) {
  return {
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
    topics.push({
      scope,
      file,
      bytes: Buffer.byteLength(content, "utf8"),
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
