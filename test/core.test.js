import { describe, expect, test } from "bun:test"
import {
  LIMITS,
  buildOptions,
  checkIndexLimits,
  daysBetween,
  entriesOf,
  estimateTokens,
  formatEntry,
  formatProvenance,
  globToRegExp,
  isStale,
  lintEntry,
  matchesPaths,
  parseEntry,
  parseFrontmatter,
  parseMemoryFile,
  projectKey,
  renderBlock,
  renderPathScoped,
  serializeFrontmatter,
  serializeMemoryFile,
  similarEntries,
  similarity,
  tokenize,
} from "../src/core.js"

describe("projectKey", () => {
  test("is stable and derived from the repo root", () => {
    expect(projectKey("/home/luigi/projects/endfield-calc")).toBe(projectKey("/home/luigi/projects/endfield-calc"))
    expect(projectKey("/home/luigi/projects/endfield-calc")).toStartWith("endfield-calc-")
  })
  test("distinguishes same-named repos in different places", () => {
    expect(projectKey("/a/endfield-calc")).not.toBe(projectKey("/b/endfield-calc"))
  })
  test("tolerates trailing slashes and odd characters", () => {
    expect(projectKey("/a/endfield-calc/")).toBe(projectKey("/a/endfield-calc"))
    expect(projectKey("/a/My Repo!")).toMatch(/^my-repo-[0-9a-f]{8}$/)
  })
  test("handles the filesystem root", () => {
    expect(projectKey("/")).toStartWith("root-")
  })
})

describe("lintEntry — rejects", () => {
  const rejected = {
    "secret-pattern": [
      "the key is sk-abcdefghijklmnopqrstuvwx",
      "token ghp_abcdefghijklmnopqrstuvwxyz12",
      "uses AKIA1234567890ABCDEF for s3",
      "slack hook xoxb-1234567890-abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
    ],
    "secret-assignment": ["db password is hunter2xyz", "API key = Ab3defghijkl", "secret: Zx99totallyreal"],
    "commit-sha": ["broken since a1b2c3d", "regression introduced in deadbe3f0011"],
    "file-line": ["bug lives in src/solver/belt.ts:412", "see app/main.py:17"],
    transient: [
      "currently on the feat/x branch",
      "the build is broken right now",
      "for now we skip the e2e suite",
      "so far only chrome is supported",
    ],
    "too-long": ["x".repeat(LIMITS.entryChars + 1)],
    empty: ["", "   "],
  }
  for (const [rule, samples] of Object.entries(rejected)) {
    for (const s of samples) {
      test(`${rule}: ${JSON.stringify(s.slice(0, 44))}`, () => {
        const r = lintEntry(s)
        expect(r.ok).toBe(false)
        expect(r.rule).toBe(rule)
        expect(r.message.length).toBeGreaterThan(10)
      })
    }
  }
})

describe("lintEntry — accepts", () => {
  const accepted = [
    "Uses pnpm, not npm, for all JS projects.",
    "Test with `bun vitest run`; lint with `bun run lint`.",
    "The API key is stored in .env, never commit it.",
    "Prefers surgical diffs and dislikes unrequested refactors.",
    "Memoizing the belt solver gave no gain — the bottleneck is allocation.",
    "Worktrees live on /mnt/d, not in .worktrees/.",
    "The defaced banner asset was replaced by the design team.",
    "Dev server runs on localhost:3000.",
    "The staging API is at api.example.com:8443.",
    "Prefer `rg` over grep when searching.",
    // Regressions: the /i flag once folded [0-9A-Z] to [0-9A-Za-z] and matched prose.
    "The auth token is rotated by ops every quarter.",
    "The API key is set in 1password under the shared vault.",
    "Credentials are managed by the deploy pipeline.",
  ]
  for (const s of accepted) {
    test(JSON.stringify(s.slice(0, 48)), () => {
      const r = lintEntry(s)
      expect(r).toEqual({ ok: true })
    })
  }
  test("boundary: exactly at the length limit passes", () => {
    expect(lintEntry("y".repeat(LIMITS.entryChars)).ok).toBe(true)
  })
})

