# YouTube & Spotify Auto Pause

Chrome extension that syncs playback between YouTube and Spotify Web Player.

## What it does

- Pauses Spotify when YouTube starts playing.
- Resumes Spotify when YouTube pauses, ends, or closes.
- Can pause YouTube on blur and resume on focus.
- Saves all toggle settings in browser local storage.
- Supports first-open Spotify autoplay with retries for slower page loads.
- Includes optional headphone gating for Spotify auto-resume.

## Toggles

### YouTube group

- `Auto play/pause youtube`: Master switch for YouTube auto pause/resume behavior.
- `Play video on focus`: Resume YouTube when returning to the tab/window.
- `Pause video on blur`: Pause YouTube when tab/window loses focus.
- `Don't pause in fullscreen`: Ignore blur pause when YouTube is in fullscreen.

### Spotify group

- `Auto play/pause spotify`: Master switch for Spotify auto control behavior.
- `Stop spotify when youtube plays`: Pause Spotify when YouTube starts.
- `Play spotify when youtube stops`: Resume Spotify when YouTube pauses/ends/closes.
- `Play music on first open`: Attempt autoplay on Spotify tab open.
- `Require headphones`: Only auto-resume Spotify when headphone-like output is detected.

## Install (Developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Permissions used

- `storage`: save your toggle settings.
- `tabs`: find YouTube/Spotify tabs.
- `scripting`: control play/pause buttons in page context.
- Host permissions:
  - `https://www.youtube.com/*`
  - `https://open.spotify.com/*`

## Notes and limitations

- Spotify UI/labels can vary by language; logic tries to handle multiple languages.
- Headphone detection depends on browser/device visibility and may be unavailable on some systems.
- Spotify Web Player may require user interaction or active session before autoplay works.