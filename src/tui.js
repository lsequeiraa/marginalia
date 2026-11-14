// Marginalia — the /memory modal.
//
// This is the CLI half of the plugin (exports["./tui"]). It runs inside the TUI
// process, in a different process from the server plugin — they share no state
// and communicate only through the filesystem. Data is read directly with
// node:fs; nothing here costs an LLM call.
//
// Plain JS: no @opentui imports, no JSX, no build step. That is deliberate and
// it is achievable — see the comment on setup() for the one place v2 makes it
// non-obvious.
import path from "node:path"
import * as core from "./core.js"
import { MEM_DIR, dirsFor, git, latestVersion, loadScope, manifest, repoRootFor } from "./store.js"

const MENU_SIZE = "xlarge"

// dialog.replace() resets the size to "medium", and the plugin API's show()
// passes no size — so setting it *before* opening is silently undone. The
// promise-returning helpers call show() synchronously, so the size has to be set
// after the call and before the await. Same trap as the v1 API, different shape.
function sized(pending, ui, size = MENU_SIZE) {
  ui.dialog.set({ size })
  return pending
}

/** @param {import("@opencode/plugin/tui").Plugin.Context} ctx */
async function collect(ctx) {
  const cwd = ctx.location?.directory || process.cwd()
  const repoRoot = repoRootFor(cwd)
  const dirs = dirsFor(repoRoot)
  const [user, global, project] = await Promise.all([
    loadScope(dirs, "user"),
    loadScope(dirs, "global"),
    loadScope(dirs, "project"),
  ])
  const projectName = path.basename(repoRoot)
  const block = core.renderBlock({
    userEntries: user.entries,
    globalEntries: global.entries,
    projectEntries: project.entries,
    projectName,
    topics: [...user.topics, ...global.topics, ...project.topics],
    now: new Date(),
  })
  return { repoRoot, projectName, user, global, project, block }
}

// core.buildOptions emits `footer` (entry date, topic size) because v1's
// DialogSelect rendered it. v2's select has no footer, so fold it into the
// description rather than lose it — core.js stays untouched either way.
//
// Listed field by field rather than spread: this is the whole v2 option
// contract, and forwarding stray keys into a schema-checked API is how you get
// a failure that points at the wrong thing.
/**
 * @returns {import("@opencode/plugin/tui/context").DialogSelectOption<any>}
 */
const toOption = (o) => ({
  title: o.title,
  value: o.value,
  description: [o.description, o.footer].filter(Boolean).join(" · ") || undefined,
  category: o.category,
  disabled: o.disabled,
})

/** @param {import("@opencode/plugin/tui").Plugin.Context} ctx */
export async function showMenu(ctx) {
  try {
    // v1's detail views were terminal because DialogAlert unconditionally
    // cleared the dialog afterwards. v2's dialogs are promises, so returning to
    // the menu is both possible and simpler to express — which is what the v1
    // comment said it wanted. Re-collecting each pass also keeps the list honest
    // after the memory files change underneath it.
    for (;;) {
      const { projectName, user, global, project, block } = await collect(ctx)
      const shape = {
        userEntries: user.entries,
        globalEntries: global.entries,
        projectEntries: project.entries,
        topics: [...user.topics, ...global.topics, ...project.topics],
        projectName,
      }

      const choice = await sized(
        ctx.ui.dialog.select({
          title: core.menuTitle({ ...shape, approxTokens: block.approxTokens }),
          placeholder: "Search memory…",
          options: core.buildOptions(shape).map(toOption),
        }),
        ctx.ui,
      )
      if (!choice) return
      await route(ctx, { ...choice, shape })
    }
  } catch (e) {
    ctx.ui.toast.show({ variant: "error", message: `Marginalia: ${e?.message ?? e}` })
  }
}

function route(ctx, value) {
  switch (value?.kind) {
    case "entry":
      return showEntry(ctx, value.entry, value.scope)
    case "topic":
      return showTopic(ctx, value.topic)
    case "help":
      return alert(ctx, "How memory works", core.HELP)
    case "cost":
      return showCost(ctx, value.shape)
    case "history":
      return showHistory(ctx)
    case "version":
      return showVersion(ctx)
    case "path":
      return showPath(ctx)
    default:
      return undefined
  }
}

const alert = (ctx, title, message) => sized(ctx.ui.dialog.alert({ title, message }), ctx.ui)

/** @param {import("@opencode/plugin/tui").Plugin.Context} ctx */
async function showEntry(ctx, entry, scope) {
  let session = null
  if (entry.session) {
    // Two shapes changed from v1 and both are silent if guessed wrong: get()
    // resolves to the SessionInfo directly rather than a { data } envelope, and
    // the working directory moved onto location. Losing the link only costs the
    // conversation reference, so it must never surface as an error.
    try {
      const s = await ctx.client.session.get({ sessionID: entry.session })
      if (s) session = { title: s.title, created: s.time?.created, directory: s.location?.directory }
    } catch {
      session = null
    }
  }
  await alert(ctx, "Memory entry", core.formatProvenance(entry, session, new Date(), scope))
}

function showTopic(ctx, topic) {
  const limit = 2000
  const body = topic.body.trim()
  const shown =
    Buffer.byteLength(body, "utf8") > limit
      ? `${body.slice(0, limit)}\n\n… truncated — open ${path.join(MEM_DIR, topic.scope, topic.file)}`
      : body
  const head = topic.paths.length ? `auto-loads for ${topic.paths.join(", ")}\n\n` : ""
  return alert(ctx, `${topic.scope}/${topic.file}`, head + shown)
}

function showCost(ctx, shape) {
  const breakdown = core.costBreakdown(shape)
  const counts = {
    user: shape.userEntries.length,
    global: shape.globalEntries.length,
    project: shape.projectEntries.length,
    topics: shape.topics.length,
  }
  return alert(ctx, "Context cost", core.formatCost(breakdown, shape.projectName, counts))
}

function showHistory(ctx) {
  const out = git(["log", "--no-decorate", "--date=short", "--format=%ad %s", "-n", "30"], MEM_DIR)
  return alert(ctx, "Memory history", out || "Nothing has been written yet.")
}

async function showVersion(ctx) {
  const { name, version } = await manifest()
  let line
  try {
    const latest = await latestVersion(name)
    line =
      latest === version
        ? "Up to date."
        : `Update available: ${latest}\n\n  opencode plugin add ${name}@${latest}\n\nThen restart opencode.`
  } catch {
    line = "Could not determine the latest version (offline, or not yet published)."
  }
  await alert(ctx, "Version", `${name} ${version}\n\n${line}`)
}

function showPath(ctx) {
  return alert(ctx, "Storage", `${MEM_DIR}\n\nPlain markdown in a git repo. Safe to read, edit or delete by hand.`)
}

/** @param {import("@opencode/plugin/tui").Plugin.Context} ctx */
export function setup(ctx) {
  // keymap.layer() needs a live Solid owner, and setup() runs outside one, so
  // registering directly here throws. Every builtin routes through a headless
  // slot claim for exactly this reason. The render function may return null —
  // no JSX and no @opentui dependency required, which is what keeps this file
  // plain JS.
  return ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "marginalia.memory",
            title: "Memory",
            description: "Browse persistent agent memory",
            group: "Memory",
            palette: true,
            slash: { name: "memory" },
            run: () => {
              showMenu(ctx)
            },
          },
        ],
      }))
      return null
    },
  })
}

export default { id: "marginalia.cli", setup }
