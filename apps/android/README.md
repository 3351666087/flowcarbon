# FlowCarbon for Android

A native shell around the FlowCarbon web app (`https://flowcarbon.veritybench.org/`, set in
`app/src/main/res/values/config.xml`). Java and the platform SDK only — no AndroidX, no Google services — so it
installs on any Android 8.0+ phone, including those sold without Google apps.

## What the shell adds

| | |
|---|---|
| Launch | An empty system splash on the brand stage hands over to the intro: the mark's three floors rise into place, the wordmark settles as its letter spacing closes, a sweep runs until the page shows real content (the sign-in form or the app's navigation, not its loading state), then the mark lifts away while the page fades and settles in. The intro never runs shorter than its choreography (1.15 s), and gives up waiting for content 5 s after the page has loaded. |
| Edge to edge | The page draws under the status and navigation bars, as native screens do; the shell tells it where the bars are (`--app-top`, `--app-bottom`) and only the keyboard takes room away. |
| Links | Invitations, password resets and other links to the site open in the app (verified App Links); anything else goes to the browser. |
| Shortcuts | Long-press the icon for Opportunities, Floors and Overtime requests. |
| Haptics | `FlowCarbonShell.feel(kind)` with tick, confirm, reject or press; the web app uses them for tabs, switches, pull to refresh and refusals. |
| System bars | Their icons switch between light and dark with the page's background, so they stay legible in either theme. |
| Loading | A teal hairline under the status bar for full page loads; it eases toward reported progress and trickles between reports. |
| Back | Back steps through the page's history. On Android 13+ the callback is only registered while there is history, so the system's predictive back-to-home animation plays at the root. |
| Offline | When the network or the server is gone, the stage returns: the floors drift apart and back while it waits, and the app reconnects by itself when a network appears. A retry button shakes (with haptics) if it is pressed while still offline. |
| Downloads | Report CSVs go through the download manager with the session cookie and appear in Downloads. |
| Accessibility | All motion is skipped when the system's animations are turned off. |

Motion uses the Material 3 emphasized curves (`Motion.java`): entrances decelerate, exits accelerate, loops follow
a sine.

## Build

CI (`.github/workflows/android.yml`) builds, lints and signs the release APK on every change under `apps/android`,
and on a version tag attaches `FlowCarbon-<version>.apk` and `SHA256SUMS` to the GitHub release.

A development build ("FlowCarbon Dev", installs beside the release app) can load a dev server on your computer:

```bash
gradle -Pflowcarbon.appUrl=http://localhost:3000/ :app:assembleDebug
adb reverse tcp:3000 tcp:3000
```

Locally, with JDK 17+ and the Android SDK (or Android Studio):

```bash
cd apps/android
gradle -Pflowcarbon.version=0.1.2 :app:assembleRelease    # Gradle 9.8; unsigned without a key
```

Signing reads `FLOWCARBON_KEYSTORE`, `FLOWCARBON_KEYSTORE_PASSWORD`, `FLOWCARBON_KEY_ALIAS` and
`FLOWCARBON_KEY_PASSWORD` from the environment; CI takes them from the repository secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Keep the keystore: updates must be
signed with the same key.

## Install

Download the APK from the release (or from the deployment's `/download/` path), allow installing from that source
when Android asks, and open it. With a phone on USB and debugging enabled:

```bash
adb install -r FlowCarbon-0.1.2.apk
```
