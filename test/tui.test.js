// Verifies the /memory modal wiring against a fake v2 CLI plugin context. A TUI
// plugin cannot be exercised headlessly, so this stands in for the parts a live
// TTY would otherwise be the only way to check.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "oc-tui-test-"))
const MEM = path.join(ROOT, "memory")
const WORK = path.join(ROOT, "repo")
await fs.mkdir(WORK, { recursive: true })

process.env.MARGINALIA_DIR = MEM
const { setup, showMenu } = await import("../src/tui.js")
const { projectKey } = await import("../src/core.js")

afterAll(() => fs.rm(ROOT, { recursive: true, force: true }))

const projectDir = path.join(MEM, "projects", projectKey(WORK))
let sessionResult

/**
 * Fake of the v2 plugin context, mirroring packages/tui/src/plugin/api.tsx.
 *
 * The control flow is inverted from v1: dialogs are promises, so a drill-down is
 * no longer "call onSelect", it is "answer the next select() call". `picks` is
 * the script — one title substring per menu the code opens. Running out of picks
 * answers `undefined`, which is what closing the dialog does and what ends the
 * menu loop.
 *
 * Kept deliberately strict, for the reason the v1 fake recorded: a fake more
 * permissive than the real component turns tests into false confidence.
 */
function makeCtx({ picks = [], location = { directory: WORK }, sessionGet } = {}) {
  const state = { size: undefined, selects: [], alerts: [], toasts: [], layers: [], slots: [], lookups: [] }
  let next = 0

  const ui = {
    dialog: {
      // The real select() goes through dialog.replace(), which resets the size
      // to "medium". Modelling that is the whole point of the size assertions.
      select: async (options) => {
        state.size = "medium"
        state.selects.push(options)
        const want = picks[next++]
        if (want === undefined) return undefined
        const option = options.options.find((o) => o.title.includes(want))
        if (!option) throw new Error(`no menu option matching ${JSON.stringify(want)}`)
        return option.value
      },
      alert: async (options) => {
        state.size = "medium"
        state.alerts.push(options)
      },
      set: ({ size }) => {
        state.size = size
      },
    },
    toast: { show: (t) => state.toasts.push(t) },
    slot: (claim) => {
      state.slots.push(claim)
      return () => {}
    },
  }

  return {
    state,
    ctx: {
      location,
      ui,
      keymap: { layer: (fn) => state.layers.push(fn()) },
      client: {
        session: {
          get:
            sessionGet ??
            // The v2 client resolves to the SessionInfo directly — there is no
            // { data } envelope — and the working directory lives on `location`.
            // Both differ from v1 and both fail silently if guessed wrong.
            (async (input) => {
              if (!input || typeof input.sessionID !== "string")
                throw new TypeError(`session.get expects { sessionID }, received ${JSON.stringify(input)}`)
              state.lookups.push(input)
              return sessionResult
            }),
        },
      },
    },
  }
}

const lastAlert = (s) => s.alerts.at(-1)
const menu = (s) => s.selects[0]
const row = (s, title) => menu(s).options.find((o) => o.title.includes(title))

beforeEach(async () => {
  await fs.rm(MEM, { recursive: true, force: true })
  await fs.mkdir(projectDir, { recursive: true })
  sessionResult = {
    id: "ses_abc",
    title: "Set up CI",
    time: { created: 1785189721601 },
    location: { directory: WORK },
  }
  await fs.writeFile(
    path.join(projectDir, "MEMORY.md"),
    "# Memory — repo\n- Test with `bun vitest run`. <!-- 2026-07-02 · ses_abc · build -->\n- ✗ Memoizing gave no gain. <!-- 2026-07-03 · ses_def · build -->\n",
  )
  await fs.writeFile(
    path.join(projectDir, "solver-perf.md"),
    '---\ndescription: Belt profiling\npaths: ["src/solver/**"]\n---\nAllocation is the bottleneck.\n',
  )
  // Deliberately ancient: a profile fact must never render as unverified.
  await fs.mkdir(path.join(MEM, "user"), { recursive: true })
  await fs.writeFile(
    path.join(MEM, "user", "MEMORY.md"),
    "# Memory — user\n- Prefers surgical diffs over refactors. <!-- 2020-01-01 · ses_abc · build -->\n",
  )
})

