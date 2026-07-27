// Integration tests for src/plugin.js — tools, hooks, injection and git backing
// exercised against a real temporary filesystem.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import * as core from "../src/core.js"
import os from "node:os"
import path from "node:path"

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "oc-mem-test-"))
const MEM = path.join(ROOT, "memory")
const WORK = path.join(ROOT, "repo")
await fs.mkdir(WORK, { recursive: true })

// MEM_DIR is read at module scope, so the env var must be set before importing.
process.env.MARGINALIA_DIR = MEM
const { Marginalia } = await import("../src/plugin.js")

afterAll(() => fs.rm(ROOT, { recursive: true, force: true }))

let toasts = []
let hooks
let projectDir

const ctx = { sessionID: "ses_test01", agent: "build", directory: WORK, worktree: WORK }
const call = (name, args) => hooks.tool[name].execute(args, ctx)

beforeEach(async () => {
  await fs.rm(MEM, { recursive: true, force: true })
  toasts = []
  hooks = await Marginalia({
    client: { tui: { showToast: async ({ body }) => void toasts.push(body) } },
    worktree: WORK,
    $,
  })
  // WORK is not a git repo, so repoRoot falls back to the worktree itself.
  projectDir = path.join(MEM, "projects", (await import("../src/core.js")).projectKey(WORK))
})

const readMem = (scope, file = "MEMORY.md") =>
  fs.readFile(path.join(scope === "global" ? path.join(MEM, "global") : projectDir, file), "utf8").catch(() => null)

describe("memory_append", () => {
  test("writes an entry with provenance and toasts", async () => {
    const out = await call("memory_append", { scope: "project", entry: "Test with `bun vitest run`." })
    expect(out).toContain("Saved to project/MEMORY.md")
    const file = await readMem("project")
    expect(file).toContain("- Test with `bun vitest run`. <!--")
    expect(file).toContain("ses_test01 · build")
    expect(file).toMatch(/<!-- \d{4}-\d{2}-\d{2} /)
    expect(toasts[0].message).toContain("bun vitest run")
  })

  test("does not accumulate blank lines between entries", async () => {
    for (const e of ["First durable fact.", "Second durable fact.", "Third durable fact."]) {
      await call("memory_append", { scope: "project", entry: e })
    }
    const file = await readMem("project")
    expect(file).not.toContain("\n\n-") // no interior blank lines
    expect(file).toEndWith("\n") // POSIX trailing newline
    expect(file).not.toEndWith("\n\n") // but only one
    expect(core.checkIndexLimits(file).lines).toBe(5) // heading + 3 entries + trailing newline
  })

  test("marks negative entries", async () => {
    await call("memory_append", { scope: "project", entry: "Memoizing the solver gave no gain.", negative: true })
    expect(await readMem("project")).toContain("- ✗ Memoizing the solver gave no gain.")
    expect(toasts[0].message).toStartWith("✗")
  })

  test("routes global scope to the global file", async () => {
    await call("memory_append", { scope: "global", entry: "Uses pnpm, not npm." })
    expect(await readMem("global")).toContain("Uses pnpm, not npm.")
    expect(await readMem("project")).toBe(null)
  })

  test("rejects a lint violation without writing anything", async () => {
    const out = await call("memory_append", { scope: "project", entry: "broken since a1b2c3d" })
    expect(out).toStartWith("REJECTED (commit-sha)")
    expect(out).toContain("Not saved")
    expect(await readMem("project")).toBe(null)
    expect(toasts).toHaveLength(0)
  })

  test("rejects credentials", async () => {
    const out = await call("memory_append", { scope: "global", entry: "db password is hunter2xyz" })
    expect(out).toStartWith("REJECTED (secret-assignment)")
    expect(await readMem("global")).toBe(null)
  })

  test("surfaces a conflicting entry on the second append", async () => {
    await call("memory_append", { scope: "global", entry: "Uses npm for JS projects." })
    const out = await call("memory_append", { scope: "global", entry: "Uses pnpm, not npm, for all JS projects." })
    expect(out).toContain("Possibly related existing entries")
    expect(out).toContain("Uses npm for JS projects.")
    // Both are still written; reconciliation is the agent's job.
    expect((await readMem("global")).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2)
  })

  test("stays quiet when there is no conflict", async () => {
    await call("memory_append", { scope: "project", entry: "Deploys to fly.io on merge to main." })
    const out = await call("memory_append", { scope: "project", entry: "Prefers tabs over spaces." })
    expect(out).not.toContain("Possibly related")
  })

  test("warns once the index outgrows its load limit", async () => {
    const nodes = Array.from({ length: 205 }, (_, i) => `- Durable fact number ${i} about this repository.`).join("\n")
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), nodes + "\n")
    const out = await call("memory_append", { scope: "project", entry: "One more durable fact." })
    expect(out).toContain("will NOT load")
  })
})

