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
- **fMP4 channels (~10-20% of live streams + their VODs)** are fixed via the local TS remux
  (requires the TV-local server, see below).

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

## Ad-free live proxy (ported from twitch-adfree-webos)

Live masters (`usher.ttvnw.net/api/channel/hls/*.m3u8`) are fetched through the
ad-free proxy chain ported from `adamff-dev/twitch-adfree-webos`
(`src/scripts/patch_usher_xhr.js`): luminous bare template
(`https://as.luminous.dev/live/<channel>`, original query params merged — template
wins) → rte prefix proxies → direct request as the last tier. Only live masters are
proxied; VOD/clip playlists keep the direct flow. Kill switches:
`?sttv_adfree_proxy=0` or `localStorage STTV_ADFREE_PROXY=0`
(`attemptAdfreeProxyChain` / `adfreeProxyEnabled` in `webos/bridge/webosCompatBridge.js`).

**Plan A (attach the proxy master URL natively) is dead on this TV**: the platform
media stack cannot fetch `as.luminous.dev`/rte hosts —
`MEDIA_ERR_SRC_NOT_SUPPORTED` (error 4) — while page/service XHR to the same hosts
works fine (the proxy chain itself always succeeded: `adfree_proxy_success`).

**Plan B (shipped)**: `sourceFromQuality()` detects an ad-free proxy raw URI
(`isAdfreeProxyUrl`) and, when no explicit quality pick or `SetMainPlayerBitrate`
resolution cap applies, returns a variant URL picked from the proxied master body
(`pickFromMaster`) instead of the proxy URL. The body still comes from the proxy, so
the ad-free property is preserved, while the attach URL stays inside the
natively-playable ttvnw family (`*.playlist.ttvnw.net` variants over
`*.j.cloudfront.hls.ttvnw.net` segments — verified structurally identical to the
direct master apart from signed URLs/edge nodes). Falls back to the raw proxy URI
when the body has no usable variant (pre-Plan-B behavior). `attachNativeMain()`
additionally clears a stale `crossorigin="anonymous"` left by the VOD remux path for
non-REMUX URIs: ttvnw answers 403 to any foreign `Origin`, which would break the
variant attach the same way (no canvas readback exists anywhere, so no-cors is safe).

`main_source_selected` debug log records the chosen attach URI plus
`proxyMaster`/`variantAttach` flags for observability.

Verified on TV (2026-11-07): `adfree_proxy_success tier:luminous` →
`main_playlist_parsed` → `main_source_selected ... proxyMaster:true
variantAttach:true` → no `main_video_error`, live plays (`readyState=4`,
`currentTime` advancing for minutes), `Android.SetQuality(1)` swaps to 720p and
back to auto cleanly. Known non-blockers: the rte prefix tier currently 404s
(fallback only), and `mse_probe_fail service_unavailable` only appears when the
page runs outside the app wrapper (no `PalmSystem` → wrong `<id>.hls` service
name); in the proper app context the probe succeeds (`mse_probe_ts segs:15`).

## Playback: fMP4 channels (fixed via local TS remux)

Channels on a **custom transcode stack** (`TRANSCODESTACK="Custom:..."`, ~10-20% of streams,
including Pisty, plus their VODs) serve **fMP4** segments (`#EXT-X-MAP`, `.mp4`) instead of
MPEG-TS. No usher/token parameter changes the format — it is decided per transcode stack
server-side.

**Every fMP4 decode path on this TV is dead** (all verified on-device):

| Path | Behavior |
| --- | --- |
| Native HLS (`<video src=fmp4 playlist>`) | Demuxes (duration + buffered grow) but never decodes a frame: `videoWidth=0`, `readyState` stuck at 1 |
| MSE (bridge player) | Ingests init + media but emits zero buffered samples / dies `MEDIA_ERR_SRC_NOT_SUPPORTED` right at the init append |
| Progressive MP4 of the same codec (clips) | Works — the decoder itself is fine |
| **MPEG-TS native HLS** | **Works flawlessly** (adaptive up to 1280x720) |

So the fix stops asking this browser to decode fMP4: the **TV-local node server
(`tools/tv-serve.js`, port 8099) transmuxes fMP4 → MPEG-TS** — own ISO-BMFF parser + TS muxer
written for ES5/node 0.12 (PAT/PMT with MPEG-2 CRC, per-PES PTS/DTS, PCR on video PES, ADTS
headers built from `esds`, Annex-B NAL rewriting with in-band SPS/PPS before IDRs) — and serves
a **local HLS playlist** (`/hls/master.m3u8?u=<original>`): variant URIs are rewritten to
`/hls/var.m3u8?u=...`, media playlist URIs to `/hls/seg.ts?u=...&m=...` (the `EXT-X-MAP` is
dropped, TS is self-contained; `EXTINF`/`MEDIA-SEQUENCE`/`PDT` tags are preserved verbatim).
The platform player consumes the result exactly like a TS channel.

