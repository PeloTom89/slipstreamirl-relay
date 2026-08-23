# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Tests: `npm test` runs Node's built-in test runner (`node --test tools/*.test.mjs`) —
  no external test framework is installed. Put unit-testable logic under `tools/*.mjs`
  with a matching `tools/*.test.mjs`.
- `.github/workflows/strava-youtube-comment.yml` has no companion `.js`/`.mjs` file —
  its logic is a `node --input-type=module <<'EOF' ... EOF` heredoc inline in the YAML
  `run:` step. GitHub Actions `run:` steps execute with cwd = the checked-out repo root,
  so that heredoc can `import` a normal repo-relative path (e.g. `./tools/road-names.mjs`)
  and does — this is how testable logic gets shared with that workflow without duplicating
  it inline.
- `server.js` supports an opt-in multi-tenant mode (`MULTI_TENANT=1` +
  `RELAY_JWT_SECRET`) — see README.md "Multi-tenant mode" for the contract and
  ROADMAP.md "Big bet" for what's still open. Default (mode off) behaviour is
  covered by `tools/relay-server.test.mjs`'s "single-tenant mode" suite, which
  exists specifically to prove the opt-in flag didn't change the default path.
- **The broadcast/channel hazard.** `broadcast()`/`emit()` in `server.js`
  rebuild every payload from scratch rather than forwarding it, and take an
  explicit `channel` state bundle rather than closing over module state. This
  means there are now **two** independent ways a new message type can go
  wrong, not one: (1) the pre-existing hazard — a field not explicitly handled
  in both `/push` validation and `broadcast()`/`emit()` is silently dropped
  (this was a real bug, hence the warning in README.md/ROADMAP.md); (2) the
  channel-routing version of the same class of bug — a message reaching the
  wrong channel's overlays, or no channel at all, because some new code path
  reads/writes a `last*` field on the wrong `channel` object or bypasses the
  channel argument. Neither fails loudly. Any change to `emit()`/`broadcast()`
  needs a cross-channel isolation test added to `tools/relay-server.test.mjs`
  covering the new/changed message type, following the existing
  `MESSAGE_CASES` pattern there — not just a single-channel functional test.
- `tools/channel-token.js` is CommonJS (`.js`, not the `tools/*.mjs` convention
  `road-names.mjs` established) because `server.js` is CommonJS and needs to
  `require()` it synchronously at request time; a `.mjs` module can't be
  `require()`'d. Its test file is still `tools/channel-token.test.mjs` per the
  `npm test` glob — Node's ESM loader can import CJS named exports from a
  plain `module.exports = {...}` object fine, confirmed working here.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
