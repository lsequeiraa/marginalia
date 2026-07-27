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

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)

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
function show(ui, render, size = "large") {
  ui.dialog.replace(render)
  ui.dialog.setSize(size)
}

const toast = (api, message, variant = "info") => api.ui?.toast?.({ variant, message })

async function collect(api) {
  const cwd = api.state?.path?.worktree || api.state?.path?.directory || process.cwd()
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

// The dialog stack has replace() only — no push/pop — so Escape from a leaf would
// otherwise close everything. Every sub-dialog gets an explicit way back.
function backOption(api) {
  return { title: "← Back", description: "Return to memory", category: "", value: { kind: "back" }, onSelect: () => showMenu(api) }
}

export async function showMenu(api) {
  const ui = dialogApi(api)
  if (!ui) return
  try {
    const { projectName, global, project, block } = await collect(api)
    const options = core
      .buildOptions({
        globalEntries: global.entries,
        projectEntries: project.entries,
        topics: [...global.topics, ...project.topics],
        projectName,
      })
      .map((o) => ({ ...o, onSelect: () => route(api, o.value) }))

    show(ui, () =>
      ui.DialogSelect({
        title: `Memory   ${kb(block.bytes)} ≈${block.approxTokens} tokens`,
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
    case "history":
      return showHistory(api)
    case "version":
      return showVersion(api)
    case "path":
      return showPath(api)
    case "back":
      return showMenu(api)
    default:
      return undefined
  }
}

function alert(api, title, message) {
  const ui = dialogApi(api)
  if (!ui) return
  show(ui, () => ui.DialogAlert({ title, message, onConfirm: () => showMenu(api) }))
}

async function showEntry(api, entry) {
  let session = null
  if (entry.session) {
    // The SDK shape differs between opencode versions; a failure here only costs
    // the conversation link, so it must never surface as an error.
    try {
      const res = await api.client?.session?.get?.({ path: { id: entry.session } })
      session = res?.data ?? res ?? null
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