describe("command registration", () => {
  // keymap.layer() needs a live Solid owner, so setup() must not call it
  // directly — it registers a headless slot claim and layers from inside the
  // render. Asserting the indirection is the point: calling layer() straight
  // from setup() throws at runtime and nothing else here would catch it.
  test("registers /memory through a slot claim, not directly in setup", async () => {
    const { ctx, state } = makeCtx()
    setup(ctx)

    expect(state.layers).toHaveLength(0) // nothing registered yet
    expect(state.slots).toHaveLength(1)
    expect(state.slots[0].append).toBe("app")

    expect(state.slots[0].render()).toBeNull() // no JSX, so no @opentui dependency
    expect(state.layers).toHaveLength(1)

    const cmd = state.layers[0].commands[0]
    expect(cmd.slash.name).toBe("memory")
    expect(cmd.palette).toBe(true)
    expect(cmd.id).toBe("marginalia.memory") // palette and slash both require an id
    expect(cmd.title).toBeTruthy()
    expect(typeof cmd.run).toBe("function")
  })
})

describe("the menu", () => {
  test("lists entries and topic files, and reports its token cost", async () => {
    const { ctx, state } = makeCtx()
    await showMenu(ctx)
    expect(menu(state).title).toMatch(/^Memory\s+\d+ entries\s+·\s+1 topic\s+·\s+≈\d+ tokens of context$/)
    expect(row(state, "bun vitest run")).toBeDefined()
    expect(row(state, "Memoizing").title).toStartWith("✗ ")
    expect(row(state, "solver-perf.md").description).toContain("auto-loads for src/solver/**")
  })

  test("reads the profile scope and never ages it out", async () => {
    const { ctx, state } = makeCtx()
    await showMenu(ctx)
    const profile = row(state, "surgical diffs")
    expect(profile.category).toBe("About you")
    expect(profile.description).not.toContain("unverified")
  })

  test("the profile detail view does not claim the fact is unverified", async () => {
    const { ctx, state } = makeCtx({ picks: ["surgical diffs"] })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain("learned    2020-01-01")
    expect(lastAlert(state).message).not.toContain("unverified")
  })

  // buildOptions still emits `footer` for v1's sake; v2's select has no such
  // field, so it is folded into the description instead of being dropped.
  test("keeps footer detail by folding it into the description", async () => {
    const { ctx, state } = makeCtx()
    await showMenu(ctx)
    expect(row(state, "bun vitest run").description).toContain("2026-07-02")
    for (const option of menu(state).options) {
      expect(Object.keys(option).sort()).toEqual(["category", "description", "disabled", "title", "value"])
    }
  })

  test("sets the dialog size after opening, not before", async () => {
    const { ctx, state } = makeCtx()
    await showMenu(ctx)
    // select() goes through replace(), which resets to medium; a size set
    // beforehand would be silently lost.
    expect(state.size).toBe("xlarge")
  })

  test("surfaces a failure as a toast rather than throwing into the TUI", async () => {
    const { ctx, state } = makeCtx()
    ctx.ui.dialog.select = async () => {
      throw new Error("host exploded")
    }
    await showMenu(ctx) // must not reject
    expect(state.toasts[0].variant).toBe("error")
    expect(state.toasts[0].message).toContain("host exploded")
  })

  test("renders on an empty store instead of throwing", async () => {
    await fs.rm(MEM, { recursive: true, force: true })
    const { ctx, state } = makeCtx()
    await showMenu(ctx)
    expect(menu(state).options[0].title.trim()).toBe("No memory recorded yet")
    expect(menu(state).title).toContain("0 entries")
  })

  test("closing the menu ends the loop instead of reopening forever", async () => {
    const { ctx, state } = makeCtx() // no picks: the first select answers undefined
    await showMenu(ctx)
    expect(state.selects).toHaveLength(1)
    expect(state.alerts).toHaveLength(0)
  })
})

