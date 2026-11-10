# AI Agent Task Handoff: Fix Live Stream Stuttering & Live Ad-Blocking (webOS 3.4.3 / Chrome 38)

> **Target Device:** LG 43LH602V-TD (webOS 3.4.3, Chromium 38.0.2125.122, V8 3.28)
> **Repository:** `SmartTwitchWebOSTV`
> **Prerequisite Reading:** Read `HANDOFF.md`, `docs/CHROME38.md`, and `AGENTS.md` before making any edits.

---

## 1. Mission Summary & Hard Constraints

### 1.1 Current Symptoms to Fix
1. **Live Playback Stuttering ("One Frame → Loading Spinner → One Frame"):**
   - **VODs** (including fMP4 VODs transmuxed via `sttv_serve.js`) play smoothly with up to 200s buffer.
   - **Live Streams** enter a loop: spinner → loads 1 frame → spinner → loads 1 frame.
2. **Live Ads Still Showing:**
   - Despite the Plan B ad-free proxy code (`3d7eaaf5a`), live streams still play Twitch ads.

### 1.2 Non-Negotiable Hardware & Repo Constraints
- **STRICT ES5 ONLY:** Chrome 38 has zero ES6 syntax support. Do **not** use `let`, `const`, arrow functions (`=>`), template literals (`` ` ``), destructuring, default parameters, rest/spread, `for..of`, or classes. One syntax error causes a black screen.
- **No Unguarded ES6+ Runtime APIs:** Do not call `String.prototype.startsWith/includes/endsWith`, `Array.prototype.includes/find/findIndex`, `Object.assign/values/entries`, `fetch`, or `URLSearchParams` bare. Use ES5 equivalents (`indexOf`, `for` loops, etc.).
- **Bridge Sync Mandate:** `webos/bridge/webosCompatBridge.js` and `release/githubio/js/webosCompatBridge.js` **must remain byte-identical** (use `npm run hosted:prepare` to sync and inject).
- **Native Media Stack Constraints:**
  - The TV's native HLS player **cannot** connect to proxy hosts (`as.luminous.dev`, `rte`) directly (`MEDIA_ERR_SRC_NOT_SUPPORTED`). Plan B (attaching a `*.playlist.ttvnw.net` variant extracted from the proxied master body, or routing via local `http://127.0.0.1:8099`) is mandatory.
  - Native MPEG-TS HLS works reliably **only up to `1280x720` (720p)**.
  - Native fMP4 and MSE fMP4 are both dead on this TV; fMP4 must always be transmuxed to MPEG-TS via `tools/tv-serve.js` (`http://127.0.0.1:8099`).

---

## 2. Root-Cause Analysis

### 2.1 Why Live Streams Do "One Frame → Spinner → One Frame" (While VODs Work)

1. **Plan B (`pickFromMaster`) Strips ABR and Picks 1080p60 (`chunked`):**
   - VODs attach a master playlist or run with long static segments (`#EXT-X-ENDLIST`).
   - On live streams, Plan B calls `pickFromMaster()` to extract a single variant URL from the proxied master playlist and assigns that single variant URL to `video.src`.
   - Giving `video.src` a single variant URL **disables native Adaptive Bitrate (ABR)**. Furthermore, if `pickFromMaster()` selects the top variant in the manifest (`1920x1080@60fps`, 6–8 Mbps, High Profile Level 4.2), the 2016 hardware decoder and flaky WiFi cannot sustain real-time playback. It decodes the initial IDR keyframe (1 frame), starves the buffer, shows the loading spinner, fetches the next segment, decodes 1 keyframe, and repeats.
2. **2-Second Live Edge Starvation & `#EXT-X-TWITCH-PREFETCH`:**
   - Twitch live variant playlists use 2.0-second segments (`#EXTINF:2.000,live`) and append two `#EXT-X-TWITCH-PREFETCH:` low-latency URLs at the bottom.
   - The webOS 3.4 GStreamer HLS demuxer starts live playback at the very tip of the playlist (< 2s buffer) and mishandles `#EXT-X-TWITCH-PREFETCH`. With the TV's WiFi jitter, a < 2s buffer underruns immediately after rendering the first frame.
3. **Aggressive Stall Watchdog Resetting `video.src`:**
   - When the 2-second live buffer underruns, `video.readyState` drops to `1` or `2` and fires `waiting` / `stalled`. If the bridge or `Play.js` stall-recovery timer calls `video.load()` or re-attaches `video.src` too quickly on a live stream, it aborts the in-flight segment download, loads the next playlist refresh, renders 1 frame, and resets again in an infinite loop.
4. **Live fMP4 Remux Latency in `tools/tv-serve.js`:**
   - For the ~10–20% of live channels on Twitch's custom fMP4 stack (`#EXT-X-MAP`), if `sttv_serve.js` transmuxes a 1080p60 stream on Node 0.12 or re-downloads the `#EXT-X-MAP` initialization `.mp4` over flaky WiFi without pinning it in memory, every 2s segment misses its deadline.

### 2.2 Why Live Ads Are Still Showing

1. **Luna Service Allowlist / Timeout Rejecting `as.luminous.dev` (`webos/service/hls_service.js`):**
   - Browser XHR is blocked by CORS, so all playlists go through `com.tbsniller.smarttwitchwebostv.hls`.
   - The allowlist in `hls_service.js` was extended for `*.playlist.ttvnw.net` and any HTTPS `*.m3u8`.
   - However, the Tier 1 ad-free proxy URL is `https://as.luminous.dev/live/<channel>?...` — **its path does not end in `.m3u8` and its host is not `ttvnw.net`**. If `hls_service.js` rejects it (or if it times out over flaky WiFi), Tier 1 (`luminous`) fails, Tier 2 (`rte`) 404s, and Tier 3 (`direct` `usher.ttvnw.net`) succeeds — serving an unproxied master playlist with full ads.
2. **`sourceFromQuality()` Bypassing Plan B When Quality or Bitrate Caps Apply:**
   - Currently, `sourceFromQuality()` only triggers `pickFromMaster()` when `isAdfreeProxyUrl(uri)` is true **and** no explicit quality pick or `SetMainPlayerBitrate` cap is active.
   - If `Play.js` passes the original `usher.ttvnw.net` URL into `sourceFromQuality()`, or if `SetMainPlayerBitrate` / quality selection is active, `sourceFromQuality()` bypasses the proxied master and attaches the direct ad-laden variant.
3. **Mid-Roll Server-Side Ad Insertion (`stitched-ad`) in Variant Playlists:**
   - Even if the initial master playlist is fetched via `as.luminous.dev`, Plan B hands a raw `*.playlist.ttvnw.net` variant URL to `video.src`.
   - When the TV's native player polls `*.playlist.ttvnw.net` directly for mid-stream playlist updates, Twitch can stitch `#EXT-X-DATERANGE:ID="stitched-ad-..."` (`CLASS="twitch-stitched-ad"`) segments into the variant `.m3u8`. Routing live variant playlists through `sttv_serve.js` allows stripping both `#EXT-X-TWITCH-PREFETCH` and `stitched-ad` segments before the native player sees them.

---

## 3. Step 1: On-Device Diagnostic Baseline (Run Before Editing)

Use the CDP helper (`C:\Users\alkpe\AppData\Local\Temp\opencode\tvcdp.js`) and SSH (`root@192.168.1.105`, password `alpine`) while launching a live stream inside the wrapper app:

### 3.1 Capture CDP Console Logs During Live Stream Launch
```bash
node tvcdp.js console 30
```
Check the output for these exact markers:
- `adfree_proxy_success tier:luminous` — If missing or showing `tier:direct`, `hls_service.js` or timeout is blocking the proxy.
- `main_source_selected {uri, proxyMaster, variantAttach}` — Verify whether `proxyMaster: true` and `variantAttach: true`, and inspect the selected `uri`.
- `main_video_error` — Check if native attach fails first and triggers a fallback.

### 3.2 Inspect `<video>` Element State During the "1 Frame → Spinner" Loop
```bash
node tvcdp.js eval "(function(){var v=document.querySelector('video');return v?JSON.stringify({src:v.src,w:v.videoWidth,h:v.videoHeight,rs:v.readyState,ns:v.networkState,ct:v.currentTime,paused:v.paused,buf:v.buffered&&v.buffered.length?v.buffered.end(v.buffered.length-1)-v.currentTime:0,err:v.error?v.error.code:null}):'no video';})()"
```
- If `w: 1920, h: 1080`, `pickFromMaster()` selected an uncapped 1080p60 stream that overwhelms the webOS 3.4 decoder/WiFi.
- If `buf` stays `< 1.5` and `rs` oscillates between `1`/`2` and `4`, live-edge starvation (`#EXT-X-TWITCH-PREFETCH`) or a stall reset loop is occurring.

---

## 4. Step 2: Code Fixes to Implement (Strictly ES5)

### Fix A: `webos/service/hls_service.js` — Allowlist Proxy Hosts & Harden Timeout

1. Inspect `webos/service/hls_service.js`.
2. Locate the URL allowlist validation function. Ensure it explicitly allows `as.luminous.dev`, `*.luminous.dev`, and fallback proxy hosts even when the URL path is `/live/<channel>` (no `.m3u8` extension).
3. Ensure the HTTPS request to `as.luminous.dev` sends a clean `User-Agent` (e.g. `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`), omits `Origin`/`Referer` headers that trigger 403s, and allows at least an `8000ms` timeout + 1 retry on network error to survive TV WiFi jitter.

```javascript
// ES5-compliant allowlist check for webos/service/hls_service.js
function isAllowedPlaylistUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return false;
    }
    if (rawUrl.indexOf('https://') !== 0 && rawUrl.indexOf('http://127.0.0.1:') !== 0) {
        return false;
    }
    var hostMatch = rawUrl.match(/^https?:\/\/([^\/:?#]+)/i);
    var host = hostMatch ? hostMatch[1].toLowerCase() : '';

    if (
        host === 'usher.ttvnw.net' ||
        host.indexOf('.ttvnw.net') !== -1 ||
        host === 'as.luminous.dev' ||
        host.indexOf('.luminous.dev') !== -1 ||
        host.indexOf('.r.tedd.dev') !== -1 ||
        host.indexOf('perfprod.com') !== -1
    ) {
        return true;
    }

    return rawUrl.indexOf('.m3u8') !== -1;
}
```

---

### Fix B: `webos/bridge/webosCompatBridge.js` — Cap `pickFromMaster()` at 720p, Preserve Proxy State, and Prevent Live Stall Reset Loops

1. **Cap `pickFromMaster()` to `1280x720` and `<= 3500000` bps:**
   - Never allow `pickFromMaster()` to select `1920x1080` (`chunked` 1080p60) on webOS 3.4.3.
   - Accept an optional `maxBitrateCap` parameter so `SetMainPlayerBitrate` works with Plan B instead of bypassing it.

```javascript
// ES5-compliant pickFromMaster in webos/bridge/webosCompatBridge.js
var WEBOS34_MAX_LIVE_WIDTH = 1280;
var WEBOS34_MAX_LIVE_HEIGHT = 720;
var WEBOS34_MAX_LIVE_BANDWIDTH = 3500000; // 3.5 Mbps ceiling for webOS 3.4 + flaky WiFi

function pickFromMaster(masterText, maxBitrateCap) {
    if (!masterText || typeof masterText !== 'string') {
        return null;
    }
    var effectiveMaxBw = WEBOS34_MAX_LIVE_BANDWIDTH;
    if (typeof maxBitrateCap === 'number' && maxBitrateCap > 0 && maxBitrateCap < effectiveMaxBw) {
        effectiveMaxBw = maxBitrateCap;
    }

    var lines = masterText.split(/\r?\n/);
    var variants = [];
    var i, line, nextLine, bwMatch, resMatch, fpsMatch, nameMatch;
    var bw, width, height, fps, isAudioOnly;

    for (i = 0; i < lines.length; i++) {
        line = lines[i] ? lines[i].replace(/^\s+|\s+$/g, '') : '';
        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
            bwMatch = line.match(/BANDWIDTH=(\d+)/i);
            resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
            fpsMatch = line.match(/FRAME-RATE=([\d.]+)/i);
            nameMatch = line.match(/VIDEO="([^"]+)"/i);

            bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            width = resMatch ? parseInt(resMatch[1], 10) : 0;
            height = resMatch ? parseInt(resMatch[2], 10) : 0;
            fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
            isAudioOnly = (nameMatch && nameMatch[1].toLowerCase().indexOf('audio') !== -1);

            nextLine = '';
            while (i + 1 < lines.length) {
                i++;
                nextLine = lines[i] ? lines[i].replace(/^\s+|\s+$/g, '') : '';
                if (nextLine && nextLine.indexOf('#') !== 0) {
                    break;
                }
            }
            if (nextLine && nextLine.indexOf('http') === 0 && !isAudioOnly) {
                variants.push({
                    uri: nextLine,
                    bandwidth: bw,
                    width: width,
                    height: height,
                    fps: fps
                });
            }
        }
    }

    if (variants.length === 0) {
        return null;
    }

    // Filter variants to <= 1280x720 and <= effectiveMaxBw
    var eligible = [];
    for (i = 0; i < variants.length; i++) {
        var v = variants[i];
        var resOk = (v.width === 0 && v.height === 0) ||
                    (v.width <= WEBOS34_MAX_LIVE_WIDTH && v.height <= WEBOS34_MAX_LIVE_HEIGHT);
        var bwOk = (v.bandwidth === 0) || (v.bandwidth <= effectiveMaxBw);
        if (resOk && bwOk) {
            eligible.push(v);
        }
    }

    if (eligible.length > 0) {
        // Prefer 30fps over 60fps at 720p if available to reduce decode pressure, otherwise highest eligible bandwidth
        eligible.sort(function(a, b) {
            if (a.height === b.height && a.fps && b.fps && a.fps !== b.fps) {
                if (a.fps <= 31 && b.fps > 31) return -1;
                if (b.fps <= 31 && a.fps > 31) return 1;
            }
            return b.bandwidth - a.bandwidth;
        });
        return eligible[0].uri;
    }

    // Fallback: lowest bandwidth variant
    variants.sort(function(a, b) {
        return a.bandwidth - b.bandwidth;
    });
    return variants[0].uri;
}
```

2. **Preserve Proxy Master State in `sourceFromQuality()`:**
   - When `attemptAdfreeProxyChain()` succeeds with `tier:luminous` (or `rte`), store `lastProxiedMasterBody` and `lastProxiedChannel` in the bridge state.
   - In `sourceFromQuality()`, if the live stream was fetched via the ad-free proxy (even if `Play.js` passes the original `usher.ttvnw.net` URL or a `SetMainPlayerBitrate` cap is active), still extract the variant from `lastProxiedMasterBody` using `pickFromMaster(lastProxiedMasterBody, mainPlayerBitrateCap)` so Plan B is never silently bypassed.
3. **Prevent Live-Edge Stall Re-Attach Loops:**
   - Check any `waiting` / `stalled` / watchdog timers in `webosCompatBridge.js` (and `app/specific/Play.js` if applicable).
   - Ensure the bridge does **not** call `video.load()` or re-assign `video.src` on transient live buffer underruns under 12–15 seconds, as resetting `video.src` on every 2-second segment jitter causes the "1 frame → spinner → 1 frame" cycle.

---

### Fix C: `tools/tv-serve.js` — Sanitize Live Playlists (Strip `#EXT-X-TWITCH-PREFETCH` & Mid-Roll `stitched-ad`) and Pin `#EXT-X-MAP` Init Segments

Because `sttv_serve.js` (`http://127.0.0.1:8099`) runs locally whenever SmartTwitch is open and the TV's native player plays `http://127.0.0.1:8099/hls/...` without CORS or `MEDIA_ERR_SRC_NOT_SUPPORTED`:

1. **Route Live Variant Playlists Through `sttv_serve.js` (or sanitize in `/hls/var.m3u8` and `/hls/master.m3u8`):**
   - In `tools/tv-serve.js`, filter `/hls/master.m3u8` so `1920x1080` variants are stripped, leaving `720p`, `480p`, `360p`, and `160p`. This restores full **native ABR** on live streams!
   - In `/hls/var.m3u8`, sanitize the playlist text before returning it to the TV's native HLS player:
     - **Strip `#EXT-X-TWITCH-PREFETCH:` lines** so the webOS 3.4 GStreamer HLS client buffers 3 standard segments (~6 seconds) instead of starving at a 1-frame low-latency edge.
     - **Strip `#EXT-X-DATERANGE` ad markers and `stitched-ad` / `Amazon` ad segments** so mid-roll ads are skipped seamlessly.
2. **Pin `#EXT-X-MAP` Init Segments in Memory:**
   - Keep a dedicated `initSegmentCache` map in `tools/tv-serve.js` so live fMP4 channels never re-fetch the init `.mp4` over flaky WiFi on every 2s segment.

```javascript
// ES5 / Node 0.12 compatible helpers for tools/tv-serve.js

var initSegmentCache = {}; // Dedicated cache for #EXT-X-MAP initialization segments

function filterMasterPlaylistTo720p(masterText) {
    if (!masterText || typeof masterText !== 'string') {
        return masterText;
    }
    var lines = masterText.split(/\r?\n/);
    var out = [];
    var i, line, resMatch, bwMatch, width, height, bw;
    var keptVariants = 0;

    for (i = 0; i < lines.length; i++) {
        line = lines[i];
        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
            resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
            bwMatch = line.match(/BANDWIDTH=(\d+)/i);
            width = resMatch ? parseInt(resMatch[1], 10) : 0;
            height = resMatch ? parseInt(resMatch[2], 10) : 0;
            bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;

            // Skip 1080p+ variants (> 1280x720 or > 4.2 Mbps)
            if ((width > 1280 || height > 720 || bw > 4200000) && i + 1 < lines.length) {
                i++; // Also skip the variant URI line
                continue;
            }
            keptVariants++;
        }
        out.push(line);
    }

    // If all variants were somehow filtered out, return original masterText
    return keptVariants > 0 ? out.join('\n') : masterText;
}

function sanitizeLiveVariantPlaylist(m3u8Text) {
    if (!m3u8Text || typeof m3u8Text !== 'string') {
        return m3u8Text;
    }
    var lines = m3u8Text.split(/\r?\n/);
    var out = [];
    var skipNextSegment = false;
    var i, line;

    for (i = 0; i < lines.length; i++) {
        line = lines[i];

        // 1. Strip #EXT-X-TWITCH-PREFETCH to prevent webOS 3.4 1-frame low-latency buffer starvation
        if (line.indexOf('#EXT-X-TWITCH-PREFETCH:') === 0) {
            continue;
        }

        // 2. Strip Twitch SSAI stitched-ad daterange metadata
        if (
            line.indexOf('#EXT-X-DATERANGE:') === 0 &&
            (line.indexOf('stitched-ad') !== -1 ||
             line.indexOf('twitch-stitched-ad') !== -1 ||
             line.indexOf('Amazon') !== -1)
        ) {
            continue;
        }

        // 3. Skip ad-stitched #EXTINF segments (e.g. #EXTINF:2.000,Amazon|...)
        if (line.indexOf('#EXTINF:') === 0) {
            if (line.indexOf(',live') === -1 &&
                (line.indexOf('Amazon') !== -1 || line.indexOf('stitched-ad') !== -1)) {
                skipNextSegment = true;
                continue;
            }
        }

        if (skipNextSegment) {
            if (line && line.indexOf('#') !== 0) {
                skipNextSegment = false;
            }
            continue;
        }

        out.push(line);
    }

    return out.join('\n');
}
```

---

## 5. Step 3: Mandatory Quality Gates & Deployment

After editing the files, run all verification gates in order before deploying or committing:

### 5.1 Sync Hosted Release & Run Chrome 38 Gates
```bash
npm run hosted:prepare              # Copies webos/bridge/webosCompatBridge.js -> release/githubio/js/webosCompatBridge.js
npm run lint                        # JSHint check on app/ and webos bridge
node tools/chrome38-audit.js        # MUST PASS with 0 non-ES5 syntax errors
node tools/chrome38-apiscan.js      # Verify no new unguarded post-Chrome-38 runtime APIs
```

### 5.2 Deploy Updated Files to the TV
1. **Copy `tools/tv-serve.js` to the TV:**
   ```bash
   scp -P 22 tools/tv-serve.js root@192.168.1.105:/media/developer/sttv_stage/sttv_serve.js
   ```
2. **If `webos/service/hls_service.js` was modified, update the installed Luna service on the TV (or rebuild and install the IPK):**
   ```bash
   scp -P 22 webos/service/hls_service.js root@192.168.1.105:/media/developer/apps/usr/palm/services/com.tbsniller.smarttwitchwebostv.hls/hls_service.js
   ```
3. **Commit and push `release/` (or point the wrapper `params.target` to a local dev server) so the TV loads the new `webosCompatBridge.js`.**

### 5.3 On-Device Acceptance Verification
Launch a live stream inside the SmartTwitch wrapper on the TV and verify via `node tvcdp.js`:
1. `adfree_proxy_success tier:luminous` is logged in CDP console.
2. `main_source_selected` logs `proxyMaster: true` and attaches a variant `<= 1280x720`.
3. Sample `video.currentTime`, `video.readyState`, and `video.videoHeight` every 5 seconds over 2 minutes:
   - `videoHeight` must be `<= 720`.
   - `readyState` must hold steady at `4` (`HAVE_ENOUGH_DATA`).
   - `currentTime` must advance continuously (0s → 60s+) with zero 1-frame spinner loops and zero ads.
4. Re-verify a known fMP4 VOD (e.g. Pisty VOD `2919603413`) to confirm no regression in VOD playback.