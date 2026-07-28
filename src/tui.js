// Marginalia — the /memory modal.
//
// This is the TUI half of the plugin (exports["./tui"], registered in tui.json).
// It runs on the TUI main thread, in a different realm from the server plugin —
// they share no state and communicate only through the filesystem. Data is read
// directly with node:fs; nothing here costs an LLM call.
//
// Only the five high-level api.ui.* components are used. No @opentui imports, no
// custom renderables and no JSX, so this ships as plain JS with no build step and
// presents the smallest possible surface to an undocumented API.
import path from "node:path"
import * as core from "./core.js"
import { MEM_DIR, dirsFor, git, latestVersion, loadScope, manifest, repoRootFor } from "./store.js"

// The API is undocumented and version-dependent, so probe before relying on it
// and degrade to a toast rather than throwing into the TUI.
function dialogApi(api) {
  const ui = api?.ui
  if (
    typeof ui?.DialogSelect !== "function" ||
    typeof ui?.DialogAlert !== "function" ||
    typeof ui?.dialog?.replace !== "function" ||
    typeof ui?.dialog?.setSize !== "function"
  ) {
    api?.ui?.toast?.({ variant: "error", message: "Marginalia: this opencode build has no dialog API." })
    return null
  }
  return ui
}

// replace() resets the dialog size to "medium", so setSize must come after it.
function show(ui, render, size = "xlarge") {
  ui.dialog.replace(render)
  ui.dialog.setSize(size)
}

const toast = (api, message, variant = "info") => api.ui?.toast?.({ variant, message })

/** @param {import("@opencode-ai/plugin/tui").TuiPluginApi} api */
async function collect(api) {
  // worktree is the literal "/" when there is no project (see project.ts), so it
  // cannot be used as a plain truthiness fallback — opencode guards the same way.
  const paths = api.state?.path
  const cwd = (paths?.worktree && paths.worktree !== "/" ? paths.worktree : paths?.directory) || process.cwd()
  const repoRoot = repoRootFor(cwd)
  const dirs = dirsFor(repoRoot)
  const [global, project] = await Promise.all([loadScope(dirs, "global"), loadScope(dirs, "project")])
  const block = core.renderBlock({
    globalEntries: global.entries,
    projectEntries: project.entries,
    projectName: path.basename(repoRoot),
    topics: [...global.topics, ...project.topics],
    now: new Date(),
  })
  return { repoRoot, projectName: path.basename(repoRoot), global, project, block }
}

/** @param {import("@opencode-ai/plugin/tui").TuiPluginApi} api */
export async function showMenu(api) {
  const ui = dialogApi(api)
  if (!ui) return
  try {
    const { projectName, global, project, block } = await collect(api)
    const shape = {
      globalEntries: global.entries,
      projectEntries: project.entries,
      topics: [...global.topics, ...project.topics],
      projectName,
    }
    const options = core.buildOptions(shape).map((o) => ({ ...o, onSelect: () => route(api, { ...o.value, shape }) }))

    show(ui, () =>
      ui.DialogSelect({
        title: core.menuTitle({ ...shape, approxTokens: block.approxTokens }),
        placeholder: "Search memory…",
        options,
      }),
    )
  } catch (e) {
    toast(api, `Marginalia: ${e?.message ?? e}`, "error")
  }
}

function route(api, value) {
  switch (value?.kind) {
    case "entry":
      return showEntry(api, value.entry)
    case "topic":
      return showTopic(api, value.topic)
    case "help":
      return alert(api, "How memory works", core.HELP)
    case "cost":
      return showCost(api, value.shape)
    case "history":
      return showHistory(api)
    case "version":
      return showVersion(api)
    case "path":
      return showPath(api)
    default:
      return undefined
  }
}

// Detail views are terminal. DialogAlert runs onConfirm and then unconditionally
// calls dialog.clear(), so re-opening the menu from there would be wiped a line
// later — Enter and Escape both close, which is what an alert is meant to do.
function alert(api, title, message) {
  const ui = dialogApi(api)
  if (!ui) return
  show(ui, () => ui.DialogAlert({ title, message }))
}

/** @param {import("@opencode-ai/plugin/tui").TuiPluginApi} api */
async function showEntry(api, entry) {
  let session = null
  if (entry.session) {
    // Signature per @opencode-ai/sdk/v2 Session2.get: a flat { sessionID }, and
    // the timestamp lives at time.created. Losing the link only costs the
    // conversation reference, so it must never surface as an error.
    try {
      const res = await api.client.session.get({ sessionID: entry.session }, { throwOnError: true })
      const s = res?.data
      if (s) session = { title: s.title, created: s.time?.created, directory: s.directory }
    } catch {
      session = null
    }
  }
  alert(api, "Memory entry", core.formatProvenance(entry, session))
}

function showTopic(api, topic) {
  const limit = 2000
  const body = topic.body.trim()
  const shown =
    Buffer.byteLength(body, "utf8") > limit
      ? `${body.slice(0, limit)}\n\n… truncated — open ${path.join(MEM_DIR, topic.scope, topic.file)}`
      : body
  const head = topic.paths.length ? `auto-loads for ${topic.paths.join(", ")}\n\n` : ""
  alert(api, `${topic.scope}/${topic.file}`, head + shown)
}

function showCost(api, shape) {
  const breakdown = core.costBreakdown(shape)
  const counts = {
    global: shape.globalEntries.length,
    project: shape.projectEntries.length,
    topics: shape.topics.length,
  }
  alert(api, "Context cost", core.formatCost(breakdown, shape.projectName, counts))
}

function showHistory(api) {
  const out = git(["log", "--no-decorate", "--date=short", "--format=%ad %s", "-n", "30"], MEM_DIR)
  alert(api, "Memory history", out || "Nothing has been written yet.")
}

async function showVersion(api) {
  const { name, version } = await manifest()
  let line
  try {
    const latest = await latestVersion(name)
    line =
      latest === version
        ? "Up to date."
        : `Update available: ${latest}\n\n  opencode plugin ${name}@${latest} --force\n\nThen restart opencode.`
  } catch {
    line = "Could not determine the latest version (offline, or not yet published)."
  }
  alert(api, "Version", `${name} ${version}\n\n${line}`)
}

function showPath(api) {
  alert(api, "Storage", `${MEM_DIR}\n\nPlain markdown in a git repo. Safe to read, edit or delete by hand.`)
}

/** @type {import("@opencode-ai/plugin/tui").TuiPlugin} */
export const MarginaliaTui = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette", // required, or the command is invisible to / and the palette
        name: "marginalia.memory",
        title: "Memory",
        desc: "Browse persistent agent memory",
        category: "Memory",
        slashName: "memory",
        run: () => {
          showMenu(api)
        },
      },
    ],
  })
}

export default { id: "marginalia-tui", tui: MarginaliaTui }
