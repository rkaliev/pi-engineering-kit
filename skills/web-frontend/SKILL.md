---
name: web-frontend
description: Use when building, changing or reviewing web UI - components, pages, forms, client-side state, routing, browser behavior, keyboard shortcuts or frontend performance
---

# Web frontend

A web UI is used by people and increasingly by browser agents, on browsers and devices you don't control. It must be operable, predictable under slow or overlapping requests, and verified in the browsers the product actually targets.

## Always

- **Follow the project's architecture.** Keep its layering (for example FSD), its state manager and data-fetching layer, and its component library and design tokens. A new screen copies an existing screen's structure. Don't introduce a second state or styling approach.
- **Browser targets come from the project** (`browserslist`, CONTRIBUTING, AGENTS.md), not from memory. Features outside them need a fallback or the user's agreement.

## Semantics and accessibility: the practical minimum

- Use native `button`, `a href`, `input`/`select`/`textarea` and `form`, not clickable `div`s. Links navigate; buttons act.
- Every control has an accessible name: a visible `label`, or `aria-label` when there is no visible text. Icon-only buttons included.
- States and errors are exposed:
  - `disabled`, `aria-expanded`, `aria-pressed`, `aria-invalid`;
  - error text linked with `aria-describedby`;
  - async status announced via `aria-live` where the user would otherwise miss it.
- **Keyboard:** everything works by keyboard, focus is visible, and it moves deliberately (into dialogs, back to the trigger on close, to the first error on submit). No focus traps outside modals.
- Logical headings (one `h1`, no skipped levels for styling) and landmarks (`header`, `nav`, `main`).
- `alt` text for meaningful images; empty `alt` for decorative ones.
- Browser and AI agents act through the accessibility tree, so machine-readable UI is also agent-operable UI. Add ARIA only for a concrete benefit; native semantics come first.

## Standard interaction patterns

- Every data view has **loading, empty, error and success** states. Errors say what happened and how to recover.
- Navigation behaves consistently: Back works, URLs reflect shareable state (filters, tabs), and deep links load.
- **App shortcuts must not break text editing.** Inside `input`, `textarea` and `contenteditable`, leave copy/paste, select-all, undo/redo and caret movement alone. Scope global shortcuts, and check `event.target` and `isComposing` (IME input).
- Familiar controls over custom widgets. A custom widget follows the WAI-ARIA Authoring Practices pattern for its role.

## Async reliability

- **Stale results:** when requests overlap (typing in search, fast tab switching), only the latest may win. Cancel with `AbortController`, or ignore responses that are no longer current.
- **Cancellation and cleanup:** abort requests and unsubscribe on unmount or route change. Clear timers, observers, listeners and object URLs.
- **Double submit:** disable the control or deduplicate while pending. Mutations that can repeat carry an idempotency key (payments-and-money).
- **Event and store ordering:** don't assume effects finish in the order they started. Derive state from the result and its request id, not from arrival order.
- Retry only idempotent requests, with backoff. Show an offline or failed state instead of spinning forever.

## Performance

- Keep interactions responsive. Move long tasks (parsing large documents, heavy computation) to a Web Worker or chunk them.
- Virtualize large lists and tables. Avoid re-rendering whole trees on every keystroke (memoization, stable props, selector granularity).
- Watch memory on large documents: release buffers, canvases, blobs and detached DOM.
- Respect the project's bundle budgets. Lazy-load heavy routes and dependencies. No new large dependency without the user's approval.

## Security and privacy

- Never render untrusted HTML without sanitizing it (DOMPurify or the framework's safe path). Treat `innerHTML`/`dangerouslySetInnerHTML`, `eval`, and URLs from user data (`javascript:`) as sinks.
- No secrets in the bundle; everything in the client is public. Tokens go in httpOnly cookies where the architecture allows it. Justify anything placed in `localStorage`.
- No PII or tokens in URLs, logs, error reports or analytics. Respect consent before loading trackers.
- Validate data from APIs at the boundary. See security-review.

## Verification ladder

Report which rungs you actually ran:
1. Unit tests for logic, and component tests that query by role and label (Testing Library style). This also checks accessible names.
2. Typecheck, lint (including a11y lint rules if the project has them), and a production build.
3. End-to-end tests (Playwright or the project's tool) for critical flows, including keyboard-only paths.
4. Manual check in the target browsers and viewport sizes, with screenshots for UI changes. Name the browsers you used.

## Review points

Add these to code review for UI diffs:
- Clickable non-controls.
- Missing labels or names.
- Hidden error states.
- Broken keyboard access or focus.
- Missing loading, empty or error states.
- Shortcuts that hijack text editing.
- Stale-result races, missing cleanup, double submit.
- Unsanitized HTML.
- PII in analytics.
- Unjustified bundle growth.

**A visible slowdown in responsiveness is a blocker, not a suggestion.**
