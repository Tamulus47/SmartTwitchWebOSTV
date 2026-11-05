# Chrome 38 (webOS 3.4) Compatibility

Target device: LG 43LH602V-TD, webOS 3.4.3, Chromium `Chrome/38.0.2125.122` (V8 3.28, ES5-only
runtime). The hosted page is loaded into the app wrapper, so **everything shipped under
`release/` must parse and run on ES5**.

## Why this matters

Chrome 38 has no ES6 syntax support. A single template literal (backtick string) anywhere in
`main.js` makes the whole script fail to parse (`SyntaxError: Unexpected token ILLEGAL`), which
shows up as a black screen: `index.html` renders but `Main_Start()` never runs.

Chrome 38 also predates several ES2015+ *runtime* APIs the upstream app calls:
`String.prototype.startsWith/includes/endsWith/repeat/padStart/padEnd` (Chrome 41+),
`Array.prototype.includes/find/findIndex` (Chrome 45/47+),
`Object.assign` (45+), `Object.values/entries` (54+), `Element.closest` (41+),
`NodeList.forEach` (51+), `URLSearchParams` (49+), `window.fetch` (42+).

## Fixes (and where they live)

| Concern | Fix | Location |
| --- | --- | --- |
| ES6 template literal in `Play_extractQualitiesTest()` — parse-time blocker, cannot be fixed from a bridge because the SyntaxError happens while `main.js` parses | Converted to an ES5 array + `.join('\n')` producing the identical string | `app/specific/Play.js` (documented AGENTS.md exception: wrapper/bridge cannot fix parse-time failures) |
| Missing ES2015+ runtime methods called by app code | Feature-detected, ES5-only polyfills installed at bridge parse time, before `main.js` executes | `webos/bridge/webosCompatBridge.js` → `installLegacyRuntimePolyfills()` |
| Script ordering guarantee (polyfills must run first) | Bridge `<script>` tag injected before `main.js` | `tools/upstream/prepareHostedRelease.js` |
| Regression protection | ES5 AST audit + runtime API scan | `tools/chrome38-audit.js`, `tools/chrome38-apiscan.js`, `tools/chrome38-audit-file.js` |

`webos/app/index.js` (wrapper) uses `new URL()` with `searchParams`, but every use is inside
`try/catch` with an ES5 string-manipulation fallback, so it is safe on Chrome 38.

CDN dependencies (`firebase-app.js`, `firebase-analytics.js`, `gtag.js`) were audited and are
ES5-parsing; `firebase` init is additionally wrapped in `try/catch` upstream
(`Main_Startfirebase` → `skipfirebase`).

## Quality gate

```bash
npm run lint              # jshint on app/ sources + webos bridge
node tools/chrome38-audit.js    # fails on any non-ES5 syntax in shipped JS/HTML
node tools/chrome38-apiscan.js  # reports runtime APIs newer than Chrome 38
npm run hosted:prepare    # stages release/ + injects bridge before main.js
npm run webos:package     # builds the IPK
```

`chrome38-apiscan.js` still reports `URL.prototype.searchParams` and `window.fetch` inside the
bridge — both are guarded (`try/catch` fallback / `typeof w.fetch !== 'function'` early return)
and are expected.

## Known remaining gaps

- Analytics (`firebase`/`gtag`) may silently no-op on the TV; playback does not depend on them.
- `checkForkVersionAndRefresh()` (bridge auto-update check) early-returns without `fetch`;
  the app still works, it just does not hot-reload on new upstream builds.
- **fMP4 channels (~10-20% of live streams + their VODs) do not play** — see below.

## Playback: playlist fetch (fixed)

None of the playlist hosts send CORS headers for our origin (`http://127.0.0.1:8099`), so a
browser XHR to `usher.ttvnw.net` deterministically fails with status 0, and
`playlist.ttvnw.net` actively rejects the browser `Origin` header (403). The only working path
is the packaged luna JS service (`com.tbsniller.smarttwitchwebostv.hls`). The bridge had a race
in its service fallback that caused intermittent black screens:

