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

## Hosting (fork)

The wrapper default (`webos/app/index.js`) points at
`https://tamulus47.github.io/SmartTwitchWebOSTV/release/index.html` — this fork's GitHub
Pages, built from the committed `release/` tree (synced from `npm run hosted:prepare`,
which injects `githubio/js/webosCompatBridge.js` before `main.js`). The installed wrapper on
the TV was updated from this tree; launches can still be overridden with a `params.target`
(see `/tmp/tv_launch.sh` on the TV for the TV-local dev server, which also provides the
`/sttv_proxy` route — on Pages that route does not exist, so only the live fMP4 segment
path, which needs no proxy, would be available there).

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

What remains unresolved: **decode of the first buffered frame fails at runtime** and static
analysis has eliminated every bitstream cause. Established from Chrome 38's actual source
(`chromium/chromium @38.0.2125.122`, `media/formats/mp4/box_definitions.cc`,
`track_run_iterator.cc`, `mp4_stream_parser.cc`):

- Chrome 38 uses the **legacy trun flag table** (`data-offset=0x1, first-sample-flags=0x4,
  duration=0x100, size=0x200, flags=0x400`) and reads trun data as **per-sample rows**
  `[dur][size][flags][cts]` — Twitch's truns (`0x301`/`0x701`) parse exactly correctly
  under it (durations verified to sum to the `tfdt` deltas).
- Sample data is read at `moof_queue_position + trun.data_offset` (moof-relative);
  `tfhd` with an explicit `base-data-offset` is hard-rejected (`RCHECK(!(flags & 1))`),
  which is why an explicit-base rewrite failed.
- A faithful node port of these checks against the real VOD segments
  (`tv_chrome38parse.js`) reports `ALL_CHECKS_PASS`, and a NAL walk at the exact
  bytes Chrome 38 reads (`tv_nalwalk.js`) yields a perfect `SPS+PPS+IDR` frame.
- `avcC` declares `Main@4.0` (`profile_indication=77`), `length_size=4` — matches the
  declared `avc1.4D401F` mime; `isTypeSupported` = true.

So the container, offsets, codec config and NAL framing are all provably correct, yet the
element fires `MEDIA_ERR_DECODE` ~170ms after the first media append (a standard control
asset, tears-of-steel, never reaches `readyState 2` either — no MSE frame has ever decoded
on this browser). Progressive MP4 playback of the same codec works on this device (clips),
so the failure is specific to Chrome 38's **MSE-side demux/decode pipeline** on webOS and
needs `chrome://media-internals` logs (blocked by the TV browser) to go further.

Implemented and verified while investigating: `timestampOffset` shift to a 0-based timeline
(`mse_timestamp_offset` — buffered moves from `62.x` to `0.0`, aligning with EXTINF duration,
resume seeks and the progress UI), a track-run overlap guard (`fixMseTrackOverlaps`,
no-op on well-formed segments), and a format probe + MSE plumbing that is otherwise
production-ready if the decode path is ever cracked.

Test harnesses for this investigation live in the session helpers (`expr_*.js` run through
`cdp_eval_sttv.py`; offline validators `tv_chrome38parse.js`, `tv_nalwalk.js`,
`tv_overlap.js`, `tv_boxes2.js`, `tv_init.js`, `tv_avcc.js` on the TV).
