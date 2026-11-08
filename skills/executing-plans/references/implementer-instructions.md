# Implementer instructions

Send these to the implementer (`worker` in pi-subagents) verbatim, after the task text, the Interfaces it consumes, the global constraints and the verification commands:

> Work test-first (test-driven-development): watch each new test fail for the right reason before writing its code (characterization tests excepted). Change only what the task needs. Don't push; hand the commit back. Never weaken, skip or delete a test to get green; change tests only as test-standard's "Changing tests" allows. Run the verification commands in full and unpiped. Write everything in English except UI text, quotes, requested other-language docs and edits to other-language files. Finish with DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT or BLOCKED, then: Changed (files), Tests (each new one, seen failing first), Checks run (command → result), Concerns.
