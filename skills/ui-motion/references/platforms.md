# Motion per platform

The rules are the same everywhere; the tools differ. Prefer the platform's native animation system over a third-party library. Check API details against the platform's current documentation.

## Web

- **CSS first.** Transitions for state changes (they retarget when interrupted); `@starting-style` for enter transitions of newly shown elements; `transition-behavior: allow-discrete` when `display` or overlay state changes. Keyframes only for loops and one-shot sequences nothing can interrupt.
- **Web Animations API** (`element.animate()`) for programmatic motion; a library (Motion and similar) only for springs, gestures and layout animation that CSS cannot express. A plain fade doesn't need a library.
- **Properties:** `transform`, `opacity`; `filter` and `clip-path` with care. Never `transition: all`; never width, height, top, left or margins.
- **Don't force layout:** no `getComputedStyle()` or `offsetWidth` reads to restart animations; measure with `ResizeObserver` / `IntersectionObserver` and cache.
- **Press feedback:** set a pressed state on `pointerdown` (and clear it on `pointerup`/`pointercancel`); `:active` alone has historically been unreliable on touch in iOS Safari, so check it on a device.
- **Hover motion** only under `@media (hover: hover) and (pointer: fine)`, so touch devices don't get stuck hover states.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)`, or one shared `matchMedia` helper in JS. Also respect `prefers-contrast`, and `prefers-reduced-transparency` where supported (still experimental), for materials.
- **Gestures:** Pointer Events with `setPointerCapture`, `touch-action` set on the dragged element, positions kept in a variable (not read back from styles) and written through `transform` in `requestAnimationFrame`. CSS transitions can't take an initial velocity, so the settle after a fling is a spring: a library's, or a small spring stepped in `requestAnimationFrame`.
- Electron and Tauri render web content: the same rules apply, and the OS reduced-motion setting reaches `prefers-reduced-motion`.

## Android

- **Compose:** `animate*AsState` and `updateTransition` for state; `AnimatedVisibility` for enter and exit; `tween(durationMillis, easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f))` for timed motion; `spring(dampingRatio, stiffness)` for physical motion.
- **Gestures:** `Animatable` with `animateTo(target, initialVelocity = …)` and a `VelocityTracker`, or `AnchoredDraggable` for sheets and swipe-to-dismiss.
- **Cheap properties:** `Modifier.graphicsLayer { translationY; scaleX; alpha }` instead of animating size or padding, which relayouts every frame.
- **Views:** `ViewPropertyAnimator`, and `SpringAnimation` (`androidx.dynamicanimation`) with `setStartVelocity` (px/s) for flings.
- **Reduced motion:** the system animator duration scale ("Remove animations" sets it to 0), readable through `Settings.Global.ANIMATOR_DURATION_SCALE` or `ValueAnimator.areAnimatorsEnabled()`. When it is off, replace travel with a short fade rather than jumping.
- **Haptics:** `performHapticFeedback` with a matching constant, fired on the same frame as the visual feedback.

## iOS and macOS

- **SwiftUI:** `withAnimation(.spring(duration:bounce:))` (iOS 17+) or `.spring(response:dampingFraction:)` on older targets; `.transition(.opacity.combined(with: .scale(scale: 0.96)))` for enter and exit; `@Environment(\.accessibilityReduceMotion)` for reduced motion.
- **UIKit:** `UIViewPropertyAnimator` for interruptible, scrubbable animations; `UISpringTimingParameters(dampingRatio:initialVelocity:)` to hand over gesture velocity; `UIAccessibility.isReduceMotionEnabled` and its change notification.
- **Gestures:** a pan gesture's velocity, or `DragGesture`'s `predictedEndTranslation` (and `velocity`, iOS 17+), choose the target; never disable user interaction during the animation.
- **Haptics:** `UIImpactFeedbackGenerator`, or `.sensoryFeedback` (iOS 17+), on the same frame as the visual change.
- **macOS:** `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`.

## Windows

- **WinUI / Windows App SDK:** implicit and explicit Composition animations (including natural-motion spring animations) run off the UI thread; check `UISettings.AnimationsEnabled` for the system's animation setting.
- **WPF:** Storyboards on `RenderTransform` and `Opacity`, not on `Width`/`Height`/`Margin`; `SystemParameters.ClientAreaAnimation` reflects the system setting.

## Linux

- **GTK 4 / libadwaita:** `AdwTimedAnimation` and `AdwSpringAnimation`; respect the `gtk-enable-animations` setting.
- **Qt:** `QPropertyAnimation` with `QEasingCurve` (`OutCubic` or similar for enter and exit) in widgets; `Behavior`, `NumberAnimation` and `SpringAnimation` in Qt Quick. Animate position, scale and opacity, not layout.
