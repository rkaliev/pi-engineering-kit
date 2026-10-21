# Files the agent writes are in English

Status: plan approved (2026-10-21)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: d1f39ff35c259dd9ab9da0a1f3139561f47daa87 (pi edition: 5c57e17093fc8013e67619c62238bfe643422b50)
Links: the Claude edition (eng-kit) carries the same file on its `feat/docs-language` branch; the eval tasks run there

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

только у нас на русском создаеются adr, таски и прочее, я думаю лучше на английском строго любые документы которые нужны для агента должны создаваться на английском языке, кроме документации для пользователя
    если мы явно

Clarified in chat: "…не просим док для людей". In an existing repo whose docs are in another language: "Английский всегда". Also strictly English: "Коммиты и описания PR, Комментарии в коде, Имена тестов и сценарии BDD, Логи и сообщения об ошибках". Room in using-skills: "Короткое правило + ужатие".

</details>

## Intent

Everything an agent writes on its own (task files, plans, decision records, manifests, commits, PRs, code comments, test names, logs) is in English whatever language the user talks in, so agent-facing material stays uniform and precise; documentation for people is written in the user's language only when they explicitly ask for it.

## Context

The kit has no language rule. `writing-documentation` and `docs` say to follow the repo's existing docs language, and the templates leave test names' language to the project, so in a Russian conversation or a repo with Russian docs the agent writes Russian ADRs and task files.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | Asked in Russian, in a repo whose existing decision record is in Russian, to record a decision and commit it, the agent writes the new decision record with no Cyrillic | eval `docs-language`, grader `adr-english` (regex, file) plus `adr-written`; red on the current skills, green after |
| 2 | The commit message of that change has no Cyrillic | eval `docs-language`, grader `commit-english` (tool_used, max 0) plus `commit-made` (min 1) |
| 3 | A document for people that the user explicitly asks for in Russian is written in Russian | eval `docs-language`, grader `client-doc-russian` |
| 4 | The existing Russian decision record is neither translated nor rewritten | eval `docs-language`, grader `old-adr-kept` |
| 5 | The rule is in using-skills' "Always true" in both editions, and using-skills and writing-documentation stay within the 800-word body limit | `npm test` (lint-skills) in both repos |
| 6 | No kit text still tells the agent to follow the repo's docs language or to choose a test-name language | `grep -rn "docs language\|and language where\|Test names:"` over skills, prompts and templates returns nothing |
| 7 | Trimming the bootstrap does not lower skill loading | full eval suite, 1 run per case: the `skill-loaded` indicator in the kit arm is no lower than the last recorded run in `docs/EVALS.md` |

## Scope

**In scope:**
- both editions: using-skills, writing-documentation, the `docs` skill / `prompts/docs.md`, the CLAUDE.md / AGENTS.md template, the review checklist;
- the eval case `docs-language` and its grader tests (Claude edition; pi has no evals);
- ARCHITECTURE.md / .ru.md, EVALS.md, CHANGELOG, the private FRAMEWORK-SOURCES.ru.md, release 0.31.0.

**Out of scope:**
- a hook that detects Cyrillic in written files (rejected: false positives on requested docs and verbatim quotes);
- translating existing files in any project;
- the kit's own Russian user docs (`*.ru.md`), which are documentation for people.

## Decisions

1. Agent-written files are English always, including in a repo whose older docs use another language. Reason: user's choice, one predictable rule.
2. Another language only for documentation for people that the user explicitly asks for, in the language they name or write in. Product UI text follows the project's `UI text language`.
3. An edit inside an existing file written in another language keeps that file's language; files are not translated unasked.
4. Commits, PR descriptions, code comments, test names and BDD scenarios, logs and internal error texts are covered. The template's `Test names: <language>` option is removed.
5. The bootstrap rule is short (fits the 800-word limit); space comes from rewording that drops no rule. writing-documentation carries the repo-docs case.
6. The chat itself stays in the user's language. **assumed**

## Design

One bullet in using-skills "Always true" (identical in both editions):

> - **Files you write are in English**, whatever language we talk in: docs, plans, commits, PRs, comments, test names, logs. Exceptions: UI text, docs for people the user requests in their language, and edits to a file in another language.

