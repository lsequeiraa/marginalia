# Development

```bash
git clone https://github.com/lsequeiraa/marginalia && cd marginalia
bun install
bun test
bun run typecheck # tsc as a checker; no build step, no emit
```

## Running from a checkout

Point opencode at the working copy. Use the **directory**, which picks up both halves at once:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["/absolute/path/to/marginalia"] }
```

For a directory target opencode joins the path directly (`<dir>/server`, `<dir>/tui`) and does **not** consult `package.json` `exports`. That is what the root `server.js` and `tui.js` shims are for; they re-export from `src/`. Published installs go through `exports` as normal.

Symlinking the checkout into `~/.config/opencode/plugins/` works too, and is the tidier option for local development, because CLI plugins are discovered as directories there. Do not do both, or it loads twice. Local plugins are keyed by mtime, so editing a file is enough to reload the CLI half; the server half needs a restart.

## Releasing

`.github/workflows/release.yml` publishes to npm when a `v*` tag reaches GitHub. It uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so there is no token to store or rotate, and the package is published with provenance.

```bash
# after bumping "version" in package.json and committing it
git tag v0.1.1
git push <github-remote> main v0.1.1
```

The workflow refuses a tag that does not match the version in `package.json`, then runs the typecheck and the tests before publishing.

## Design notes

- The injected block is **pushed** as a separate system entry, never written over `system[0]`, which holds the base prompt. The v1 rationale was prompt-cache breakpoints on the first two system messages; that specific claim has not been re-verified against v2, but pushing exactly one entry and leaving index 0 alone remains the conservative choice either way.
- The rendered block is cached per session and rebuilt only on compaction, so a memory write mid-session does not bust the KV cache.
- Path-scoped injection is deduplicated per session and re-armed after compaction. The reminder is appended to the `read` result as a text part of its own: opencode 2 returns read content as an array of parts, and the runtime prefers a string over that array, so turning it into a string would drop the file part of an image or PDF read. Accepting only string content is why topics silently stopped loading after the opencode 2 port.
- Every hook is wrapped in `try/catch`. A bug in a memory plugin must never break your session.
- The CLI half uses only the promise-based `ui.dialog` helpers (no `@opentui` imports, no custom renderables, no JSX), so it needs no build step and stays plain JS. The one place that takes care is command registration: `keymap.layer()` needs a live Solid owner, so it is called from inside a headless `ui.slot({ append: "app" })` claim whose render returns `null`, which is how every builtin does it. Failures degrade to a toast; memory itself never depends on the CLI half.
- `engines.opencode` is deliberately **not** declared. opencode 2 betas version as `0.0.0-beta-<n>`, and semver compares that prerelease tag as a single string, so `beta-9999` sorts *above* `beta-19059` and any `>=` range breaks at a digit-count boundary. A constraint that silently excludes the runtime it was written for is worse than none; the `@opencode/plugin` peer dependency carries the real floor.
- CI runs `tsc` as a checker over the plain JavaScript (`checkJs`, `noEmit`). Misusing opencode's API (a wrong argument shape, a field that does not exist on a `Session`) fails the build instead of failing silently inside a `try/catch`. That is not hypothetical: it is how the two bugs in `0.1.0`'s provenance lookup were found.