Bridge integration (`startRemuxNative` in `webos/bridge/webosCompatBridge.js`): when the
format probe reports fMP4, the bridge health-checks `http://127.0.0.1:8099/health` (2.5s
timeout) and swaps the native `video.src` to the local remux playlist via
`attachNativeMainTo`; if the server is unreachable it falls back to the previous MSE path.
`ms.uri`/`ms.rawUri` keep pointing at the original Twitch URL, so quality selection
(`SetQuality`) and `RestartPlayer` behave unchanged. Chrome 38 allows the mixed content this
requires (https page → `http://127.0.0.1`): verified on the GitHub Pages origin — health XHR
returns `200 ok`, the remux video plays (`readyState=4`, 852x480, `currentTime` advancing),
and swapping `src` after a stalled native-fMP4 attach recovers cleanly.

Server hardening learned during bring-up (all in `tools/tv-serve.js`): one automatic retry per
upstream fetch (this TV's WiFi drops cause `ENETUNREACH`/timeouts that otherwise kill live
playback), a last-good playlist cache answered instantly while a 1s background refresh keeps
it current (the player's live-edge refresh loop never waits on upstream latency), tolerance
for out-of-bounds samples (ad-inserted segments whose init does not match get skipped instead
of failing the whole segment), LRU segment-TS cache, and timestamped request logging to
`/tmp/httpd.log`.

**Deployment**: copy `tools/tv-serve.js` to `/media/developer/sttv_stage/sttv_serve.js`.
The server is **not** autostarted anymore: it starts only with a manual app open
(wrapper/bridge `ensureSttvServe`, `pgrep`-guarded) and stops when the app closes
(unload hook + 90s heartbeat timeout, see the boot section). Without the server,
fMP4 content fails fast (health check misses → one ensure retry → MSE fallback →
the existing error dialog).

**Validation**: Pisty VOD `2919603413` transmuxes and plays continuously on the TV
(`readyState=4`, `currentTime` 0→47s+, buffered 0→200s, no stalls). Because segment fetches
now happen server-side, VOD playback no longer depends on `/sttv_proxy`, which does not exist
on the GitHub Pages origin — that alone fixes the previous Pages-only VOD failure
(`proxy_status_404` → "Player unable to play due to player error").
Re-verified 2026-11-08 with the ad-free-proxy/Plan B bridge build (`3d7eaaf5a`): a Pisty
fMP4 VOD plays through the remux (`video.src` on `http://127.0.0.1:8099/hls/master.m3u8`,
`readyState=4`, no media error), so the Plan B edits did not regress the VOD/fMP4 path.

Test harnesses for this investigation live in the session helpers (`expr_*.js` run through
`cdp_eval_sttv.py`; offline validators `tv_chrome38parse.js`, `tv_nalwalk.js`,
`tv_overlap.js`, `tv_boxes2.js`, `tv_init.js`, `tv_avcc.js` on the TV; PC-side
`test_remux.js` validates the transmuxed TS byte-for-byte — sync/PID/CC continuity, PAT/PMT
CRC + program mapping, PES headers/lengths, DTS ordering, ADTS framing).

## Boot: ssh + telnet at boot, app + remux server only when opened

Design goal: at every TV boot the rooted extras — dropbear (ssh) and telnetd —
start by themselves (no need to open the Homebrew Channel manually), while the
SmartTwitch app itself does **not** auto-launch (keeps TV performance) and the
local remux server runs **only while the app is open**.

### SmartTwitch must not auto-launch

An earlier SSH-bootstrap step created a *persistent* webOS activity
`com.tbsniller.smarttwitchwebostv.boot` (activityId **111**) whose callback
launched the wrapper with `sttv_boot_kick: 1`. It fired on `core-boot-done` at
every boot, so each boot flashed the SmartTwitch splash and then fell back to
live TV. It has been **cancelled** and does not come back:

```
luna-send -n 1 luna://com.palm.activitymanager/cancel '{"activityId":111}'
```

Verified across a full reboot: `grep -ac 'NL_APP_LAUNCH_BEGIN.*smarttwitchwebostv'
/var/log/messages` -> `0`, and no `NL_APP_LAUNCH` entry for
`com.tbsniller.smarttwitchwebostv` at all. The wrapper's `sttv_boot_kick`
branch (`webos/app/index.js`) is now dormant — nothing launches the wrapper
with that param any more — and is kept only as an inert fallback.

### ssh + telnet: Homebrew's own boot activity + a 5-minute retry

`/var/lib/webosbrew/startup.sh` is what starts dropbear + telnetd and runs
`run-parts /var/lib/webosbrew/init.d` (which includes `90_root_password_bind`).
Homebrew Channel already intends to invoke it from a persistent activity, so
the boot chain reuses that instead of inventing a second one:

- activity `org.webosbrew.hbchannel.service.autostart`, **created as the
  Homebrew service identity**:
  `luna-send -a org.webosbrew.hbchannel.service -n 1
  luna://com.palm.activitymanager/create '{...}'`. Creating it from the shell
  identity fails with `errorCode:13 "Activity creator doesn't have rights to
  call its callback"`.
- `type: {foreground: true, persist: true, continuous: true}`; `trigger` =
  `palm://com.webos.bootManager/getBootStatus` (`subscribe: true`) with
  `where: {prop: ["signals","core-boot-done"], op: "=", val: true}`;
  `schedule: {interval: "5m", local: true}`; `callback` =
  `palm://org.webosbrew.hbchannel.service/autostart`.
- create quirks found by testing: `start: true` **and** a callback are
  mandatory (`errorCode:22` otherwise), `foreground` must be `true` when
  present (`errorCode:12`), and `schedule.interval` only accepts
  `1d … 12h, 6h, 3h, 1h, 20m, 30m, 15m, 10m, 5m`.
- **why both trigger and schedule**: `core-boot-done` lands at ~25.4s
  (`/var/log/bootd.log`), which is before the Homebrew service is guaranteed
  to be usable — `elevate-service`, the root elevation, is only executed by
  `startup.sh` itself — so a single fire-and-forget kick at that point is racy
  and was observed to be lost (a boot with no dropbear). The `5m` schedule is
  the reliable path: it re-arms the same callback until `/tmp/webosbrew_startup`
  exists, i.e. until `startup.sh` has actually run. The activity definition is
  persisted in db8 (kind `com.palm.activity:1`, `/var/db/main/*.ldb`) so it is
  restored on every boot.
- the callback is idempotent — it answers `"Startup script already executed."`
  once `/tmp/webosbrew_startup` exists — so extra fires cost nothing.

Verified on the TV (2026-11-08, full reboot): no SmartTwitch launch, no app
window of any kind, `/tmp/webosbrew_startup` written automatically
(boot+320s, i.e. the first schedule tick), `dropbear` + `telnetd` running as
uid 0 with ports 22 and 23 open, `90_root_password_bind` applied
(`/etc/shadow` bind-mounted from the writable copy), and port 8099 still
closed — the remux server only exists while the app is open.

### Normal (manual) launch

`launch()` in `webos/app/index.js` branches on the launch params: with
`sttv_boot_kick` present it only runs `bootKickWithRetry()` (kick
`org.webosbrew.hbchannel.service/autostart`, then close this window) and never
navigates — this path is dormant now that activity 111 is cancelled. On a
normal manual launch it kicks the service, runs `ensureSttvServe()` and
navigates to the hosted app.

### sttv_serve lifecycle — starts with the app, stops when it closes

Source: `tools/tv-serve.js`.

- *start*: wrapper `ensureSttvServe()` on manual open and bridge bootstrap
  (`hb exec`: `pgrep -f sttv_serve.js || nohup node sttv_serve.js 8099` —
  idempotent). Never started by the boot chain; `99-sttv-serve` was removed
  from `webos/homebrew/` and from the TV's `/var/lib/webosbrew/init.d/`.
- *stop*: bridge `pagehide`/`beforeunload` → `pkill -f sttv_serve.js`
  (immediate when unload fires), **plus a heartbeat** as the reliable path:
  the bridge pings `/health` every 10s while the page is alive and the
  server exits after 90s without any request — so even a webOS process kill
  (which does not reliably fire unload events) stops it within ~90s.
- *self-heal*: a failed heartbeat re-ensures the server (it may have
  self-stopped while the page was suspended), and becoming visible again
  re-ensures it too; active playback requests also keep it alive.

Verified end-to-end on the TV (2026-11-08): boot with no manual action ->
`/tmp/webosbrew_startup` written automatically, ports 22+23 up, port 8099 down,
no SmartTwitch window; manual open -> server up; app close -> server stopped
~70s later via the heartbeat (unload hooks did not fire on this close).

Homebrew Channel was upgraded 0.6.3 -> 0.7.3 on this TV (backup:
`/media/developer/hb_backup_063.tgz`); its service registers the same
`org.webosbrew.hbchannel.service.autostart` activity via `registerActivity`
for its own startup — the definition above is the one that activity ends up
with once `replace: true` has been applied to it.

## Quality switching (fMP4 VOD)

Quality changes keep the remux route alive on any page state:

- `SetQuality` with an unknown stream format (typical after a session restore
  whose first probe failed) runs the full probe flow instead of attaching the
  raw fMP4 variant URL (which stalls forever on webOS 3.4). Known-TS streams
  keep the instant native swap.
- The format probe self-heals: on total failure (luna service cold start,
  WiFi blip) it re-probes every 8s (8 rounds, generation-guarded) instead of
  giving up - a failed restore probe no longer leaves the player spinning.
- The stall watchdog only snapshots a resume position when `currentTime` is
  non-zero, so the raw-attach -> remux swap cannot wipe a pending VOD resume
  (switching quality used to restart from0).
- `getQualities` returns the Android contract fields (`band`/`codec`), so
  the quality OSD renders `480p30 | 1.35Mbps | avc+mp4a` instead of
  undefined/garbage suffixes.