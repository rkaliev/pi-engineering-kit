---
name: ui-motion
description: Use when adding, changing, reviewing or auditing animation, transitions or motion in any UI (web, Android, iOS, desktop) - enter/exit effects, hover and press feedback, drag, swipe, sheets, springs, loading states, reduced motion, or "make it feel smoother/more alive"
---

# UI motion

Motion is a tool for understanding, not decoration. Decide *whether* before deciding *how*.

Exact curves, durations, spring settings and formulas: `references/values.md`. How to express them per platform (CSS, Compose, SwiftUI/UIKit, WinUI, Qt): `references/platforms.md`.

## 1. The gate: should this move at all?

**Frequency.** Estimate how often a user sees it:

| Seen | Motion |
|---|---|
| 100+ times a day, or triggered from the keyboard | none, except press feedback |
| tens of times a day | none, or barely noticeable |
| occasionally (modals, drawers, toasts) | the standard budgets below |
| rarely, first run, onboarding | room for delight |

**Purpose.** Name one: feedback, spatial consistency (where it came from, where it went), state indication, softening a jarring change, or explanation (onboarding, marketing). **Without a purpose, delete the animation.**

Data the user reads or acts on doesn't move for style: an operational list (orders, tickets, a cashier queue) never slides, shimmers or fades on refresh. Marking a genuinely new row by colour is state indication; re-animating rows on every refresh is not.

Answer "smooth animations everywhere" with this gate, per element, saying which get no motion and why.

## 2. Rules for motion that passes the gate

- **Easing by movement:** entering or exiting → ease-out; moving on screen → ease-in-out; hover and colour → ease; constant motion (progress, spinners) → linear. **ease-in on UI is a defect**, exits included: it delays the response the user is waiting for. A faster exit is shorter, not ease-in.
- **Budgets:** UI motion stays under 300 ms. Press feedback and tooltips ~100–150 ms, dropdowns and popovers ~150 ms, dialogs and sheets ~200–250 ms.
- **Exits are never slower than entrances.** A hold-to-confirm fills slowly and releases fast.
- **Physical origin:** never scale from 0; start at 0.95 or more with opacity 0. Popovers grow from their trigger; centred modals are exempt. Press feedback scales to about 0.97.
- **Interruptible:** a retriggered animation continues from its current value, it doesn't restart. Toggles and state changes use transitions; anything the finger drives uses springs.
- **Cheap properties only:** transform and opacity (the compositor or render thread). Never animate layout (width, height, top, margins), and never transition "all". Measure geometry once per layout or gesture start, never on every frame or pointer move.
- **Reduced motion means gentler, not zero:** keep opacity and colour feedback, drop travel, scale, parallax and loops. Direct manipulation still follows the finger; only the automatic travel after release gets shorter. Read the platform setting once, in one place.
- **Stagger** by 30–80 ms per item, capped to the first few items, never blocking input.
- **Perceived speed:** after an optimistic update nothing spins. Loading shows a skeleton in the content's own shape, not a spinner in an empty box.
- **Tokens:** curves and durations are named tokens in the design system, never inline one-offs.

## 3. Gestures (drag, swipe, sheets, carousels)

- Respond on pointer-down: highlight on down, commit on up.
- Track the finger 1:1: capture the pointer, keep the grab offset, keep a short history of positions for velocity.
- On release, hand the gesture's velocity to a spring and project momentum to choose the target (dismiss, snap back, next page). A fixed-duration transition after a fling ignores the fling.
- Past a limit, rubber-band instead of a hard stop.
- About 10 px of movement before a drag starts (hysteresis), so taps stay taps.
- **Never lock input during a transition**: the user can grab and reverse at any moment.

## 4. Verify

Report which of these you did:
1. Mechanical: the values match the tokens and budgets; no ease-in, no scale from 0, no layout properties.
2. Feel: play it at 10 % speed (devtools or the OS animation scale), then at full speed repeatedly, interrupting it midway.
3. Reduced motion on: movement is gone, opacity feedback remains.
4. Touch and gestures on a real device, not only a simulator or a desktop browser.

## 5. Reviewing and auditing

For a motion review or an app-wide audit, follow `references/review-and-audit.md`.

## Red flags

| Thought | Reality |
|---|---|
| "The designer approved 300–400 ms everywhere" | Frequency decides per element. Show the gate to the designer. |
| "A little fade can't hurt" | On a list refreshed all day it hurts every time. |
| "I'll add reduced motion later" | It is part of the animation, not a follow-up. |
| "A short ease-in exit feels snappy" | Shorter makes it snappy. ease-in makes it wait. |
| "`:active` gives press feedback" | Not reliably on touch everywhere: set a pressed state on pointer-down and check on a device. |