describe("similarity", () => {
  test("catches a direct contradiction", () => {
    expect(similarity("Uses pnpm, not npm, for all JS projects.", "Uses npm for JS projects.").score).toBeGreaterThan(0.4)
  })
  test("ignores unrelated entries", () => {
    expect(similarity("Test with bun vitest run.", "Prefers dark mode in the editor.").score).toBe(0)
  })
  test("empty input scores zero rather than dividing by zero", () => {
    expect(similarity("", "anything at all").score).toBe(0)
    expect(similarity("the a of", "an it is").score).toBe(0)
  })
  test("tokenize drops stopwords and punctuation", () => {
    expect(tokenize("Uses the pnpm, not npm!")).toEqual(["pnpm", "npm"])
  })
})

describe("similarEntries", () => {
  const entries = [
    { text: "Uses npm for JS projects." },
    { text: "Test with bun vitest run." },
    { text: "Prefers dark mode." },
  ]
  test("surfaces the conflicting entry only", () => {
    const hits = similarEntries("Uses pnpm, not npm, for all JS projects.", entries)
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe("Uses npm for JS projects.")
  })
  test("returns nothing when there is no overlap", () => {
    expect(similarEntries("Deploys via fly.io on merge.", entries)).toHaveLength(0)
  })
  test("respects the limit", () => {
    const many = Array.from({ length: 10 }, () => ({ text: "Uses npm for JS projects." }))
    expect(similarEntries("Uses npm for JS projects.", many, { limit: 3 })).toHaveLength(3)
  })
  test("a single shared token is not enough", () => {
    expect(similarEntries("npm", [{ text: "npm" }])).toHaveLength(0)
  })
})

describe("entry round-trip", () => {
  test("parses full provenance", () => {
    expect(parseEntry("- Uses pnpm. <!-- 2026-07-27 · ses_5b0a31 · build -->")).toEqual({
      text: "Uses pnpm.",
      negative: false,
      date: "2026-07-27",
      session: "ses_5b0a31",
      agent: "build",
    })
  })
  test("parses a negative entry", () => {
    const e = parseEntry("- ✗ Memoizing gave no gain. <!-- 2026-07-01 · ses_9f -->")
    expect(e.negative).toBe(true)
    expect(e.text).toBe("Memoizing gave no gain.")
    expect(e.agent).toBe(null)
  })
  test("parses a hand-written entry with no provenance", () => {
    expect(parseEntry("- Just a plain fact")).toMatchObject({ text: "Just a plain fact", date: null, session: null })
  })
  test("ignores non-entry lines", () => {
    expect(parseEntry("## Heading")).toBe(null)
    expect(parseEntry("")).toBe(null)
    expect(parseEntry("plain prose")).toBe(null)
  })
  test("format(parse(x)) === x", () => {
    const line = "- ✗ Memoizing gave no gain. <!-- 2026-07-01 · ses_9f2c11 · build -->"
    expect(formatEntry(parseEntry(line))).toBe(line)
  })
  test("preserves headings, prose and blank lines through a file round-trip", () => {
    const src = ["# Memory", "", "Some prose.", "- A fact <!-- 2026-01-01 · ses_a · build -->", "", "## Section", "- ✗ A failure"].join("\n")
    expect(serializeMemoryFile(parseMemoryFile(src))).toBe(src)
    expect(entriesOf(parseMemoryFile(src))).toHaveLength(2)
  })
})

