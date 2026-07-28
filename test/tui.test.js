// Verifies the /memory modal wiring against a fake TuiPluginApi. A TUI plugin
// cannot be exercised headlessly, so this stands in for the parts a live TTY
// would otherwise be the only way to check.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "oc-tui-test-"))
const MEM = path.join(ROOT, "memory")
const WORK = path.join(ROOT, "repo")
await fs.mkdir(WORK, { recursive: true })

process.env.MARGINALIA_DIR = MEM
const { MarginaliaTui, showMenu } = await import("../src/tui.js")
const { projectKey } = await import("../src/core.js")

afterAll(() => fs.rm(ROOT, { recursive: true, force: true }))

const projectDir = path.join(MEM, "projects", projectKey(WORK))
let rendered, size, toasts, layers, sessionLookups, sessionResult

// The fake mirrors packages/tui/src/ui/{dialog,dialog-alert,dialog-select}.tsx.
// A fake that is more permissive than the real component turns tests into false
// confidence: an earlier version omitted the clear() that DialogAlert performs
// after onConfirm, and happily proved a back-navigation feature that could never
// have worked.
function makeApi(overrides = {}) {
  const { ui: uiOverrides, ...rest } = overrides
  const clear = () => {
    rendered = undefined
    size = "medium"
  }
  const ui = {
    // submit() calls the handlers and does NOT clear, so drill-down works.
    DialogSelect: (props) => ({ kind: "select", ...props }),
    // Enter and the ok button both run onConfirm?.() and then dialog.clear().
    DialogAlert: (props) => ({
      kind: "alert",
      ...props,
      confirm: () => {
        props.onConfirm?.()
        clear()
      },
    }),
    dialog: {
      replace: (render) => {
        size = "medium" // the real stack resets size on replace
        rendered = render()
      },
      setSize: (s) => {
        size = s
      },
      clear,
    },
    toast: (t) => toasts.push(t),
    ...uiOverrides,
  }
  return {
    ui,
    state: { path: { worktree: WORK } },
    client: {
      session: {
        // Mirrors @opencode-ai/sdk/v2 Session2.get: a FLAT { sessionID }, not
        // { path: { id } }, and the response nests the timestamp under time.created.
        // The previous fake accepted the shape I had guessed, so a lookup that
        // could never succeed against the real SDK tested green.
        get: async (params, opts) => {
          if (!params || typeof params.sessionID !== "string") {
            throw new TypeError(`session.get expects { sessionID }, received ${JSON.stringify(params)}`)
          }
          sessionLookups.push({ sessionID: params.sessionID, throwOnError: opts?.throwOnError })
          return { data: sessionResult }
        },
      },
    },
    keymap: { registerLayer: (layer) => (layers.push(layer), () => {}) },
    ...rest,
  }
}

const pick = (title) => rendered.options.find((o) => o.title.includes(title))

beforeEach(async () => {
  await fs.rm(MEM, { recursive: true, force: true })
  await fs.mkdir(projectDir, { recursive: true })
  rendered = undefined
  size = undefined
  toasts = []
  layers = []
  sessionLookups = []
  sessionResult = { id: "ses_abc", title: "Set up CI", time: { created: 1785189721601 }, directory: WORK }
  await fs.writeFile(
    path.join(projectDir, "MEMORY.md"),
    "# Memory — repo\n- Test with `bun vitest run`. <!-- 2026-07-02 · ses_abc · build -->\n- ✗ Memoizing gave no gain. <!-- 2026-07-03 · ses_def · build -->\n",
  )
  await fs.writeFile(
    path.join(projectDir, "solver-perf.md"),
    '---\ndescription: Belt profiling\npaths: ["src/solver/**"]\n---\nAllocation is the bottleneck.\n',
  )
})

describe("command registration", () => {
  test("registers a palette command reachable as /memory", async () => {
    await MarginaliaTui(makeApi())
    expect(layers).toHaveLength(1)
    const cmd = layers[0].commands[0]
    // namespace is mandatory or the command is invisible to both / and the palette
    expect(cmd.namespace).toBe("palette")
    expect(cmd.slashName).toBe("memory")
    expect(cmd.name).toBe("marginalia.memory")
    expect(typeof cmd.run).toBe("function")
    expect(cmd.title).toBeTruthy()
  })
})

