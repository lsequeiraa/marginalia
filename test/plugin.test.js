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

let hooks
let projectDir
let cleanup

const ctx = { sessionID: "ses_test01", agent: "build", messageID: "msg_1", id: "call_1" }
const call = async (name, args) => (await hooks.tool[name].execute(args, ctx)).content

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * Fake v2 plugin context, plus a thin adapter that presents the registrations
 * back in the v1 hook-map shape the assertions below already speak. The adapter
 * exists to keep this file about *behaviour*; the API translation it performs
 * mirrors exactly what src/plugin.js now does against the real runtime.
 */
function harness() {
  const tools = {}
  const session = {}
  const toolHooks = {}
  const queue = []
  let wake = () => {}
  let closed = false

  // Every registration hands back a disposer. Tracking them is how the cleanup
  // test proves the plugin tears its own hooks down instead of leaving them
  // bound to a dead closure after a reload.
  const registered = []
  const disposed = []
  const reg = (label) => {
    registered.push(label)
    return { dispose: async () => void disposed.push(label) }
  }

  const context = {
    location: { directory: WORK },
    tool: {
      transform: async (fn) => (fn({ add: (t) => void (tools[t.name] = t) }), reg("tool.transform")),
      hook: async (name, fn) => ((toolHooks[name] ??= []).push(fn), reg(`tool.${name}`)),
    },
    session: { hook: async (name, fn) => ((session[name] ??= []).push(fn), reg(`session.${name}`)) },
    event: {
      subscribe: ({ signal } = {}) => {
        signal?.addEventListener("abort", () => {
          closed = true
          wake()
        })
        return {
          async *[Symbol.asyncIterator]() {
            while (!closed) {
              if (queue.length) yield queue.shift()
              else await new Promise((r) => (wake = r))
            }
          },
        }
      },
    },
  }

  const run = (list, event) => Promise.all((list ?? []).map((fn) => fn(event)))

  const adapter = {
    tool: tools,
    registered,
    disposed,

    // Direct access, for the cases the v1-shaped adapter below cannot express:
    // a non-"completed" status, or content that is not a string.
    toolAfter: (event) => run(toolHooks["execute.after"], event),

    // v1 pushed bare strings onto output.system; v2 pushes SystemPart objects.
    "experimental.chat.system.transform": (input, output) =>
      run(session.context, { sessionID: input.sessionID, system: output.system }),

    // v1 mutated output.output in place. v2 hands over a Tool.Result whose
    // fields are readonly, so the plugin replaces the object; copy it back.
    "tool.execute.after": async (input, output) => {
      const event = {
        tool: input.tool,
        sessionID: input.sessionID,
        input: input.args,
        status: "completed",
        result: { content: output.output },
      }
      await run(toolHooks["execute.after"], event)
      output.output = event.result.content
    },

    // v1 rewrote a TextPart inside output.parts; v2 carries a single prompt.text.
    "chat.message": async (input, output) => {
      const part = (output.parts ?? []).find((p) => p.type === "text")
      const event = { sessionID: input.sessionID, prompt: { text: part?.text } }
      await run(session.prompt, event)
      if (part) part.text = event.prompt.text
    },

    // v1 delivered events through a hook; v2 through an async iterator.
    event: async ({ event }) => {
      queue.push(event)
      wake()
      await tick()
    },

    dispose: () => cleanup?.(),
  }

  return { context, adapter }
}

beforeEach(async () => {
  await fs.rm(MEM, { recursive: true, force: true })
  const { context, adapter } = harness()
  cleanup = await Marginalia(context)
  hooks = adapter
  // WORK is not a git repo, so repoRoot falls back to the worktree itself.
  projectDir = path.join(MEM, "projects", (await import("../src/core.js")).projectKey(WORK))
})

const dirOf = (scope) => (scope === "project" ? projectDir : path.join(MEM, scope))
const readMem = (scope, file = "MEMORY.md") => fs.readFile(path.join(dirOf(scope), file), "utf8").catch(() => null)