describe("memory_write / memory_read", () => {
  test("round-trips a topic file with frontmatter", async () => {
    const out = await call("memory_write", {
      scope: "project",
      file: "solver-perf.md",
      content: "Allocation is the bottleneck, not arithmetic.",
      description: "Belt profiling",
      paths: ["src/solver/**"],
    })
    expect(out).toContain("Auto-loads for: src/solver/**")
    const raw = await readMem("project", "solver-perf.md")
    expect(raw).toStartWith("---\n")
    expect(raw).toContain('paths: ["src/solver/**"]')
    expect(await call("memory_read", { scope: "project", file: "solver-perf.md" })).toContain("Allocation is the bottleneck")
  })

  test("defaults memory_read to the index", async () => {
    await call("memory_append", { scope: "project", entry: "A durable fact." })
    expect(await call("memory_read", { scope: "project" })).toContain("A durable fact.")
  })

  test("reports a missing file rather than throwing", async () => {
    expect(await call("memory_read", { scope: "project", file: "nope.md" })).toContain("No such memory file")
  })

  test("refuses to clobber the index", async () => {
    expect(await call("memory_write", { scope: "project", file: "MEMORY.md", content: "x" })).toStartWith("REJECTED")
  })

  test("rejects path traversal and non-markdown names", async () => {
    expect(call("memory_write", { scope: "project", file: "../escape.md", content: "x" })).rejects.toThrow(/bare file name/)
    expect(call("memory_write", { scope: "project", file: "/etc/passwd.md", content: "x" })).rejects.toThrow(/bare file name/)
    expect(call("memory_read", { scope: "project", file: "notes.txt" })).rejects.toThrow(/end in .md/)
  })
})

describe("memory_edit", () => {
  test("replaces a unique string and re-stamps the date", async () => {
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), "# Memory\n- Uses npm. <!-- 2020-01-01 · ses_old · build -->\n")
    const out = await call("memory_edit", { scope: "project", old: "Uses npm.", new: "Uses pnpm." })
    expect(out).toContain("Updated project/MEMORY.md")
    const file = await readMem("project")
    expect(file).toContain("- Uses pnpm.")
    expect(file).not.toContain("2020-01-01")
    expect(file).toContain("ses_test01")
  })

  test("deletes an entry when the replacement is empty", async () => {
    await call("memory_append", { scope: "project", entry: "A fact to remove." })
    const line = (await readMem("project")).split("\n").find((l) => l.includes("A fact to remove"))
    await call("memory_edit", { scope: "project", old: line, new: "" })
    expect(await readMem("project")).not.toContain("A fact to remove")
  })

  test("refuses an ambiguous match", async () => {
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), "- dup\n- dup\n")
    expect(await call("memory_edit", { scope: "project", old: "dup", new: "x" })).toContain("appears 2 times")
  })

  test("refuses a missing match", async () => {
    await call("memory_append", { scope: "project", entry: "Something real." })
    expect(await call("memory_edit", { scope: "project", old: "absent", new: "x" })).toContain("not found")
  })
})

describe("system prompt injection", () => {
  test("appends exactly one entry and never touches system[0]", async () => {
    await call("memory_append", { scope: "project", entry: "Test with `bun vitest run`." })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_a", model: {} }, out)
    expect(out.system).toHaveLength(2)
    expect(out.system[0]).toBe("BASE")
    expect(out.system[1]).toContain("bun vitest run")
    expect(out.system[1]).toContain("## Protocol")
  })

  test("does nothing without a sessionID", async () => {
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ model: {} }, out)
    expect(out.system).toEqual(["BASE"])
  })

  test("hides session ids but shows dates", async () => {
    await call("memory_append", { scope: "global", entry: "Prefers surgical diffs." })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_b", model: {} }, out)
    expect(out.system[1]).not.toContain("ses_test01")
    expect(out.system[1]).toMatch(/\[\d{4}-\d{2}-\d{2}\]/)
  })

  test("caches per session but a write invalidates it", async () => {
    const first = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_c", model: {} }, first)
    expect(first.system[1]).toContain("no memory recorded yet")

    await call("memory_append", { scope: "project", entry: "A brand new fact." })
    const second = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_c", model: {} }, second)
    expect(second.system[1]).toContain("A brand new fact.")
  })

  test("advertises path-scoped topic files", async () => {
    await call("memory_write", { scope: "project", file: "t.md", content: "x", description: "d", paths: ["src/**"] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_d", model: {} }, out)
    expect(out.system[1]).toContain("(auto-loads for src/**)")
  })
})

