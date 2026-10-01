# Root-cause tracing

Bugs usually surface deep in the call stack, far from where the bad value was created. Fixing the place where the error appears treats a symptom.

## Technique

1. **Observe the symptom precisely.** Note the value, the location and the exact message.
2. **Find the immediate cause.** Which line produced it, and with which inputs?
3. **Ask "who called this with that value?"** and move up one frame.
4. **Repeat** until you reach the point where the value first became wrong: the original trigger.
5. **Fix at the trigger.** Then consider defense in depth: validation at the entry boundary, and a clear error where the value is used.

## When you can't trace statically, instrument

Log just before the dangerous operation, not after it fails:

```ts
console.error("DEBUG before git init", { cwd, env: process.env.NODE_ENV, stack: new Error().stack });
```

- Use `console.error` / stderr in tests. Loggers are often silenced there.
- Include the value, the context (cwd, ids, env) and the stack.
- Run once, read the output, and remove the instrumentation before committing.

## Test pollution

If a failure only appears when the whole suite runs, bisect the test files: run the first half and the second half until one test is left that leaves state behind (files, env vars, globals, database rows, fake timers, singletons).

## Timing bugs

Replace arbitrary `sleep`/`setTimeout` with waiting for the condition itself, under the project-wide ceiling and with a clear error message (`../../test-driven-development/references/test-standard.md`, "Determinism and isolation"). A fixed delay is either too slow or, on a busy CI machine, too short.