describe("the menu", () => {
  test("lists entries and topic files, and reports its token cost", async () => {
    await showMenu(makeApi())
    expect(rendered.kind).toBe("select")
    expect(rendered.title).toMatch(/^Memory\s+\d+ entries\s+·\s+1 topic\s+·\s+≈\d+ tokens of context$/)
    expect(pick("bun vitest run")).toBeDefined()
    expect(pick("Memoizing").title).toStartWith("✗ ")
    expect(pick("solver-perf.md").description).toContain("auto-loads for src/solver/**")
  })

  test("sets the dialog size after replace, not before", async () => {
    await showMenu(makeApi())
    // replace() resets to medium; a size set beforehand would be lost
    expect(size).toBe("xlarge")
  })

  test("degrades to a toast when the host has no dialog API", async () => {
    await showMenu(makeApi({ ui: { DialogSelect: undefined } }))
    expect(rendered).toBeUndefined()
    expect(toasts[0].variant).toBe("error")
  })

  // worktree is the literal "/" outside a project, so it cannot be used as a
  // plain truthiness fallback or memory would be filed under the filesystem root.
  test("falls back to directory when worktree is the filesystem root", async () => {
    const api = makeApi({ state: { path: { worktree: "/", directory: WORK } } })
    await showMenu(api)
    expect(rendered.kind).toBe("select")
    expect(pick("bun vitest run")).toBeDefined() // resolved to the same project as before
  })

  test("stays silent rather than throwing when even toast is missing", async () => {
    await showMenu({ ui: {}, state: { path: { worktree: WORK } } })
    expect(rendered).toBeUndefined()
  })

  test("renders on an empty store instead of throwing", async () => {
    await fs.rm(MEM, { recursive: true, force: true })
    await showMenu(makeApi())
    expect(rendered.options[0].title.trim()).toBe("No memory recorded yet")
    expect(rendered.title).toContain("0 entries")
  })
})

describe("drilling into an entry", () => {
  test("resolves the source conversation and offers a resume command", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("bun vitest run").onSelect()
    expect(sessionLookups).toEqual([{ sessionID: "ses_abc", throwOnError: true }])
    expect(rendered.kind).toBe("alert")
    expect(rendered.message).toContain("Set up CI")
    expect(rendered.message).toContain("2026-07-27") // from time.created, not time_created
    expect(rendered.message).toContain("opencode --session ses_abc")
  })

  test("survives an SDK shape mismatch without surfacing an error", async () => {
    const api = makeApi()
    api.client.session.get = async () => {
      throw new Error("unknown method")
    }
    await showMenu(api)
    await pick("bun vitest run").onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.message).toContain("no longer in the database")
    expect(toasts).toHaveLength(0)
  })

  // DialogAlert clears unconditionally after onConfirm, so a detail view cannot
  // navigate anywhere — it can only close.
  test("detail views are terminal", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("bun vitest run").onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.onConfirm).toBeUndefined() // would be wiped by the clear() that follows
    rendered.confirm()
    expect(rendered).toBeUndefined()
  })
})

describe("topic files and utility rows", () => {
  test("shows a topic body with its path scope", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("solver-perf.md").onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.message).toContain("auto-loads for src/solver/**")
    expect(rendered.message).toContain("Allocation is the bottleneck.")
  })

  test("truncates an oversized topic rather than overflowing the dialog", async () => {
    await fs.writeFile(path.join(projectDir, "big.md"), "---\ndescription: Big\n---\n" + "z".repeat(6000))
    const api = makeApi()
    await showMenu(api)
    await pick("big.md").onSelect()
    expect(rendered.message.length).toBeLessThan(2400)
    expect(rendered.message).toContain("truncated")
  })

  test("the empty-state row opens help rather than doing nothing", async () => {
    await fs.rm(MEM, { recursive: true, force: true })
    const api = makeApi()
    await showMenu(api)
    const empty = rendered.options[0]
    expect(empty.title.trim()).toBe("No memory recorded yet")
    await empty.onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.title).toBe("How memory works")
    expect(rendered.message).toContain("start a message with #")
  })

  // The whole drill-down depends on DialogSelect.submit() calling handlers
  // without clearing. Nothing asserted it until this bit us elsewhere.
  test("selecting a menu option does not close the dialog", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("Storage folder").onSelect()
    expect(rendered).toBeDefined()
    expect(rendered.kind).toBe("alert")
  })

  test("help is reachable from the utility rows too", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("How memory works").onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.message).toContain("#global")
  })

  test("context cost explains where the tokens go", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("Context cost").onSelect()
    expect(rendered.kind).toBe("alert")
    expect(rendered.title).toBe("Context cost")
    expect(rendered.message).toContain("protocol")
    expect(rendered.message).toContain("always injected")
    expect(rendered.message).toContain("2 entries") // the two seeded project facts
    expect(rendered.message).toContain("1 file") // the seeded topic
    expect(rendered.message).toContain("total")
  })

  test("history reports emptiness when nothing is versioned", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("History").onSelect()
    expect(rendered.message).toContain("Nothing has been written yet.")
  })

  test("storage row shows where the files live", async () => {
    const api = makeApi()
    await showMenu(api)
    await pick("Storage folder").onSelect()
    expect(rendered.message).toContain(MEM)
  })
})
