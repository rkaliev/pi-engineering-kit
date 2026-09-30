---
description: Create or refresh the project's documentation (map, topic chapter, changelog or decision record)
argument-hint: "[topic | changelog | decision <topic>]"
---
Documentation request: $@

Use the writing-documentation skill. Follow the project's existing documentation structure and language where there is one.

- **No argument: inventory and map.** Read the README, `docs/`, decision records, CHANGELOG, the agent manifest, any task file still on the branch, and the code's modules. Propose a documentation map: what the README needs, one topic chapter per feature, module or domain (`docs/NN-topic.md`, listed in `docs/README.md`), and whether a CHANGELOG is missing. Show the map and wait for my yes. Then write the approved documents from the code and the decision records.
- **A topic or module name:** create or refresh that one chapter from the code (template in the skill's references), and add it to the index.
- **`changelog`:** add entries from `git log` since the last tag. Group Conventional Commits into Added / Changed / Fixed / Removed, written for users. Don't touch released sections.
- **`decision <topic>`:** write the decision record for that topic, or update the existing one in place, from the template, with the options that were really considered. Delete a record that no longer applies and repoint the links to it. Ask what you can't find in the code.

Describe what exists today, not plans. Run every command you document, check every link, then report which documents you created or changed and what you verified.
