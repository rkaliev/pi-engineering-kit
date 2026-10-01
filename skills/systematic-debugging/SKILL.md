---
name: systematic-debugging
description: Use when encountering any bug, test failure, build or CI failure, crash, performance problem or unexpected behavior, before proposing a fix
---

# Systematic debugging

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

A fix for a symptom is a failure. The pressure to guess is highest under time pressure, so that is exactly when to follow the process.

## Phase 1: Root cause

1. **Read the whole error**: the stack trace, codes, file and line numbers, and warnings above the error.
2. **Reproduce it reliably.** Write down the exact steps. If you can't reproduce it, gather more data; don't guess.
3. **Check what changed**: `git log`/`git diff`, dependency bumps, config, environment, data, OS or device version.
4. **Read the telemetry first** when it happens outside your machine: a bounded, read-only query of logs and traces by request or trace id (observability).
5. **Instrument the boundaries.** In multi-component systems (UI → API → service → DB; CI → build → signing; POS → fiscal device), log what enters and leaves each boundary once. That shows where it breaks.
6. **Trace backwards** from the bad value to where it first appears (`references/root-cause-tracing.md`). Fix at the source.

## Phase 2: Pattern

Find similar code that works in this repo. Read the reference implementation completely. List every difference, however small, and every dependency or assumption involved.

## Phase 3: Hypothesis

State one hypothesis: "X is the cause because Y." Test it with the smallest change, changing one variable at a time. If it's wrong, form a new hypothesis; don't stack fixes. If you don't understand something, say so and research or ask.

## Phase 4: Fix

1. Write a failing test that reproduces the bug (test-driven-development).
2. Make one fix at the root cause. No "while I'm here" changes.
3. Verify: the new test passes, the full suite passes, and the original symptom is gone (verification-before-completion).
4. **If three fixes have failed, stop.** When each fix reveals a new problem somewhere else, the architecture is wrong, not the hypothesis. Present what you learned and discuss with the user before a fourth attempt.

If the cause really is external (network, vendor, timing), document what you investigated, add appropriate handling in the product code (a timeout, a retry with idempotency, a clear error) with a test for it, and add logging for next time. Tests themselves never retry (test-standard, "Retries"). Most "no root cause" conclusions are incomplete investigations.

## Signals you're off track

The user asks "is that actually happening?", "stop guessing", or "we're stuck?". You catch yourself thinking "quick fix now, investigate later", "let's try changing X", or listing fixes before tracing data. **Go back to Phase 1.**

| Excuse | Reality |
|---|---|
| "It's obviously X" | Seeing a symptom isn't understanding the cause. Prove it. |
| "Several fixes at once saves time" | Then you can't tell which one worked, and they cause new bugs. |
| "One more attempt" (after 2+) | That's an architecture question. Stop. |
| "Flaky, just rerun it" | Flaky means there's a race or shared state. Find it, and fix it by test-standard's "Flaky tests" criteria. |
