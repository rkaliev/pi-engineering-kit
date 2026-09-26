---
name: mobile-development
description: Use when building, testing, signing or releasing Android or iOS apps, including Kotlin, Swift, Flutter or React Native code, emulators, simulators, permissions or store submission
---

# Mobile development

Mobile code runs on devices you don't control: old OS versions, killed processes, flaky networks, strict stores. Verify on an emulator or simulator, and say what was never run on a real device.

Platform details:
- `references/android.md`: Gradle, Compose, emulator, signing, Play.
- `references/ios.md`: Xcode, SwiftUI, simulator, signing, App Store.

## Always

- **Follow the project's architecture**, for example MVVM/MVI with unidirectional state, the DI framework, and the navigation library. New screens copy an existing screen's structure.
- **Lifecycle:** assume the process can die at any moment.
  - Persist in-progress user input.
  - Restore state after process death and configuration change.
  - Never do I/O on the main thread.
  - Cancel work with the screen's scope.
- **Network:**
  - timeouts;
  - retries only for idempotent calls;
  - an offline state in the UI;
  - no blocking spinner without a cancel.
  - Cache deliberately.
- **Permissions:** request them in context, at the moment of use, and handle denial and "don't ask again". Declare only the permissions you use.
- **Security:**
  - secrets never ship in the binary (anything in the app can be extracted);
  - tokens go in Keystore/Keychain-backed storage;
  - TLS validation stays on;
  - deep links and intents are validated;
  - WebViews are locked down.
  See security-review and OWASP MASVS.
- **Accessibility and i18n:**
  - content descriptions or labels;
  - dynamic type and font scaling;
  - contrast;
  - RTL where relevant;
  - no hard-coded user-visible strings.
- **Versions:**
  - min, target and compile SDK or deployment target come from the build files, never from memory;
  - store policies (target API level, privacy manifests, SDK requirements) change yearly, so check the current rules in the official docs before a release.

## Verification ladder

Report which rungs you actually ran:
1. Unit tests: ViewModels, use cases, mappers, formatting.
2. Build: debug and release variants (R8/ProGuard or Swift optimization can break things only in release).
3. Instrumented or UI tests on an emulator or simulator: critical flows.
4. Manual run on an emulator or simulator, with screenshots for UI changes.
5. Real device: hardware such as the camera, NFC, Bluetooth, payment terminals and printers; performance; push notifications.

## Release

- Bump the version code/name (or build number) through the project's mechanism.
- Signing keys and store credentials live in CI secrets or the keychain, never in the repo. The agent never handles upload keys; the user or CI does.
- Changelog, store listing, and staged rollout with crash monitoring (Crashlytics, Sentry). Have a rollback or hotfix plan.
- Publishing to the stores is outward-facing and irreversible for users: it always needs the user's go-ahead.
