---
description: Create or refresh the project's documentation (map, topic chapter, changelog or decision record)
argument-hint: "[topic | changelog | adr <decision>]"
---
Documentation request: $@

Use the writing-documentation skill. Follow the project's existing documentation structure and language where there is one.

- **No argument: inventory and map.** Read the README, `docs/`, decision records, CHANGELOG, the agent manifest, the implemented specs (`Status: implemented`) and the code's modules. Propose a documentation map: what the README needs, one topic chapter per feature, module or domain (`docs/NN-topic.md`, listed in `docs/README.md`), and whether a CHANGELOG is missing. Show the map and wait for my yes. Then write the approved documents from the code and the implemented specs, and link each spec to its chapter.
- **A topic or module name:** create or refresh that one chapter from the code (template in the skill's references), and add it to the index.
- **`changelog`:** add entries from `git log` since the last tag. Group Conventional Commits into Added / Changed / Fixed / Removed, written for users. Don't touch released sections.
- **`adr <decision>`:** write a new decision record from the template, with the options that were really considered. Ask what you can't find in the code or the specs.

Describe what exists today, not plans. Run every command you document, check every link, then report which documents you created or changed and what you verified.
