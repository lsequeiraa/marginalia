// Root shim for local directory installs.
//
// When a plugin is referenced by directory path rather than package name, v2
// resolves the entry points by joining the path — `<dir>/server` and `<dir>/tui`
// — and does not consult package.json "exports". The exports map still covers
// npm consumers; these two files cover `"plugins": ["/path/to/marginalia"]`.
export { default } from "./src/index.js"
