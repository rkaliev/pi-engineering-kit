# Review gate

Before opening or merging a PR/MR, merging into the base branch or pushing to it, the guard asks the user unless the reviewer's last verdict is `Yes` for the commit being landed. The guard records the verdict from a `subagent` result that carries the reviewer's `Reviewed HEAD:` and `Ready to merge:` lines; you never write it yourself. Run the reviewer in the foreground, so its report comes back as that result.

- A review covers the branch's own change to reviewable files, not one SHA. Deleting task files, changing `docs/` or other markdown, and rebasing onto a newer base keep it valid. Any other change needs a new review, including markdown that steers the agent: AGENTS.md, SKILL.md and anything under `.pi/`, `rules/`, `skills/`, `agents/` or `prompts/`. The list is fixed; the project can't widen it.
- Land in a command of its own: a landing chained after `git commit`, `switch` or another HEAD move is refused, because the guard can't see the commit it would land. `gh pr merge <number>` asks, because the PR's head isn't known locally; name the branch, or merge from it.
- Only runs of the `reviewer` agent count; a failed reviewer run counts as `Inconclusive`.
- `With fixes`, `No` and `Inconclusive` don't pass: fix, then re-review the new range.
- A branch that changes only exempt files needs no review. Only the user can waive the gate: by confirming, or with `"reviewGate": false` in `.pi/guard.json` (trusted projects only; the guard asks before that file is edited). A self-review in a separate pass does not satisfy the gate, so without a `subagent` tool the user decides at the prompt.
