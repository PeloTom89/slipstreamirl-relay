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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