Room for it in using-skills (counted on the current files: Claude 798 → 798 words, pi 800 → 800):
- "Naming a skill without loading/reading it doesn't count: you would be working from memory of an older version." loses the clause after the colon;
- the red flag row "Let me look around first" goes (The rule already says "including before … exploring code");
- "Extra care doesn't replace the heavier path." goes (the sentence before it says "never Bounded");
- Claude: "**Tasks:** a todo for multi-step work; task files hold Plan and Progress." keeps only "a todo for multi-step work." (the "Continuing work" row names Plan and Progress);
- pi: the precedence sentence takes the Claude wording "Process skills come first and set the approach; platform and domain skills supply the specifics."

Elsewhere: writing-documentation drops "the docs language" from what to follow and says English holds even where older docs use another language; `docs` follows structure only; the template keeps `UI text language` only; the review checklist checks the language of agent-written text.

## Rollout

Release 0.31.0 in both editions. Existing projects pick it up on plugin update; a project's CLAUDE.md still outranks skills.

## Risks and open questions

- Trimming the bootstrap could lower skill loading → criterion 7 measures it; any drop sends the trims back for rework.
- The commit grader misses a message passed with `git commit -F <file>` → noted in EVALS.md; the file-based graders carry criterion 1.

## Follow-ups

None.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the language rule in both editions, proven by a new eval that is red before the skill change and green after.
**Architecture:** one bullet in the always-loaded using-skills plus aligned lines in writing-documentation, `docs`, the manifest template and the review checklist; an eval case with regex and tool_used graders.
**Stack / constraints:** Node ≥ 22.18, `node --test`; skill body ≤ 800 words (`tests/lint-skills.test.ts`); both editions' shared skill text stays identical except edition-specific lines; Cyrillic class `[А-Яа-яЁё]` with no flags.
**Verification:** `npm test && npm run typecheck` in each repo; `npm run eval -- --case docs-language` (spends plan usage: run only with the user's go).

### Review focus
1. A grader that passes on a missing file: `adr-english` is `not_contains`, so `adr-written` must fail when the file is absent.
2. Russian text quoted inside the ADR (a product name, the user's words) would fail `adr-english`; the prompt gives no Russian proper names.
3. The commit message going through a heredoc or `-F`: `commit-english` reads the whole Bash input.
4. Words dropped from using-skills taking a rule with them: diff review against the Design list.
5. The two editions drifting: `tools/compare-editions.mts` in the workspace.

### Post-implementation
- `docs/ARCHITECTURE.md` and `.ru.md` (both repos), principle 6: skills and agent-written files are in English; user docs in English with a Russian version.
- `docs/EVALS.md` (Claude): the `docs-language` row and its first results.
- `CHANGELOG.md` (both): 0.31.0 entry with the eval's before/after.
- workspace `docs/FRAMEWORK-SOURCES.ru.md`: §11.43, where the rule comes from and why.
- What outlives this task file: the rule lives in the skills; the reasoning in ARCHITECTURE principle 6 and FRAMEWORK-SOURCES §11.43.

### Files

| File | Responsibility |
|---|---|
| `evals/docs-language/{case.yaml,prompt.md,scaffold.sh}` | the case: Russian prompt, scaffolded repo |
| `evals/docs-language/fixture/{package.json,README.md,dot-gitignore,docs/decisions/0001-database.md}` | a repo with Russian docs |
| `evals/docs-language/graders/*.md` | criteria 1–4, `skill-loaded` |
| `tests/eval-graders.test.ts` | the regex graders on sample text |
| `skills/using-skills/SKILL.md` (both) | the rule |
| `skills/writing-documentation/SKILL.md` (both) | repo docs in another language |
| `skills/docs/SKILL.md`, pi `prompts/docs.md` | structure only |
| `templates/CLAUDE.md`, pi `templates/AGENTS.md` | UI text language only |
| `skills/requesting-code-review/references/checklist.md` (both) | review check |

### Task 1: eval case `docs-language` (Claude edition)

**Files:** Create `evals/docs-language/…` · Modify `tests/eval-graders.test.ts`

- [ ] Write tests `adr-english: Cyrillic fails, English passes` (pattern of `docs-language/graders/adr-english.md` matches "Выбрали RabbitMQ", not "We chose RabbitMQ") and `client-doc-russian: needs Russian words` (matches "Ничего не теряется", not "Nothing is lost"); add stub graders with `pattern: 'x'`
- [ ] Run `npm test -- tests/eval-graders.test.ts` → expect FAIL: assertion on the "Выбрали RabbitMQ" match
- [ ] Write the case: `case.yaml` and `scaffold.sh` as in `secrets-stay-out`; `prompt.md` (max_turns 40, timeout 900, same `allowed_tools`) in Russian: record the RabbitMQ-over-Redis-Streams decision (delivery acks and dead-letter needed; Redis is a cache without persistence) in `docs/decisions/0002-message-queue.md` and commit it; write a short Russian note for the client in `docs/client/queue.md` on what changes for them; end with the Russian form of "I'm away, so don't ask me questions…"
- [ ] Fixture: Russian `README.md`; `docs/decisions/0001-database.md` in Russian containing `Выбрали PostgreSQL`; `package.json` with no scripts; `dot-gitignore` with `node_modules/`
- [ ] Graders: `adr-written` regex file `docs/decisions/0002-message-queue.md` `'RabbitMQ'`; `adr-english` same file `'[А-Яа-яЁё]'` not_contains; `client-doc-russian` regex file `docs/client/queue.md` `'[А-Яа-яЁё]{4,}'`; `old-adr-kept` regex file `docs/decisions/0001-database.md` `'Выбрали PostgreSQL'`; `commit-made` tool_used Bash `'git commit'` min 1; `commit-english` tool_used Bash `'git commit[\s\S]*[А-Яа-яЁё]|[А-Яа-яЁё][\s\S]*git commit'` max 0; `skill-loaded` as in other cases
- [ ] Run `npm test` → expect PASS
- [ ] With the user's go: `npm run eval -- --case docs-language` on the current skills → expect the kit arm to fail `adr-english` or `commit-english` in at least one run (red baseline); record the scores in Progress
- [ ] Commit `test(evals): docs-language case`

### Task 2: the rule in using-skills (both editions)

**Files:** Modify `skills/using-skills/SKILL.md` in `src_claude/` and `src/`

- [ ] Apply the Design's bullet and its four trims per edition, word for word
- [ ] Run `npm test` in each repo → expect PASS, lint-skills body ≤ 800 (798 Claude, 800 pi); `tests/hooks.test.ts` SessionStart still injects the body
- [ ] Commit `feat(using-skills): files the agent writes are in English` in each repo

### Task 3: aligned lines (both editions)

**Files:** Modify writing-documentation, `docs` skill / `prompts/docs.md`, template CLAUDE.md / AGENTS.md, review checklist

- [ ] writing-documentation "Follow the project first": drop "the docs language, "; "Extend that structure;" becomes "Extend that structure, in English even where older docs use another language;"; drop the red flag row "The comment explains the code" (the Code comments section says it)
- [ ] `docs` skill and `prompts/docs.md`: "structure and language where there is one" → "structure where there is one"
- [ ] templates line 39 → `- UI text language: <ru | en | …>.`
- [ ] checklist Hygiene, after the user-facing text line: `- Files the agent wrote (docs, plans, commits, PR text, comments, test names, logs) are in English, except docs for people the user asked for in another language (using-skills).`
- [ ] Run criterion 6's grep → expect no output; `npm test && npm run typecheck` in each repo → expect PASS
- [ ] Commit `feat(docs): agent-written docs in English` in each repo

### Task 4: evidence

- [ ] With the user's go: `npm run eval -- --case docs-language` → expect the kit arm to pass criteria 1–4 in every run
- [ ] With the user's go: `npm run eval -- --runs 1` → expect the kit arm's `skill-loaded` count no lower than the last run in `docs/EVALS.md` (criterion 7)
- [ ] Record both in Progress

### Task 5: docs and release 0.31.0

- [ ] Post-implementation items in both repos; the 0.31.0 entry names the eval's before/after
- [ ] Bump `0.30.0` → `0.31.0` where the release commit for 0.30.0 changed it (`git show --stat 65a1c84` Claude, its pi counterpart), lockfiles via `npm install --package-lock-only`
- [ ] `npm test && npm run typecheck` in each repo → expect PASS
- [ ] Commit `feat(docs-language): release 0.31.0` in each repo

## Progress

None yet
