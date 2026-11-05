# RedditPix v1.0.0 — Firefox release directory

This directory holds everything needed for the first official Mozilla
Add-ons (AMO) submission of **RedditPix**.

| File | Purpose |
| --- | --- |
| `RedditPix-v1.0.0-firefox.zip` | **The deliverable.** Unsigned Firefox MV3 package with `manifest.json` at the archive root, ready to upload to AMO. |
| `README.md` | This file. |
| `PRIVACY.md` | Privacy policy; its URL must be reachable from the AMO listing. |
| `CHANGELOG.md` | v1.0.0 release notes (also kept at the repository root). |
| `FIREFOX-AMO-LISTING.md` | Copy-paste listing copy and submission checklist. |
| `RELEASE-VERIFICATION.md` | Build commands, test results, ZIP checks, and what remains manual. |

## What this package is

- Manifest V3, name `RedditPix`, version `1.0.0`.
- Firefox metadata (add-on id `presentation-mode@redditp.com`,
  `strict_min_version` 140.0, Android 142.0, `data_collection_permissions:
  ["none"]`) is baked into the packaged manifest.
- Unsigned. AMO signs packages during publication; a temporary local install
  (`about:debugging`) works without signing.

## Build / verify from source

```sh
npm install
npx playwright test --workers=1        # full offline regression suite
node nodejs/package-extension.js firefox
npx web-ext lint --source-dir build/firefox-extension
shasum -a 256 RedditPix-v1.0.0-firefox.zip
```

See `../README.md` for the full development guide.

## Quick submission checklist

1. Web-host `PRIVACY.md` and fill the `[confirm/supply]` URLs in
   `FIREFOX-AMO-LISTING.md`.
2. Verify the SHA-256 of `RedditPix-v1.0.0-firefox.zip` against
   `RELEASE-VERIFICATION.md`.
3. Upload the ZIP in the AMO Developer Hub and paste the listing copy.
4. Take screenshots showing ordinary subreddits and the real viewer UI.