describe("frontmatter", () => {
  test("parses inline arrays and strings", () => {
    const { data, body } = parseFrontmatter('---\ndescription: Belt notes\npaths: ["src/solver/**", "lib/*.ts"]\n---\nBody here\n')
    expect(data.description).toBe("Belt notes")
    expect(data.paths).toEqual(["src/solver/**", "lib/*.ts"])
    expect(body).toBe("Body here\n")
  })
  test("parses dash lists", () => {
    const { data } = parseFrontmatter("---\npaths:\n  - src/**\n  - test/**\n---\nx")
    expect(data.paths).toEqual(["src/**", "test/**"])
  })
  test("returns the whole document when there is no frontmatter", () => {
    expect(parseFrontmatter("no frontmatter here")).toEqual({ data: {}, body: "no frontmatter here" })
  })
  test("round-trips", () => {
    const out = serializeFrontmatter({ description: "d", paths: ["a/**"] }, "body")
    expect(parseFrontmatter(out)).toEqual({ data: { description: "d", paths: ["a/**"] }, body: "body" })
  })
  test("omits empty values entirely", () => {
    expect(serializeFrontmatter({ description: null, paths: [] }, "body")).toBe("body")
  })
})

describe("glob matching", () => {
  const cases = [
    ["src/solver/**", "src/solver/belt.ts", true],
    ["src/solver/**", "src/solver/deep/nested/belt.ts", true],
    ["src/solver/**", "src/solverX/belt.ts", false],
    ["src/solver/**", "app/src/solver/belt.ts", false],
    ["**/*.ts", "src/a/b.ts", true],
    ["**/*.ts", "b.ts", true],
    ["**/*.ts", "src/a/b.tsx", false],
    ["src/**/*.{ts,tsx}", "src/a/b.tsx", true],
    ["src/**/*.{ts,tsx}", "src/b.ts", true],
    ["src/**/*.{ts,tsx}", "src/b.js", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["a+b/*.ts", "a+b/c.ts", true],
  ]
  for (const [glob, path, want] of cases) {
    test(`${glob} vs ${path} → ${want}`, () => expect(globToRegExp(glob).test(path)).toBe(want))
  }
  test("matchesPaths normalises separators and ./ prefixes", () => {
    expect(matchesPaths("./src/solver/belt.ts", ["src/solver/**"])).toBe(true)
    expect(matchesPaths("src\\solver\\belt.ts", ["src/solver/**"])).toBe(true)
  })
  test("matchesPaths is false for empty or missing globs", () => {
    expect(matchesPaths("a.ts", [])).toBe(false)
    expect(matchesPaths("a.ts", undefined)).toBe(false)
  })
})

describe("index limits", () => {
  test("flags a file over the line limit", () => {
    const r = checkIndexLimits("- x\n".repeat(LIMITS.indexLines + 10))
    expect(r.over).toBe(true)
    expect(r.message).toContain("will NOT load")
  })
  test("warns when approaching the limit", () => {
    const r = checkIndexLimits("- x\n".repeat(Math.floor(LIMITS.indexLines * 0.9)))
    expect(r.over).toBe(false)
    expect(r.near).toBe(true)
  })
  test("is silent for a small file", () => {
    const r = checkIndexLimits("- one fact\n")
    expect(r.over).toBe(false)
    expect(r.near).toBe(false)
    expect(r.message).toBe(null)
  })
  test("flags byte overflow even with few lines", () => {
    expect(checkIndexLimits("x".repeat(LIMITS.indexBytes + 1)).over).toBe(true)
  })
})

describe("staleness", () => {
  const now = new Date("2026-07-27T00:00:00Z")
  test("counts whole days", () => expect(daysBetween("2026-07-20", now)).toBe(7))
  test("old entries are stale", () => expect(isStale({ date: "2026-01-01" }, now)).toBe(true))
  test("recent entries are not", () => expect(isStale({ date: "2026-07-01" }, now)).toBe(false))
  test("undated entries are never stale", () => expect(isStale({ date: null }, now)).toBe(false))
  test("the boundary is exclusive", () => {
    expect(isStale({ date: "2026-04-28" }, now)).toBe(false) // exactly 90 days
    expect(isStale({ date: "2026-04-27" }, now)).toBe(true) // 91 days
  })
})

describe("renderBlock", () => {
  const now = new Date("2026-07-27T00:00:00Z")
  const base = {
    globalEntries: [{ text: "Uses pnpm, not npm.", date: "2026-07-01", negative: false }],
    projectEntries: [
      { text: "Test: `bun vitest run`.", date: "2026-07-02", negative: false },
      { text: "Memoizing the solver gave no gain.", date: "2026-07-03", negative: true },
      { text: "Worktrees live on /mnt/d.", date: "2026-01-20", negative: false },
    ],
    projectName: "endfield-calc",
    topics: [{ scope: "project", file: "solver-perf.md", bytes: 3400, description: "Belt profiling", paths: ["src/solver/**"] }],
    now,
  }

  test("contains every section and the protocol", () => {
    const { text } = renderBlock(base)
    expect(text).toContain("## About the user")
    expect(text).toContain("## endfield-calc")
    expect(text).toContain("## Topic files")
    expect(text).toContain("## Protocol")
    expect(text).toEndWith("</memory>")
  })
  test("marks negative entries and stale entries", () => {
    const { text } = renderBlock(base)
    expect(text).toContain("✗ Memoizing the solver gave no gain.")
    expect(text).toContain("[unverified since 2026-01]")
    expect(text).not.toContain("Test: `bun vitest run`. [2026-07-02] [unverified")
  })
  test("advertises path auto-loading", () => {
    expect(renderBlock(base).text).toContain("(auto-loads for src/solver/**)")
  })
  test("hides session ids from the rendered block", () => {
    const { text } = renderBlock({
      ...base,
      globalEntries: [{ text: "A fact.", date: "2026-07-01", session: "ses_secret123", negative: false }],
    })
    expect(text).not.toContain("ses_secret123")
    expect(text).toContain("[2026-07-01]")
  })
  test("reports its own token cost", () => {
    const { text, approxTokens } = renderBlock(base)
    expect(text).toContain("<memory tokens≈")
    expect(approxTokens).toBeGreaterThan(0)
  })
  test("stays under the hard byte cap and says what it dropped", () => {
    const many = Array.from({ length: 800 }, (_, i) => ({ text: `Fact number ${i} about the project.`, date: "2026-07-01" }))
    const r = renderBlock({ ...base, projectEntries: many, globalEntries: many })
    expect(r.bytes).toBeLessThanOrEqual(LIMITS.blockBytes)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain("more not shown")
    expect(r.text).toContain("## Protocol")
  })
  test("degrades gracefully when empty", () => {
    const r = renderBlock({ projectName: "empty", now })
    expect(r.text).toContain("(no memory recorded yet)")
    expect(r.text).toContain("## Protocol")
    expect(r.truncated).toBe(false)
  })
})

describe("renderPathScoped", () => {
  test("wraps content in a system-reminder", () => {
    const out = renderPathScoped({ scope: "project", file: "solver-perf.md", paths: ["src/solver/**"], body: "details" })
    expect(out).toStartWith("<system-reminder>")
    expect(out).toEndWith("</system-reminder>")
    expect(out).toContain("project/solver-perf.md")
    expect(out).toContain("details")
  })
  test("truncates oversized bodies", () => {
    const out = renderPathScoped({ scope: "project", file: "f.md", paths: ["**"], body: "z".repeat(5000) })
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(LIMITS.pathScopedBytes + 300)
    expect(out).toContain("truncated")
  })
})

describe("buildOptions (the /memory modal)", () => {
  const now = new Date("2026-07-27T00:00:00Z")
  const base = {
    globalEntries: [{ text: "Prefers surgical diffs.", date: "2026-07-01", negative: false, agent: "build" }],
    projectEntries: [
      { text: "Test: `bun vitest run`.", date: "2026-07-02", negative: false },
      { text: "Memoizing gave no gain.", date: "2026-07-03", negative: true },
      { text: "Worktrees live on /mnt/d.", date: "2026-01-20", negative: false },
    ],
    topics: [{ scope: "project", file: "solver-perf.md", bytes: 3400, description: "Belt profiling", paths: ["src/solver/**"] }],
    projectName: "endfield-calc",
    now,
  }
  const find = (opts, needle) => opts.find((o) => o.title.includes(needle))

  test("groups entries under About you, the project, and Topic files", () => {
    const o = buildOptions(base)
    expect(find(o, "surgical diffs").category).toBe("About you")
    expect(find(o, "bun vitest run").category).toBe("endfield-calc")
    expect(find(o, "solver-perf.md").category).toBe("Topic files")
  })

  test("marks negative entries and carries the entry through in value", () => {
    const o = find(buildOptions(base), "Memoizing")
    expect(o.title).toStartWith("✗ ")
    expect(o.value).toMatchObject({ kind: "entry", scope: "project" })
    expect(o.value.entry.negative).toBe(true)
  })

  test("flags stale entries in the description", () => {
    expect(find(buildOptions(base), "Worktrees").description).toContain("unverified since 2026-01")
    expect(find(buildOptions(base), "bun vitest run").description).not.toContain("unverified")
  })

  test("advertises path auto-loading on topic files", () => {
    expect(find(buildOptions(base), "solver-perf.md").description).toContain("auto-loads for src/solver/**")
  })

  test("always appends the utility rows", () => {
    const kinds = buildOptions(base).map((o) => o.value.kind)
    expect(kinds).toContain("history")
    expect(kinds).toContain("version")
    expect(kinds).toContain("path")
  })

  test("shows a helpful row when memory is empty", () => {
    const o = buildOptions({ projectName: "empty", now })
    expect(o[0].title).toBe("No memory recorded yet")
    expect(o[0].value.kind).toBe("noop")
    expect(o.map((x) => x.value.kind)).toContain("history")
  })

  test("every option has the shape DialogSelect requires", () => {
    for (const o of buildOptions(base)) {
      expect(typeof o.title).toBe("string")
      expect(o.title.length).toBeGreaterThan(0)
      expect(typeof o.category).toBe("string")
      expect(o.value).toBeDefined()
    }
  })

  test("tolerates being called with no arguments", () => {
    expect(buildOptions().length).toBeGreaterThan(0)
  })
})

describe("formatProvenance", () => {
  const now = new Date("2026-07-27T00:00:00Z")
  const entry = { text: "Test: `bun vitest run`.", negative: false, date: "2026-07-02", session: "ses_abc", agent: "build" }
  const session = { title: "Set up CI", time_created: 1785189721601, directory: "/home/luigi/projects/x" }

  test("renders the full trail when the session resolves", () => {
    const out = formatProvenance(entry, session, now)
    expect(out).toContain("Test: `bun vitest run`.")
    expect(out).toContain("learned    2026-07-02")
    expect(out).toContain("by         build")
    expect(out).toContain("Set up CI")
    expect(out).toContain("opencode --session ses_abc")
  })

  test("explains a session that no longer exists", () => {
    expect(formatProvenance(entry, null, now)).toContain("no longer in the database")
  })

  test("explains a hand-written entry with no session", () => {
    const out = formatProvenance({ ...entry, session: null }, null, now)
    expect(out).toContain("No source session recorded")
    expect(out).not.toContain("opencode --session")
  })

  test("notes staleness", () => {
    expect(formatProvenance({ ...entry, date: "2026-01-01" }, session, now)).toContain("unverified since then")
  })

  test("marks negative entries", () => {
    expect(formatProvenance({ ...entry, negative: true }, session, now)).toStartWith("✗ ")
  })
})

test("estimateTokens is proportional to bytes", () => {
  expect(estimateTokens("abcd")).toBe(1)
  expect(estimateTokens("")).toBe(0)
})