describe("drilling into an entry", () => {
  test("resolves the source conversation and offers a resume command", async () => {
    const { ctx, state } = makeCtx({ picks: ["bun vitest run"] })
    await showMenu(ctx)
    expect(state.lookups).toEqual([{ sessionID: "ses_abc" }])
    expect(lastAlert(state).message).toContain("Set up CI")
    expect(lastAlert(state).message).toContain("2026-07-27") // from time.created
    expect(lastAlert(state).message).toContain("opencode --session ses_abc")
  })

  test("survives a client shape mismatch without surfacing an error", async () => {
    const { ctx, state } = makeCtx({
      picks: ["bun vitest run"],
      sessionGet: async () => {
        throw new Error("unknown method")
      },
    })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain("no longer in the database")
    expect(state.toasts).toHaveLength(0)
  })

  // v1 could not do this: DialogAlert cleared unconditionally after onConfirm,
  // so detail views were forced to be terminal. v2's dialogs are promises, so
  // the menu comes back — which is what the v1 comment said it wanted.
  test("returns to the menu after a detail view", async () => {
    const { ctx, state } = makeCtx({ picks: ["bun vitest run"] })
    await showMenu(ctx)
    expect(state.alerts).toHaveLength(1)
    expect(state.selects).toHaveLength(2) // reopened, then closed
  })
})

describe("topic files and utility rows", () => {
  test("shows a topic body with its path scope", async () => {
    const { ctx, state } = makeCtx({ picks: ["solver-perf.md"] })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain("auto-loads for src/solver/**")
    expect(lastAlert(state).message).toContain("Allocation is the bottleneck.")
  })

  test("truncates an oversized topic rather than overflowing the dialog", async () => {
    await fs.writeFile(path.join(projectDir, "big.md"), "---\ndescription: Big\n---\n" + "z".repeat(6000))
    const { ctx, state } = makeCtx({ picks: ["big.md"] })
    await showMenu(ctx)
    expect(lastAlert(state).message.length).toBeLessThan(2400)
    expect(lastAlert(state).message).toContain("truncated")
  })

  test("the empty-state row opens help rather than doing nothing", async () => {
    await fs.rm(MEM, { recursive: true, force: true })
    const { ctx, state } = makeCtx({ picks: ["No memory recorded yet"] })
    await showMenu(ctx)
    expect(lastAlert(state).title).toBe("How memory works")
    expect(lastAlert(state).message).toContain("start a message with #")
  })

  test("help is reachable from the utility rows too", async () => {
    const { ctx, state } = makeCtx({ picks: ["How memory works"] })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain("#global")
  })

  test("context cost explains where the tokens go", async () => {
    const { ctx, state } = makeCtx({ picks: ["Context cost"] })
    await showMenu(ctx)
    expect(lastAlert(state).title).toBe("Context cost")
    expect(lastAlert(state).message).toContain("protocol")
    expect(lastAlert(state).message).toContain("always injected")
    expect(lastAlert(state).message).toContain("2 entries") // the two seeded project facts
    expect(lastAlert(state).message).toContain("1 file") // the seeded topic
    expect(lastAlert(state).message).toContain("total")
  })

  test("history reports emptiness when nothing is versioned", async () => {
    const { ctx, state } = makeCtx({ picks: ["History"] })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain("Nothing has been written yet.")
  })

  test("storage row shows where the files live", async () => {
    const { ctx, state } = makeCtx({ picks: ["Storage folder"] })
    await showMenu(ctx)
    expect(lastAlert(state).message).toContain(MEM)
  })
})