| Problem | Fix (all in `webos/bridge/webosCompatBridge.js`) |
| --- | --- |
| The doomed XHR's late status-0 event completed the request before the luna service answered, so the app got an empty playlist and gave up | Once the service fallback is in flight, only its synthetic result may complete the request (`serviceAttempted && !synthetic` guard) |
| First service call after boot pays the node process cold start and timed out of the watchdog | `USHER_PLAYLIST_SERVICE_COLD_GRACE_MS` (extra wait until first reply), one retry on timeout, `warmUsherPlaylistService()` pre-spawn at bootstrap |
| Service fetch failures were terminal | One retry on timeout/unavailable (`usher_hls_service_retry`) |
| Format probe needed variant playlists | Service allowlist extended to `*.playlist.ttvnw.net` `/v1/playlist/*` and any https `*.m3u8` (VOD media playlists on cloudfront) — `webos/service/hls_service.js` |
| VOD segments have no ACAO header (page XHR impossible) | Same-origin `/sttv_proxy?url=` streaming route with redirect following — `tools/serve-staged.js` + TV `/tmp/sttv_serve.js` |

Verified live end-to-end: service_ok → master parsed → native attached → `readyState=4`,
`currentTime` advancing, ABR ramping, chat rendering.

## Playback: fMP4 channels (known limitation)

Channels on a **custom transcode stack** (`TRANSCODESTACK="Custom:1_Source_Max_1440p60..."`,
~10-20% of streams, plus their VODs) serve **fMP4** segments (`#EXT-X-MAP`, `.mp4`) instead of
MPEG-TS. No usher/token parameter changes the format — it is decided per transcode stack
server-side. Chrome 38's native HLS demuxer cannot decode fMP4: the bytes buffer forever but
`readyState` sticks at 1, `videoWidth=0`, eventually `MEDIA_ERR_DECODE`.

An **MSE player** is implemented in the bridge and its plumbing is verified working:
format probe via luna (`mse_probe_fmp4`/`mse_probe_ts`, master→variant resolution, quality cap
480p for cold starts), `MediaSource.isTypeSupported('video/mp4; codecs="avc1..."'`) = true,
init segment append + metadata (`videoWidth=852`), unknown-box sanitizer (Twitch `emsg` boxes),
segment fetch via page XHR (live hosts `ACAO:*`) with `/sttv_proxy` fallback (VOD), and a
control asset (Unified Streaming tears-of-steel fMP4) buffers with correct timing and no
errors through the same pipeline.

What remains unresolved: **Twitch's `trun` boxes are non-standard** — the payload is
per-sample interleaved `[duration, size, flags]` (`dataLen == count*12` video / `count*8`
audio, durations verified to sum exactly to the `tfdt` deltas) while the flags declare the
canonical `first-sample-flags + dur (+ size)` layout. Chrome 38's spec-strict parser accepts
the original timing (measured `buffered` span `62.03300-62.13300` = exactly the `tfdt` delta)
but fails to decode (`err=3`) and rejects every subsequent fragment. Rewrites tested and
failed (each changes behavior, none plays): explicit `base-data-offset`, append-start /
moof-end relative `data_offset`, `styp` prefix, canonical trun flags `0x601`/`0x205`,
audio-track + orphan `trex` stripping, per-sample flag sanitization, `data_offset±1`,
fragment-by-fragment appends with long pacing. Determining Chrome 38's exact `trun`
interpretation needs its source; until then fMP4 streams fail gracefully (the app returns to
the list), while MPEG-TS channels — the majority — play normally.

Test harnesses for this investigation live in the session helpers (`expr_*.js` run through
`cdp_eval_sttv.py`, offline box inspectors `tv_boxes2.js`/`tv_trw.js`/`tv_init.js` on the TV).
