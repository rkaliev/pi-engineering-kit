---
description: Verify, review and integrate the current branch
---
Use the verification-before-completion skill on the current branch. If any check fails, stop and report it.

If the branch still carries working documents (`docs/specs/`, `docs/plans/`; a roadmap with open pieces may stay), finish them as in the executing-plans skill (Finish, step 4): move what lasts into docs/, then delete them in one commit.

Then follow the finishing section of the git-workflow skill: show the options (merge locally / push and open a PR / keep / discard) and wait for my choice. Never push or merge without it. After a push, offer to follow CI as described in git-workflow ("After a push").
