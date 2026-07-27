// Plugin entry point.
//
// Default-export only. opencode's legacy loader calls *every* exported value as
// a plugin factory — a stray named export would be invoked with (ctx, options),
// and a stray non-function export throws and takes the whole plugin down with it.
import { Marginalia } from "./plugin.js"

export default { id: "marginalia", server: Marginalia }
