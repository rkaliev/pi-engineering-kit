# Design system, design context and UI copy

These rules hold for any UI stack (CSS, Compose, SwiftUI, XAML). Follow the project's design system; these rules keep it coherent.

## Tokens are the vocabulary

- Colours, spacing, radii, type sizes, shadows, curves and durations are named tokens. Components use tokens, not raw values.
- **Semantic tokens, not the palette:** `danger`, `surface`, `text-muted`, never "red-500" or a hex value in a component. Dark mode and brands re-point the semantic tokens; components don't carry per-theme overrides.
- **The third occurrence of the same raw value becomes a token.** One-off raw values are allowed only where no scale exists (an external asset's size, a platform constant), with a short reason.

## Components own their look

- A shared component has a closed set of variants (size, tone, emphasis). New looks become new variants in the component, reviewed there.
- **A call site may place a component, not redefine it:** it sets layout (width, margin, position in a grid), not colour, typography or radius.
- Reuse the existing component before writing a new one; a second button implementation is a finding.
- Controls in one row share one size. Touch targets grow through padding, not through scaling the visual.

## Design context for agents

- If the project keeps a **`design.md`** (or design-system docs) per app, read it before UI work: tokens, components, motion, and what not to do. Its path belongs in the agent manifest's Docs section.
- It is short and hand-written: intent and rules a person can check, plus a mirror of the key tokens with a pointer to the files that define them at runtime. Generated token dumps are noise; mechanical rules belong in a linter.
- A visual change updates it in the same change.

## Type

- Operational UIs (POS, back office, dashboards used all day) use the platform's system fonts: no download, no layout shift, no swap during a shift.
- A downloaded typeface needs a reason (brand surface, legibility need), a self-hosted file, and a non-blocking load.
- Sizes follow the user's text-size setting (rem on the web, Dynamic Type, sp).

## Honest copy for destructive actions

- Name what the action leaves the user able to do, not the mechanism.
- Say **Archive** only when the same UI offers that user a way to restore it; otherwise say **Delete**. An inline "Undo" toast is not a restore feature.
- Don't claim what didn't happen: "Deleted. Past orders stay on record" is honest; "Permanently erased" is not, if records remain.
- Four moments to cover: the confirmation (what survives, how to recover), success, failure (name the rule that refused: "Can't delete: the shift is still open"), and actions that cannot be undone (say so before, not after).
