# Reviewing and auditing motion

Apply the gate and rules from the skill body first; this file is the output format and the procedure.

## Reviewing motion

Findings go in a table, one row per change:

| Before | After | Why |
|---|---|---|
| `transition: all 400ms ease-in` on the menu | no animation; press feedback 0.97 / 120 ms ease-out | opened 200× a shift from the keyboard |

Prefer fixes in this order: delete, reduce, fix easing, fix origin, make interruptible, move to cheap properties, make exits faster. End with a verdict: block or approve.

## Auditing an app's motion

1. **Recon:** the motion libraries, where motion lives (tokens, theme, keyframes), the existing conventions, and a frequency map of animated elements.
2. **Audit** by category (purpose and frequency, easing and duration, origin, interruptibility, performance, accessibility, consistency, missed opportunities), in parallel read-only agents on a large codebase (dispatching-parallel-agents).
3. **Confirm every finding at its file and line.** Then show one table: severity (high: feel-breaking, such as ease-in, motion on frequent or keyboard actions, dropped frames, scale from 0; medium: wrong origin, not interruptible, no reduced motion; low: polish), location, finding, fix.
4. Wait for the user to choose. The chosen fixes become a plan (writing-plans) with exact values inlined, since the implementer has none of this context.
