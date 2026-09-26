# iOS reference

## Build

- Requirements: a Mac with Xcode, and the version from the project's CI or `.xcode-version`. Check it with `xcodebuild -version` and select it with `xcode-select -p`.
- Find the targets: `xcodebuild -list -workspace App.xcworkspace` (or `-project App.xcodeproj`).
- Build and test on a simulator:
  ```bash
  xcrun simctl list devices available
  xcodebuild -workspace App.xcworkspace -scheme App \
    -destination 'platform=iOS Simulator,name=iPhone 16' test | xcbeautify   # use xcpretty if xcbeautify is missing
  ```
  Keep the raw exit code. Piping into `xcbeautify` hides it, so use `set -o pipefail`.
- Dependencies:
  - Swift Package Manager: `Package.resolved` is committed.
  - CocoaPods: `pod install` with the committed `Podfile.lock`.
  - Don't mix the two without a reason.
- Deployment target and Swift version come from the project settings. Apple periodically raises the minimum Xcode/SDK version for App Store submissions; check the current rule before a release.

## Simulator

```bash
xcrun simctl boot "iPhone 16"
xcrun simctl install booted path/to/App.app
xcrun simctl launch booted <bundle-id>
xcrun simctl io booted screenshot screen.png         # screenshot as evidence
xcrun simctl openurl booted "myapp://path"           # test deep links
xcrun simctl privacy booted reset all <bundle-id>    # reset permission prompts
```

## Code

- **UI:** SwiftUI for new screens, with state in an `@Observable` or `ObservableObject` model. Use UIKit where the project uses it or where SwiftUI lacks the capability. Build previews for new views.
- **Concurrency:** use Swift concurrency (`async/await`, actors); UI updates go on `@MainActor`. Enable strict concurrency checking if the project does. Don't block the main thread.
- **Storage:** Keychain for tokens and secrets. SwiftData, Core Data or SQLite for data. `UserDefaults` only for non-sensitive preferences.
- **Privacy:**
  - usage-description strings (`NS…UsageDescription`) for every permission;
  - a privacy manifest (`PrivacyInfo.xcprivacy`) for the app and for third-party SDKs, where required;
  - App Tracking Transparency before tracking.
- **Networking:** use `URLSession`. App Transport Security stays on (no arbitrary loads). Pinning only with a rotation plan.
- **Tests:** XCTest or Swift Testing for logic; XCUITest for critical flows. Inject dependencies through protocols for fakes.

## Signing and release

- Automatic signing for development. For distribution, certificates and profiles are managed in CI (fastlane match, or Xcode Cloud). The agent never exports private keys or Apple ID credentials.
- Archive: `xcodebuild archive …`, then `-exportArchive` with an `ExportOptions.plist`. Upload through CI or Transporter, and only on the user's instruction.
- Distribute through TestFlight first, then a phased release with crash monitoring.