describe("memory_append", () => {
  test("writes an entry with provenance", async () => {
    const out = await call("memory_append", { scope: "project", entry: "Test with `bun vitest run`." })
    expect(out).toContain("Saved to project/MEMORY.md")
    const file = await readMem("project")
    expect(file).toContain("- Test with `bun vitest run`. <!--")
    expect(file).toContain("ses_test01 · build")
    expect(file).toMatch(/<!-- \d{4}-\d{2}-\d{2} /)
    // toast assertion removed: v2 has no server-side toast (see src/plugin.js)
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
    // toast assertion removed: v2 has no server-side toast (see src/plugin.js)
  })

  test("routes global scope to the global file", async () => {
    await call("memory_append", { scope: "global", entry: "Uses pnpm, not npm." })
    expect(await readMem("global")).toContain("Uses pnpm, not npm.")
    expect(await readMem("project")).toBe(null)
    expect(await readMem("user")).toBe(null)
  })

  test("routes user scope to its own file, not the global one", async () => {
    await call("memory_append", { scope: "user", entry: "Prefers surgical diffs over refactors." })
    expect(await readMem("user")).toContain("Prefers surgical diffs over refactors.")
    expect(await readMem("global")).toBe(null)
    expect(await readMem("project")).toBe(null)
  })

  test("an unknown scope falls to the project, never to the profile", async () => {
    await call("memory_append", { scope: "nonsense", entry: "Deploys to fly.io on merge to main." })
    expect(await readMem("project")).toContain("Deploys to fly.io on merge to main.")
    expect(await readMem("user")).toBe(null)
  })

  test("rejects a lint violation without writing anything", async () => {
    const out = await call("memory_append", { scope: "project", entry: "broken since a1b2c3d" })
    expect(out).toStartWith("REJECTED (commit-sha)")
    expect(out).toContain("Not saved")
    expect(await readMem("project")).toBe(null)
    // toast assertion removed: v2 has no server-side toast (see src/plugin.js)
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

  // The warning that used to fire here measured the file against its 25KB load
  // limit, while the block shows far less than that. What matters is whether
  // the entry will be seen.
  test("says when the section no longer shows every entry, and stays quiet before", async () => {
    const quiet = await call("memory_append", { scope: "project", entry: "A first durable fact." })
    expect(quiet).not.toContain("Session start shows")

    const fact = (i) => `- Durable fact number ${i} about how this repository builds, tests and deploys, with the flags it needs.`
    const many = Array.from({ length: 180 }, (_, i) => fact(i)).join("\n")
    await fs.writeFile(path.join(projectDir, "MEMORY.md"), `# Memory\n${many}\n`)
    const out = await call("memory_append", { scope: "project", entry: "One more durable fact." })
    expect(out).toMatch(/Session start shows \d+ of 181 /)
    expect(out).toContain("first to go")
    expect(out).not.toContain("approaching")
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
    await expect(call("memory_write", { scope: "project", file: "../escape.md", content: "x" })).rejects.toThrow(/bare file name/)
    await expect(call("memory_write", { scope: "project", file: "/etc/passwd.md", content: "x" })).rejects.toThrow(/bare file name/)
    await expect(call("memory_read", { scope: "project", file: "notes.txt" })).rejects.toThrow(/end in .md/)
  })
})

describe("memory_search", () => {
  beforeEach(async () => {
    await call("memory_append", { scope: "global", entry: "Forgejo cannot resolve a review thread over its API." })
    await call("memory_append", { scope: "user", entry: "Prefers surgical diffs over refactors." })
    await call("memory_write", {
      scope: "project",
      file: "deploy.md",
      description: "How this repository deploys",
      content: "# Deploy\nThe pipeline needs DOCKER_BUILDKIT=1.\nUnrelated line.",
    })
  })

  test("finds index entries and topic lines across every scope", async () => {
    const out = await call("memory_search", { query: "forgejo review" })
    expect(out).toContain("global/MEMORY.md")
    expect(out).toContain("Forgejo cannot resolve a review thread over its API.")
    expect(out).not.toContain("<!--") // provenance stays out of the snippet
    const deploy = await call("memory_search", { query: "buildkit" })
    expect(deploy).toContain("project/deploy.md  How this repository deploys")
    expect(deploy).toContain("DOCKER_BUILDKIT=1")
    expect(deploy).not.toContain("Unrelated line")
  })

  test("can be limited to one scope", async () => {
    expect(await call("memory_search", { query: "surgical", scope: "global" })).toContain("No memory matches")
    expect(await call("memory_search", { query: "surgical", scope: "user" })).toContain("user/MEMORY.md")
  })

  test("says so when nothing matches", async () => {
    expect(await call("memory_search", { query: "kubernetes" })).toContain('No memory matches "kubernetes"')
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
    expect(out.system[1].text).toContain("bun vitest run")
    expect(out.system[1].text).toContain("## Protocol")
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
    expect(out.system[1].text).not.toContain("ses_test01")
    expect(out.system[1].text).toMatch(/\[\d{4}-\d{2}-\d{2}\]/)
  })

  test("puts each scope under its own heading", async () => {
    await call("memory_append", { scope: "user", entry: "Prefers surgical diffs over refactors." })
    await call("memory_append", { scope: "global", entry: "Forgejo cannot resolve a review thread over its API." })
    await call("memory_append", { scope: "project", entry: "Test with `bun vitest run`." })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_scopes", model: {} }, out)
    const text = out.system[1].text
    expect(text.indexOf("## About you")).toBeLessThan(text.indexOf("Prefers surgical diffs"))
    expect(text.indexOf("## Across projects")).toBeLessThan(text.indexOf("Forgejo cannot resolve"))
    expect(text.indexOf("Prefers surgical diffs")).toBeLessThan(text.indexOf("## Across projects"))
  })

  test("caches per session but a write invalidates it", async () => {
    const first = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_c", model: {} }, first)
    expect(first.system[1].text).toContain("no memory recorded yet")

    await call("memory_append", { scope: "project", entry: "A brand new fact." })
    const second = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_c", model: {} }, second)
    expect(second.system[1].text).toContain("A brand new fact.")
  })

  test("a large topic listing leaves room for the entries", async () => {
    await fs.mkdir(path.join(MEM, "global"), { recursive: true })
    for (let i = 0; i < 600; i++) {
      const body = `---\ndescription: Everything learned about tool number ${i}, with the traps that cost an afternoon.\n---\nbody\n`
      await fs.writeFile(path.join(MEM, "global", `tool-${i}.md`), body)
    }
    // Written by hand above, so it is the append that refreshes the topic cache.
    await call("memory_append", { scope: "user", entry: "Prefers surgical diffs over refactors." })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_topics", model: {} }, out)
    expect(out.system[1].text).toContain("Prefers surgical diffs over refactors.")
    expect(out.system[1].text).toContain("Also: global/tool-")
    expect(Buffer.byteLength(out.system[1].text)).toBeLessThanOrEqual(core.LIMITS.blockBytes)
  })

  test("advertises path-scoped topic files", async () => {
    await call("memory_write", { scope: "project", file: "t.md", content: "x", description: "d", paths: ["src/**"] })
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_d", model: {} }, out)
    expect(out.system[1].text).toContain("(auto-loads for src/**)")
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
    await hooks.event({ event: { type: "session.compaction.ended", data: { sessionID: "ses_p" } } })
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

  // Tool.Result.content is `string | Content[] | undefined`, and the runtime
  // prefers a non-empty string over both the array form and the `output`
  // fallback. Appending to the non-string forms would therefore not append at
  // all — it would replace an image or PDF payload with the reminder alone.
  test("leaves non-string content alone rather than replacing it", async () => {
    const array = [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "belt.png" },
    ]
    const event = {
      tool: "read",
      sessionID: "ses_img",
      input: { filePath: "src/solver/belt.ts" }, // matches the topic glob
      status: "completed",
      result: { content: array },
    }
    await hooks.toolAfter(event)
    expect(event.result.content).toBe(array) // untouched, file part intact

    const undefinedContent = { ...event, sessionID: "ses_undef", result: { output: { type: "file" } } }
    await hooks.toolAfter(undefinedContent)
    expect(undefinedContent.result.content).toBeUndefined()
  })

  test("ignores a failed tool call", async () => {
    const event = {
      tool: "read",
      sessionID: "ses_err",
      input: { filePath: "src/solver/belt.ts" },
      status: "error",
      error: { message: "nope" },
    }
    await hooks.toolAfter(event)
    expect(event.result).toBeUndefined()
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

  test("routes #global to cross-project knowledge", async () => {
    await capture("#global Uses pnpm, not npm.")
    expect(await readMem("global")).toContain("Uses pnpm, not npm.")
    expect(await readMem("project")).toBe(null)
    expect(await readMem("user")).toBe(null)
  })

  test("routes #me to the profile", async () => {
    await capture("#me I prefer surgical diffs over refactors.")
    expect(await readMem("user")).toContain("I prefer surgical diffs over refactors.")
    expect(await readMem("global")).toBe(null)
  })

  // "user" is too ordinary a noun to spend on a keyword. It used to route to
  // the global scope; it is now not a keyword at all, so the sentence survives
  // intact as a project fact instead of being mangled into the profile.
  test("does not treat #user as a keyword", async () => {
    await capture("#user avatars are cached in Redis.")
    expect(await readMem("project")).toContain("user avatars are cached in Redis.")
    expect(await readMem("user")).toBe(null)
    expect(await readMem("global")).toBe(null)
  })

  test("only strips a scope keyword, not a word that merely starts with one", async () => {
    await capture("#globally unique ids come from the ulid package.")
    expect(await readMem("project")).toContain("globally unique ids come from the ulid package.")
    expect(await readMem("global")).toBe(null)
  })

  // A word boundary alone let punctuation through, filing "-time is sacred" as
  // a fact about the person.
  test("a hyphenated word is not a scope keyword", async () => {
    await capture("#me-time is not a feature of this app.")
    expect(await readMem("project")).toContain("me-time is not a feature of this app.")
    expect(await readMem("user")).toBe(null)
  })

  test("still accepts a scope keyword punctuated with a colon", async () => {
    await capture("#me: I prefer surgical diffs over refactors.")
    expect(await readMem("user")).toContain("I prefer surgical diffs over refactors.")
  })

  // "#about the solver…" is an ordinary project note; treating it as a profile
  // fact would put a repository detail in front of every future session.
  test("does not treat #about as a profile prefix", async () => {
    await capture("#about half the solver time goes to allocation.")
    expect(await readMem("project")).toContain("about half the solver time goes to allocation.")
    expect(await readMem("user")).toBe(null)
  })

  test("tolerates the quoting opencode run adds to positional args", async () => {
    await capture('"#Prefers tabs over spaces."')
    expect(await readMem("project")).toContain("Prefers tabs over spaces.")
  })

  test("reports a rejection instead of saving", async () => {
    const rewritten = await capture("#broken since a1b2c3d")
    expect(rewritten).toContain("rejected")
    expect(await readMem("project")).toBe(null)
    // toast assertion removed: v2 has no server-side toast (see src/plugin.js)
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

describe("tool registration", () => {
  // The single most load-bearing property of the v2 port, and the most silently
  // breakable: the runtime splits tools into `direct` (callable by name) and
  // `codemode` (sandbox only) and DEFAULTS to codemode. Without this flag every
  // tool is advertised and every call fails "Unknown tool: <name>", with no
  // error at load time to point at the cause.
  test("every tool opts out of codemode so it is callable by name", () => {
    const names = Object.keys(hooks.tool).sort()
    expect(names).toEqual(["memory_append", "memory_edit", "memory_read", "memory_search", "memory_write"])
    for (const name of names) {
      expect(hooks.tool[name].options?.codemode).toBe(false)
    }
  })

  test("declares the arguments each tool actually requires", () => {
    const required = (name) => hooks.tool[name].input.required.slice().sort()
    expect(required("memory_read")).toEqual(["scope"])
    expect(required("memory_append")).toEqual(["entry", "scope"])
    expect(required("memory_write")).toEqual(["content", "file", "scope"])
    expect(required("memory_edit")).toEqual(["new", "old", "scope"])
    expect(required("memory_search")).toEqual(["query"])
  })
})

describe("git backing", () => {
  test("disposes every registration it made", async () => {
    expect(hooks.registered).toEqual([
      "tool.transform",
      "session.context",
      "tool.execute.after",
      "session.prompt",
    ])
    await hooks.dispose()
    // Reversed: teardown mirrors setup order.
    expect(hooks.disposed).toEqual(hooks.registered.slice().reverse())
  })

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
