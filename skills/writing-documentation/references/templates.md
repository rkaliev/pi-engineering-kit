# Documentation templates

Use these only where the project has no existing format. Delete sections that don't apply.

## README

```markdown
# <Project name>

<One or two sentences: what it is, who it is for, what problem it solves.>

## Quick start

<The shortest path from clone to a running result. Every command was run.>

## Commands

| Command | What it does |
|---|---|
| `<install>` | install dependencies from the lockfile |
| `<test>` | run the tests |
| `<build>` | build for release |

## Structure

<Top-level folders and what lives in each; point at entry points.>

## Configuration

<Environment variables and config files: name, meaning, where the default is set. Never real secret values.>

## Documentation

- How X works: `docs/01-x.md` (as a relative link)
- Decisions: `docs/decisions/`

## Contributing and license

<How to propose changes; license name and link.>
```

## Topic chapter

File: `docs/NN-topic.md`, numbered in reading order and listed in `docs/README.md`. One feature, module or domain per chapter; it describes what exists today.

```markdown
# <Topic>

<One paragraph: what this part of the system does, for whom, and where its boundaries are.>

## How it works

<The main flows, as a table when there are several: intent | what happens | result. Name the entry points in code.>

## Rules and invariants

<What must always be true: states and transitions, limits, money and rounding, permissions, idempotency.>

## Configuration

<Settings, flags and environment variables that change its behavior, with where each is defined.>

## Operations

<How to see that it works (logs, metrics), known failure modes and what to do about them.>

## See also

- Code: `<path>` (relative links)
- Decisions: `docs/decisions/NNNN-…`
```

## Decision record

File: `docs/decisions/NNNN-slug.md`, one topic per file. The number is its stable ID for citations ("see decision 0007"); numbers are never reused. The file holds only the decision in force: when it changes, rewrite the record in place; when it no longer applies, delete it and repoint the links. Git keeps every earlier version, so the record has no status, date or changelog.

```markdown
# NNNN. <Topic: the decision in a few words>

## Decision
<What holds now, as rules a reader can follow and a reviewer can check.>

## Why
<The forces: requirements, constraints, what made this a real choice.>

## Consequences
<What becomes easier or harder, what we must now do, and what would make us revisit this.>

## Considered and rejected
- <Option>: <why not, in one line>. Kept so the question is not reopened without new facts.
```

## Changelog entry

Keep the newest version on top. Group by what users notice.

```markdown
## [1.4.0] - YYYY-MM-DD

### Added
- <New capability, from the user's point of view.>

### Changed
- <Changed behavior. Say what to do if it breaks something.>

### Fixed
- <The symptom that no longer happens.>

### Removed
- <What is gone, and the replacement.>
```
