// Server plugin entry point.
//
// v2's loader validates a single default export with `{ id, setup }` — the v1
// `{ id, server }` shape is rejected outright with "Plugin must export a default
// definition with an id and an effect or setup function".
import { Marginalia } from "./plugin.js"

export default { id: "marginalia", setup: Marginalia }
