# Motion values

Starting points, not laws. If the project's design system already defines motion tokens, use those and change them only with the owner's agreement. Copy these values exactly; don't approximate them.

## Curves

| Token | Value | Use |
|---|---|---|
| ease-out | `cubic-bezier(0.23, 1, 0.32, 1)` | entering and exiting elements, the default |
| ease-in-out | `cubic-bezier(0.77, 0, 0.175, 1)` | an element moving from one place on screen to another |
| drawer | `cubic-bezier(0.32, 0.72, 0, 1)` | sheets and drawers without a spring |
| ease | the platform's standard `ease` | hover and colour changes |
| linear | `linear` | progress, spinners, hold-to-confirm fills |

The platform's built-in `ease-out` is weak; the stronger curve above reads as faster at the same duration.

## Durations

| Element | Duration |
|---|---|
| press feedback | 100–150 ms |
| tooltip | 100–150 ms; after the first tooltip opens, neighbours open instantly |
| dropdown, popover, select | ~150 ms |
| dialog, sheet, drawer | 200–250 ms (exit: the same or shorter) |
| route or step transition | ≤ 250 ms |
| marketing and onboarding | may exceed 300 ms, with the reason stated next to the value |

Stagger: 30–80 ms per item, the whole group inside ~300 ms, delays only for the first ~6 items.

## Shapes

- Enter from `scale(0.95–0.97)` and `opacity: 0`, never `scale(0)`.
- Press: `scale(0.97)` (range 0.95–0.98), ~120 ms ease-out, released on pointer-up.
- Anchored surfaces (menus, popovers, tooltips) scale from the trigger's side; centred modals scale from the centre.
- Small travel: 4–16 px for an entrance, not a full-screen slide.
- Blur (for materials or masking a crossfade): ≤ 20 px; it is expensive on low-end devices.

## Springs

Describe a spring by damping ratio (1.0 = no bounce) and response (seconds to settle, roughly):

| Use | Damping | Response |
|---|---|---|
| default UI, repositioning | 1.0 | 0.4 s |
| after a momentum gesture (fling) | ~0.8 | 0.3–0.4 s |
| sheet or drawer | 0.8 | 0.3 s |
| playful, rare surfaces | 0.7–0.9 (bounce 0.1–0.3) | 0.4–0.5 s |

Libraries that take `bounce` and `duration` map roughly as bounce 0 ≈ damping 1.0, bounce 0.2 ≈ damping 0.8.

## Gesture math

- **Velocity:** from the last ~100 ms of pointer samples, in px/ms. Use it to choose the target and as the spring's initial velocity.
- **Flick:** release velocity above ~0.11 px/ms (`|distance| / elapsedMs`) counts as a flick toward that direction, even when the distance is short.
- **Momentum projection** (where a fling would come to rest), with `d` the deceleration rate per ms (0.998 normal, 0.99 fast):

  ```
  projected = position + (velocity_px_per_s / 1000) * d / (1 - d)
  ```

  Snap to the nearest valid target (open, closed, the next page) from the projected position, not from the release position.
- **Relative velocity for a spring** that animates a 0→1 progress value: `gestureVelocity / (target - current)`.
- **Rubber-band** past a limit, with `o` the overshoot, `D` the dimension (width or height) and `c = 0.55`:

  ```
  offset = (o * D * c) / (D + c * |o|)
  ```

- **Hysteresis:** ~10 px of movement before a drag starts, so taps and scrolls stay unambiguous.

## Audit checklist

| Category | Look for |
|---|---|
| Purpose and frequency | motion on keyboard or frequent actions; decorative motion on data |
| Easing and duration | ease-in; linear on UI; > 300 ms; exits slower than entrances |
| Origin | scale from 0; popovers not from their trigger |
| Interruptibility | keyframe animations on state that toggles; input locked during transitions |
| Performance | layout properties; "all"; per-frame geometry reads; large blurs |
| Accessibility | no reduced-motion handling, or reduced motion that removes feedback; hover motion on touch |
| Consistency | inline curves and durations instead of tokens; three near-identical curves |
| Missed opportunities | state that teleports (a panel that appears with no origin); no press feedback on primary actions |
