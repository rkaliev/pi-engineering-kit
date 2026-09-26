---
name: changing-legacy-code
description: Use when modifying existing code that has few or no tests, unclear behavior, old dependencies or tangled structure, or code written before agentic development
---

# Changing legacy code

Legacy code is code without a safety net. Its current behavior, including its quirks, is what users depend on. Change it the way a careful senior engineer would: pin the behavior first, change as little as possible, and leave it a bit easier to test.

## Rules

- **Follow the house style**, even if you would do it differently: its patterns, naming, framework version and error handling. Don't introduce a new paradigm in one corner.
- **Keep the diff minimal.**
  - No reformatting, reordering or renaming outside the change.
  - Don't upgrade dependencies unless the task needs it.
  - Delete only what your own change orphaned.
  - Report other dead code; don't delete it.
- **Treat surprises as possible requirements.** An odd branch may be a customer contract, a legal rule or a device workaround. Check `git log -L`/`git blame`, linked issues and tests, and ask before "fixing" behavior nobody asked about.
- **Leave generated, vendored and migration history alone.** Add new migrations; never edit applied ones.

## Process

1. **Understand the change point:** callers, data flow, side effects (DB, files, network, devices), and configuration and feature flags.
2. **Pin current behavior with characterization tests.** Call the code with realistic inputs and assert whatever it does *today*, even if it looks wrong, so that any change shows up. Cover the paths you will touch plus their edges.
3. **Find or create a seam** where a test can control dependencies:
   - pass the dependency as a parameter or constructor argument;
   - wrap a static or global in a small interface;
   - extract the pure logic from the I/O.
   Keep these refactors tiny, behavior-preserving, and committed separately from the behavior change.
4. **Make the change with TDD** (test-driven-development): a new failing test for the new behavior, then minimal code.
   - **Sprout:** put new logic in a new, tested function or class and call it from the old code.
   - **Wrap:** add behavior before or after an existing call without editing its insides.
5. **Verify** with the characterization tests, the full suite, and a manual run of the affected flow if coverage is thin. Say explicitly what could not be covered.

## Larger rewrites: strangler fig

Don't rewrite in place. Put a facade or route in front of the old component and move one capability at a time behind it (a feature flag or traffic split). Compare old and new outputs in shadow mode when you can, and remove the old path only after the new one has proven itself. **Get the user's approval for the plan.** This is architectural work (brainstorming).

## Red flags

| Thought | Reality |
|---|---|
| "This is ugly, let me clean it up while I'm here" | That's out of scope. Mention it; don't do it. |
| "No tests exist, so TDD doesn't apply" | Pin the behavior first. That is TDD for legacy code. |
| "This branch looks like a bug" | It may be a requirement. Ask. |
| "Upgrading the framework will make this easier" | That's a separate, planned task. |