describe("path-scoped injection", () => {
  const readResult = () => ({ title: "read", output: "FILE CONTENTS", metadata: {} })
  const readInput = (file, sessionID = "ses_p") => ({
    tool: "read",
    sessionID,
    callID: "c1",
    args: { filePath: path.join(WORK, file) },
  })

  beforeEach(async () => {
    await call("memory_write", {
      scope: "project",
      file: "solver-perf.md",
      content: "Allocation is the bottleneck.",
      description: "Belt profiling",
      paths: ["src/solver/**"],
    })
  })

  test("injects on a matching read", async () => {
    const out = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts"), out)
    expect(out.output).toStartWith("FILE CONTENTS")
    expect(out.output).toContain("<system-reminder>")
    expect(out.output).toContain("Allocation is the bottleneck.")
    expect(out.output).toContain("project/solver-perf.md")
  })

  test("stays silent on a non-matching read", async () => {
    const out = readResult()
    await hooks["tool.execute.after"](readInput("src/ui/button.tsx"), out)
    expect(out.output).toBe("FILE CONTENTS")
  })

  test("injects once per session, not on every read", async () => {
    const a = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts"), a)
    expect(a.output).toContain("<system-reminder>")
    const b = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/other.ts"), b)
    expect(b.output).toBe("FILE CONTENTS")
  })

  test("re-arms after compaction", async () => {
    const a = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts"), a)
    await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_p" } } })
    const b = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts"), b)
    expect(b.output).toContain("<system-reminder>")
  })

  test("tracks sessions independently", async () => {
    const a = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts", "ses_one"), a)
    const b = readResult()
    await hooks["tool.execute.after"](readInput("src/solver/belt.ts", "ses_two"), b)
    expect(b.output).toContain("<system-reminder>")
  })

  test("ignores non-read tools and files outside the repo", async () => {
    const a = readResult()
    await hooks["tool.execute.after"]({ ...readInput("src/solver/belt.ts"), tool: "bash" }, a)
    expect(a.output).toBe("FILE CONTENTS")
    const b = readResult()
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_q", args: { filePath: "/etc/hosts" } }, b)
    expect(b.output).toBe("FILE CONTENTS")
  })
})

describe("# capture", () => {
  const message = (text) => {
    const parts = [{ type: "text", text }]
    return { parts, input: { sessionID: "ses_h", agent: "build" } }
  }
  const capture = async (text) => {
    const m = message(text)
    await hooks["chat.message"](m.input, { parts: m.parts })
    return m.parts[0].text
  }

  test("captures to project scope and rewrites the turn", async () => {
    const rewritten = await capture("#Deploys to fly.io on merge to main.")
    expect(rewritten).toContain("Saved to project memory")
    expect(rewritten).toContain("Do nothing else.")
    expect(await readMem("project")).toContain("Deploys to fly.io on merge to main.")
  })

  test("routes #global to user scope", async () => {
    await capture("#global Uses pnpm, not npm.")
    expect(await readMem("global")).toContain("Uses pnpm, not npm.")
    expect(await readMem("project")).toBe(null)
  })

  test("tolerates the quoting opencode run adds to positional args", async () => {
    await capture('"#Prefers tabs over spaces."')
    expect(await readMem("project")).toContain("Prefers tabs over spaces.")
  })

  test("reports a rejection instead of saving", async () => {
    const rewritten = await capture("#broken since a1b2c3d")
    expect(rewritten).toContain("rejected")
    expect(await readMem("project")).toBe(null)
    expect(toasts.at(-1).variant).toBe("warning")
  })

  test("leaves ordinary messages alone", async () => {
    expect(await capture("please refactor the solver")).toBe("please refactor the solver")
    expect(await readMem("project")).toBe(null)
  })

  test("ignores pasted multi-line markdown headings", async () => {
    const text = "# Design doc\n\nSome long pasted content."
    expect(await capture(text)).toBe(text)
    expect(await readMem("project")).toBe(null)
  })

  test("ignores a bare hash", async () => {
    expect(await capture("#")).toBe("#")
  })
})

describe("git backing", () => {
  test("initialises a repo and commits on dispose", async () => {
    await call("memory_append", { scope: "project", entry: "A durable fact worth committing." })
    await hooks.dispose()
    const log = await $`git log --oneline`.cwd(MEM).quiet().nothrow()
    expect(log.exitCode).toBe(0)
    expect(log.stdout.toString()).toContain("memory:")
    const ignore = await fs.readFile(path.join(MEM, ".gitignore"), "utf8")
    expect(ignore).toContain("*.tmp-*")
  })
})

test("no temp files are left behind", async () => {
  await call("memory_append", { scope: "project", entry: "Another durable fact." })
  await call("memory_write", { scope: "project", file: "t.md", content: "body" })
  const names = await fs.readdir(projectDir)
  expect(names.filter((n) => n.includes(".tmp-"))).toHaveLength(0)
})
