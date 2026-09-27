---
name: test-driven-development
description: Use when implementing any feature, bugfix, refactor or behavior change, before writing the implementation code
---

# Test-driven development

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

If you didn't watch the test fail, you don't know that it tests the right thing. Following the letter of this rule is the spirit of it.

Exceptions only with the user's explicit agreement: throwaway spikes, generated code, pure configuration. **Legacy code without tests is not an exception.** Use changing-legacy-code and pin current behavior first.

## The cycle

1. **RED.** Write one minimal test for one behavior. Give it a clear name, use real code, and mock only true boundaries (network, clock, hardware, payment provider). Take the expected values from the spec or criterion, never from running the code. Before you write it, name the production change that would make it fail.
2. **Verify RED. Mandatory.** Run it. It must *fail* (not error) with the expected message, *because the feature is missing*.
   - Passes immediately? You're testing existing behavior. Fix the test.
   - Errors? Fix the error and re-run until it fails for the right reason. A missing module or an undefined symbol is an error, not RED: add a stub that returns a wrong value, then re-run.
3. **GREEN.** Write the simplest code that passes. No extra options, no speculative generality, no drive-by refactors.
4. **Verify GREEN. Mandatory.** Run the test, then **the project's full test command**. The output must be clean: no new warnings or errors. If another test fails, fix it now or report it by name. A red test you saw scroll past and didn't mention falsifies your report.
5. **REFACTOR**, only while green: remove duplication, improve names. Re-run. Add no behavior.

Code written before its test is deleted and rewritten from the test. Don't keep it as a "reference": you'll adapt it, which is testing after.

## Tests stay honest

- **Never weaken a test to get green.** That includes editing an assertion to match output, deleting a test, adding `.skip`/`.only`/`xit`, loosening a tolerance, or catching the error in the test. If a test really is wrong, explain why and make that change as a separate step the user agrees to.
- Assert on behavior the user can observe, not on mock calls or private internals.
- Keep test-only helpers in test code, never in production classes.
- **Bug fix:** first a test that reproduces the bug (RED), then the fix. The test stays as a regression guard.
- **Regression proof:** a test is trustworthy once you've seen it fail with the fix reverted and pass with it restored.

## Choosing the level

**Before the first test of a task, read `references/test-standard.md`**: expected values, which tests are worth writing, names (subject + circumstance + result), doubles, determinism, flakes, acceptance tests and coverage.

Prefer the fastest test that exercises the real behavior: unit tests for pure logic, integration tests for adapters (DB, HTTP, payment gateway sandbox, device API), and a thin end-to-end or UI test for critical user flows only. Follow the project's existing test stack and layout.

## Red flags: stop and start over

| Thought | Reality |
|---|---|
| "Too simple to test" | Simple code breaks. The test takes a minute. |
| "I'll add tests after" | Tests written after pass immediately, which proves nothing. |
| "I tested it manually" | Manual testing can't be re-run and covers no edge cases. |
| "Deleting this work is wasteful" | That's sunk cost. Keeping untrusted code is the real waste. |
| "Hard to test" | Then it's hard to use. Simplify the interface or inject the dependency. |
| "Just this once" | That's how every skipped test starts. |
