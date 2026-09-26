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

## Architecture decision record

File: `docs/decisions/NNNN-short-title.md`, numbered in order, never renumbered.

```markdown
# NNNN. <Decision in a few words>

- Status: proposed | accepted | superseded by NNNN (relative link to it)
- Date: YYYY-MM-DD

## Context
<The forces at play: requirements, constraints, what makes this a real choice.>

## Options
1. <Option A>: <pros, cons, cost>
2. <Option B>: <pros, cons, cost>

## Decision
<What we chose, in one or two sentences.>

## Consequences
<What becomes easier, what becomes harder, what we must now do, and what would make us revisit this.>
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
