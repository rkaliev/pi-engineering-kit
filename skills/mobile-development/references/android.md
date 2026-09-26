# Android reference

## Build

- Always use the Gradle wrapper: `./gradlew` (`gradlew.bat` on Windows). Don't install or assume a global Gradle.
- Common tasks:
  - `./gradlew assembleDebug` — build a debug APK.
  - `./gradlew testDebugUnitTest` — unit tests.
  - `./gradlew connectedDebugAndroidTest` — instrumented tests; needs a device or emulator.
  - `./gradlew lint` — Android Lint.
  - `./gradlew bundleRelease` — release AAB.
- JDK version comes from the project: the Gradle toolchain, `.java-version`, or CI config.
- Dependency versions live in `gradle/libs.versions.toml` (version catalog) when present. Add dependencies there, not inline.
- SDK levels (`minSdk`, `targetSdk`, `compileSdk`) are in the module's `build.gradle(.kts)` or convention plugins. Google Play periodically raises the required target API level; check the current requirement before a release.

## Emulator and device

```bash
sdkmanager --list_installed           # installed SDK packages
emulator -list-avds                   # available virtual devices
emulator -avd <name> -no-snapshot-load &
adb devices                           # confirm the device is connected
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n <applicationId>/<activity>
adb logcat --pid=$(adb shell pidof -s <applicationId>)
adb exec-out screencap -p > screen.png   # screenshot as evidence
```

- **Simulate process death:** put the app in the background, then `adb shell am kill <applicationId>`, then reopen it.
- **Simulate no network:** `adb shell svc wifi disable; adb shell svc data disable`.

## Code

- **UI:** Jetpack Compose. Keep state in the ViewModel (`StateFlow`), pass state down and events up, and build `@Preview`s for new components. For View-based code, keep to Views; don't mix without a plan.
- **Async:** coroutines with structured concurrency (`viewModelScope`, `lifecycleScope`). Inject dispatchers so tests can control them. Never use `GlobalScope`.
- **Persistence:** Room for relational data; DataStore for preferences. Encrypt sensitive values with Keystore-backed keys.
- **Background work:** WorkManager for deferrable, guaranteed work. Foreground services only for their allowed types, declared in the manifest.
- **Manifest:**
  - `android:exported` is explicit for every component with intent filters;
  - request only the permissions you use;
  - network security config: no cleartext in release.
- **R8:** keep rules for reflection and serialization (Moshi, Kotlinx, Gson). Always test the release build.

## POS and payment terminals

Many terminals run Android with a fixed OS version and a vendor SDK (printer, card reader, fiscal module). The SDK's supported API levels constrain `minSdk` and `targetSdk`. Keep vendor SDK calls behind an interface so you can test with a fake. See pos-systems.
