# Mechanical documentation checks

Rules that a tool can check belong in the project's checks, not only in review. Propose the ones that fit the stack; adding a tool or dependency needs the user's agreement. Once agreed, add the command to the verification commands (`verify.json` or the Commands section of the agent manifest) and to CI, and remove the docs globs from `ignore` if the checks read docs.

| What | Tools (pick what the stack already uses) |
|---|---|
| Links and file references resolve | lychee, markdown-link-check |
| Markdown structure and style | markdownlint, Vale (prose rules: tense, banned words, ticket IDs) |
| Doc comments on exported API | eslint-plugin-jsdoc, TypeScript `--noEmit` with typedoc validation, detekt / ktlint (KDoc), SwiftLint (`missing_docs`), `go vet` + revive (`exported`), pydocstyle / ruff `D` rules |
| TODO/FIXME carry an issue or owner | a lint rule or a grep in CI |
| API reference matches the code | regenerate in CI (OpenAPI from schemas, typedoc, Dokka, DocC) and fail on a diff |
| Docs index is complete | a small script: every file under `docs/` is linked from `docs/README.md` |
| Working documents don't reach the base branch | the `working-docs` job from the ci-quality-gates templates |
