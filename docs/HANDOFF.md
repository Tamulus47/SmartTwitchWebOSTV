# Handoff — SmartTwitchWebOSTV on the LG webOS 3.4.3 TV

> Everything a new person needs to know: what the TV is and is not capable of, how the app is
> put together, what has already been solved, what is still broken, and how to get into the
> device.
>
> Last updated: **2026-11-10**. Repo HEAD `2b26ee5a6` (master, pushed), plus one uncommitted
> edit to `docs/CHROME38.md` (Boot section rewrite).

---

## 0. TL;DR — where we are

| Area | State |
| --- | --- |
| VOD playback (incl. fMP4/Pisty) | ✅ Fully working |
| Live playback (MPEG-TS channels) | ⚠️ Works, but intermittently rebuffers: one frame → load → one frame |
| Live ads | ❌ Still showing — the ad-free proxy is not taking effect on live |
| Boot: SmartTwitch auto-launching | ✅ Fixed (persistent activity #111 cancelled) |
| Boot: SSH/telnet auto-start | ❌ **Not reliable** — usually requires opening Homebrew Channel manually |
| Root password login | ✅ Works (`root` / `alpine`), but only after `startup.sh` has run once |
| Chrome 38 / ES5 compatibility | ✅ Gate green |
| Proxy Plan B code | ✅ Shipped in `3d7eaaf5a` / docs `2b26ee5a6`, gates green |

**The single biggest environmental problem:** the TV's WiFi is very flaky (6+ dropouts and
reboots in one day, plus a ~50 minute outage). It self-recovers, but any verification run must
tolerate losing SSH mid-test.

---

## 1. The TV

### 1.1 Identity

| Property | Value |
| --- | --- |
| Model | **LG 43LH602V-TD** (43", 2016 model year) |
| OS | webOS **3.4.3** |
| Browser | Chromium **Chrome/38.0.2125.122**, V8 3.28, WebKit 537.36 |
| User agent | `LG Browser/8.00.00 (webOS.TV-2016), _TV_O18/05.70.50 (LG, 43…)` |
| Language/locale | Greek (EET timezone) |
| Root | ✅ rooted (RootMyTV chain) + Homebrew Channel **0.7.3** (0.6.3 backup: `/media/developer/hb_backup_063.tgz`) |
| Address | `192.168.1.105` |
| Remote debugging | CDP on **port 9998** (Chrome 38 protocol) |

### 1.2 JavaScript capability (the hard constraint)

**ES5 only.** Chrome 38 has *no ES6 syntax support at all*:

- One backtick template literal anywhere in a script = whole file fails to parse
  (`SyntaxError: Unexpected token ILLEGAL`) = **black screen**, `Main_Start()` never runs.
- No arrow functions, `let`/`const` block semantics, classes, destructuring, spread,
  `Symbol`, generators in shipped syntax.

Missing **runtime** APIs (must be feature-detected/polyfilled, never called bare):

| API | Available from |
| --- | --- |
| `String.startsWith/includes/endsWith/repeat/padStart/padEnd` | Chrome 41+ |
| `Array.includes/find/findIndex` | 45/47+ |
| `Object.assign` / `Object.values/entries` | 45+ / 54+ |
| `Element.closest` | 41+ |
| `NodeList.forEach` | 51+ |
| `URLSearchParams` | 49+ |
| `window.fetch` | 42+ |

Polyfills are installed by the bridge at parse time, *before* `main.js` executes
(`installLegacyRuntimePolyfills()` in `webos/bridge/webosCompatBridge.js`). The bridge
`<script>` tag is injected ahead of `main.js` by `tools/upstream/prepareHostedRelease.js`.

### 1.3 Filesystem / what you may write

| Path | Writable? | Notes |
| --- | --- | --- |
| `/` (rootfs) | ❌ read-only overlay | `/etc/init`, `/etc/inittab`, `/usr` all read-only |
| `/var` | ✅ ext4 on `/dev/mmcblk0p51` | DB8, Luna prefs, ls2 state |
| `/media/developer` | ✅ | Installed apps + services live here |
| `/tmp` | ✅ tmpfs | Boot markers, logs, bind-mount sources |
| `/var/lib/webosbrew` | ✅ | `startup.sh`, `init.d/`, `sshd/` host keys |

Consequences:
- **No cron.**
- **`/etc/init` cannot be modified** (upstart job files are read-only), so no new boot service.
- `/etc/init.d` does **not** exist as a hook point.
- The only initscript mechanism is `/var/lib/webosbrew/init.d/`, which is `run-parts`-ed **only
  from `startup.sh`** — chicken-and-egg: it runs only after something already kicked
  `startup.sh`.

### 1.4 Root & privilege

- Root shell: `ssh -p 22 root@192.168.1.105`, password **`alpine`** (hash `xGVw8H4GqkKg6`).
- The password is installed by **`/var/lib/webosbrew/init.d/90_root_password_bind`**, which
  writes a fixed `/etc/shadow` over the real one with a bind mount. It must re-run every boot
  (the real shadow does not persist the password).
- `startup.sh` itself only sets the password if `/home/root/.ssh/authorized_keys` is
  **absent** — because we *have* an authorized key, the init.d hook is the thing that keeps
  password login alive.
- The Homebrew JS service self-elevates via `elevate-service` (a node script that patches the
  LS2 service file to use the local `run-js-service` wrapper, which disables
  `thirdparty_jail` and the devmode check). **That elevation is only executed from
  `startup.sh`**, so before `startup.sh` runs the service may not be root.

### 1.5 Network

- **Very flaky WiFi.** 6+ dropouts/reboots in a single day; one outage lasted ~50 minutes.
  Symptom: `connect ETIMEDOUT` on port 22, ping fails, then it self-recovers.
- Port **3000** is open but is a stub (`GET /` → `Hello world`, everything else hangs). Not a
  control channel — do not waste time on it.
- The flakiness is also a *playback* problem: the remux server was hardened specifically
  because WiFi drops cause `ENETUNREACH`/timeouts that kill live playback.

### 1.6 Boot timeline (from `/var/log/bootd.log`)

| Signal | Seconds after boot |
| --- | --- |
| `core-boot-done` | **25.4 – 25.8** |
| `init-boot-done` | 32.3 |
| `minimal-boot-done` | 37.9 |
| `rest-boot-done` | 65.2 |
| `boot-done` | **75.2** |

`core-boot-done` is very early — the Homebrew service is generally *not* usable yet at that
point, which is the root cause of the lost single-shot boot kick.

### 1.7 Luna / activitymanager / DB8 quirks (all found by trial and error)

**activitymanager `create`:**
- `start: true` **and** a `callback` are mandatory unless `subscribe: true` is given —
  otherwise `errorCode:22 "Created Activity must specify \"start\" and a Callback if not
  subscribed"`.
- If `type.foreground` is present it **must** be `true` — `errorCode:12`.
- `schedule.interval` only accepts: `1d … 12h, 6h, 3h, 1h, 20m, 30m, 15m, 10m, 5m`.
  No seconds, no `2m`.
- Creating an activity **as the shell identity** whose callback belongs to a different service
  fails: `errorCode:13 "Activity creator doesn't have rights to call its callback"`.
  Workaround: impersonate with `luna-send -a <serviceId>`.
- An activity whose trigger is already satisfied **fires immediately at creation**, runs its
  callback, and **leaves the list** (it does not stay armed for the next boot).

**Reading DB8:**
- Only `luna-send -a com.palm.activitymanager` may query `com.palm.activity:1`
  (other identities → `db: permission denied`).
- Allowed: `{"query":{"from":"com.palm.activity:1"}}` → **hard-capped at 5 results**.
- Rejected: `skip`, `sort`, `count`, `where` on `activityId`/`name` (→ `no index for query`),
  `limit > ~50` (→ `invalid type`).
- ⚠️ **`strings /var/db/main/*.ldb | grep …` is NOT reliable evidence that a record is alive** —
  LevelDB keeps stale bytes until compaction. This produced a false "it's persisted!" conclusion
  once.

**Other:**
- `luna-send` output is JSON but quoting through SSH/PowerShell mangles it; write the payload
  to a file on the TV and do `luna-send … "$(cat /tmp/q.json)"`.

---

## 2. Getting into the TV

### 2.1 SSH

```powershell
ssh -p 22 root@192.168.1.105          # password: alpine
ssh -i "$env:TEMP\tvkey" root@192.168.1.105   # key auth (Git/OpenSSH)
```

- Windows OpenSSH **9.5p1** at `C:\Windows\System32\OpenSSH\ssh.exe`, on system PATH.
- Key file: `C:\Users\alkpe\AppData\Local\Temp\opencode\tvkey`.

### 2.2 ⚠️ The bootstrap catch-22

SSH (`dropbear`) and telnet are started **only** by `/var/lib/webosbrew/startup.sh`, which is
invoked by `luna://org.webosbrew.hbchannel.service/autostart`. Nothing else starts it at boot.

So **after every reboot, SSH is down until one of these happens**:

1. You open the **Homebrew Channel** app from the apps menu (its UI kicks `autostart`), or
2. You open the **SmartTwitch** app (the wrapper kicks `autostart` on every manual launch —
   `kickHomebrewStartup()` in `webos/app/index.js`), or
3. The persistent boot activity fires (see §4 — currently unreliable).

If you have no SSH and no app is open, the only way in is physically opening an app.
`CDP` (port 9998) may still be reachable independently, but the YouTube page context has **no
`PalmServiceBridge`**, so you cannot make Luna calls from it.

### 2.3 MCP SSH server (OpenCode)

Configured in `C:\Users\alkpe\.config\opencode\opencode.jsonc`:

```
npx -y @fangjunjie/ssh-mcp-server --host 192.168.1.105 --port 22 --username root --password alpine
```

Exposes the `tv` MCP namespace, e.g. `tools.tv["execute-command"]({cmdString, timeout})`.

### 2.4 CDP (no root needed)

```
http://192.168.1.105:9998/json          # target list
http://192.168.1.105:9998/json/version
```

Helper: `C:\Users\alkpe\AppData\Local\Temp\opencode\tvcdp.js`

```bash
node tvcdp.js list
node tvcdp.js eval "<es5 expression>"
node tvcdp.js nav "<url>"
node tvcdp.js console 30          # stream console for 30s
```

Older Python 2 helpers (`cdp_eval.py`, `cdp_eval_sttv.py`, `cdp_console.py`, …) in the same
folder are written for **`HOST = 127.0.0.1`** — they were meant to run *on the TV*. To use them
from Windows, change `HOST` to the TV IP and port stays 9998.

---

## 3. How the app works

### 3.1 Repository & hosting

| Item | Value |
| --- | --- |
| Repo | `https://github.com/Tamulus47/SmartTwitchWebOSTV`, branch `master` |
| HEAD | `2b26ee5a6` |
| Hosted app | `https://tamulus47.github.io/SmartTwitchWebOSTV/release/index.html` (GitHub Pages, built from committed `release/`) |
| Launch URL | `…/release/index.html?sttv_webos_launch=<Date.now()>` |
| Local checkout | `C:\Users\alkpe\AppData\Local\Temp\opencode\SmartTwitchWebOSTV` |

### 3.2 The pieces

| Component | File(s) | Role |
| --- | --- | --- |
| **Wrapper** | `webos/app/index.js` | The installed native-ish app window. Parses launch params, kicks the Homebrew startup script, starts `sttv_serve`, then navigates the window to the hosted URL. |
| **Hosted app** | `release/` (from `app/` via `npm run hosted:prepare`) | The actual SmartTwitch UI/player, served from GitHub Pages. |
| **Compat bridge** | `webos/bridge/webosCompatBridge.js` → `release/githubio/js/webosCompatBridge.js` | ES5 polyfills, playlist-fetch fallback, ad-free proxy chain, remux attach, `window.Android` API shape. **The two copies must stay byte-identical.** |
| **Luna HLS service** | `webos/service/hls_service.js` (`com.tbsniller.smarttwitchwebostv.hls`) | The only working way to fetch playlists — the browser is blocked by CORS (§5.1). |
| **Remux server** | `tools/tv-serve.js` → TV `/media/developer/sttv_stage/sttv_serve.js`, port **8099** | Transmuxes fMP4 → MPEG-TS in-process (own ISO-BMFF parser + TS muxer for node 0.12/ES5). |
| **Homebrew service** | `/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/service.js` (minified) | Provides `autostart` (runs `startup.sh`) and `hb exec` (root command execution, used to spawn `sttv_serve`). |

### 3.3 Playback data flow

```
App boot
  └─ bridge bootstraps → warmUsherPlaylistService() (pre-spawn luna HLS service)
  └─ ensureSttvServe() → hb exec → node sttv_serve.js 8099   (only while the app is open)

Master playlist fetch (usher.ttvnw.net)
  ├─ page XHR  → always fails (status 0 / 403 — no CORS, Origin rejected)
  └─ luna service com.tbsniller.smarttwitchwebostv.hls  ✅ the working path
        └─ LIVE only: attemptAdfreeProxyChain()
             luminous bare template → rte prefix proxies → direct (last tier)

Variant selection
  └─ sourceFromQuality()
       ├─ ad-free proxy master? → Plan B: pickFromMaster() returns a *.playlist.ttvnw.net
       │                          variant from the proxied body (native-playable) ✅
       └─ else direct variant

Format probe (per-variant)
  ├─ MPEG-TS  → attach natively ✅ (works flawlessly, ABR up to 1280x720)
  └─ fMP4     → startRemuxNative(): health-check http://127.0.0.1:8099/health
                  ├─ OK    → video.src = http://127.0.0.1:8099/hls/master.m3u8?u=<orig> ✅
                  └─ fails → MSE path → fails → error dialog
```

### 3.4 Kill switches / debug flags

| Flag | Effect |
| --- | --- |
| `?sttv_adfree_proxy=0` or `localStorage STTV_ADFREE_PROXY=0` | Disable the ad-free live proxy chain |
| `localStorage STTV_DEBUG=1` | Verbose debug logging |
| `?sttv_webos_launch=<ts>` | Normal manual launch token |
| `?sttv_boot_kick=1` | Boot kick path (**dormant** — activity #111 cancelled) |
| `params.target` | Override the hosted target URL (dev server, `/tmp/tv_launch.sh`) |

### 3.5 Key debug log markers

`service_ok`, `main_playlist_parsed`, `adfree_proxy_success tier:<name>`,
`main_source_selected {uri, proxyMaster, variantAttach}`, `main_video_error`,
`mse_probe_ts segs:N`, `usher_hls_service_retry`, `boot_kick_via_event`,
`launch_navigate`, `launch_skip_committed`.

---

## 4. Boot behaviour — current state (unresolved)

### 4.1 What was broken and is now fixed

A persistent activity **`com.tbsniller.smarttwitchwebostv.boot` (activityId 111)**, created
during earlier SSH-bootstrap work, fired on `core-boot-done` every boot and launched the
wrapper with `sttv_boot_kick: 1`. That produced the user-visible symptom:

> "it's not really start with each boot it's like show the open page with its logo then return
> to the TV channels"

**Fix:** cancelled it —
`luna-send -n 1 luna://com.palm.activitymanager/cancel '{"activityId":111}'`
Verified: `grep -ac 'NL_APP_LAUNCH_BEGIN.*smarttwitchwebostv' /var/log/messages` → `0` across a
full reboot. Nothing re-creates it (the creation is not scripted anywhere in the repo).

The wrapper's `sttv_boot_kick` branch in `webos/app/index.js` is now **dormant** and kept only
as an inert fallback.

### 4.2 What is still broken: SSH does not auto-start

**Requirement:** dropbear + telnetd start at every boot with **no app window**, and SmartTwitch
must never auto-launch.

**Attempted design:** persistent activity `org.webosbrew.hbchannel.service.autostart` created as
the Homebrew service identity (`luna-send -a org.webosbrew.hbchannel.service …/create`) with

- `type: {foreground: true, persist: true, continuous: true}`
- `trigger`: `palm://com.webos.bootManager/getBootStatus`, `subscribe: true`,
  `where: {prop:["signals","core-boot-done"], op:"=", val:true}`
- `schedule: {interval: "5m", local: true}`
- `callback`: `palm://org.webosbrew.hbchannel.service/autostart`
- `start: true, replace: true`

**Measured results:**

| Boot | Result |
| --- | --- |
| Boot A (2026-11-08 16:03) | marker written at **boot+320 s** (i.e. the 5-minute schedule tick, *not* the 25.4 s trigger); SSH + telnet up, no app window ✅ |
| Boot B (2026-11-08 16:27) | **nothing fired for 87 minutes** — user had to open Homebrew manually ❌ |

**Conclusion:** the activity fires **once** (the first boot after creation) and then completes
and is destroyed; `persist/continuous` did **not** re-arm it. The apparent proof that it was
"persisted in db8" was a **false positive** from reading stale LevelDB bytes (see §1.7).

**This is the open problem.** Candidates for the next attempt:

1. Find a *real* re-arming mechanism (e.g. have the callback re-create the activity as its last
   step — the callback is `startup.sh`, which we can extend via `/var/lib/webosbrew/init.d/`,
   but re-creating an activity needs a Luna call from a context with rights).
2. Determine whether the 25.4 s trigger failure is a *root* race — if `elevate-service`'s LS2
   patch persists across boots the service should already be root, in which case the trigger
   simply is not being delivered. Needs a first-hand check of the LS2 `.service` file (we could
   not locate it: `/var/palm/ls2/services/pub/` is empty and `find` found nothing — service
   registration must live elsewhere).
3. Stagger several activities across `init/minimal/rest/boot-done` (32 s / 38 s / 65 s / 75 s)
   so that whichever lands after the service is usable wins; all callbacks are idempotent.
4. Give up on activitymanager and find another boot hook — but note the constraints in §1.3
   (read-only rootfs, no cron, `init.d` only runs from `startup.sh`).

**Do not lose access:** before rebooting to test, confirm you still have a way in (open
Homebrew once after the test if needed).

---

## 5. Playback: what is solved

### 5.1 Playlist fetching — solved via Luna service

No playlist host sends CORS for our origin, so browser XHR is dead:

- `usher.ttvnw.net` → status 0
- `playlist.ttvnw.net` → 403 (rejects browser `Origin`)

Only the packaged luna JS service `com.tbsniller.smarttwitchwebostv.hls` can fetch them.
Bridge fixes: `serviceAttempted && !synthetic` guard (the doomed XHR's late status-0 event used
to complete the request first → empty playlist → black screen), `USHER_PLAYLIST_SERVICE_COLD_GRACE_MS`
cold-start grace + `warmUsherPlaylistService()` pre-spawn, one retry on timeout
(`usher_hls_service_retry`), and an allowlist extension for `*.playlist.ttvnw.net` and any
https `*.m3u8`.

⚠️ `mse_probe_fail service_unavailable` appears whenever the page runs **outside** the app
wrapper (no `PalmSystem` → wrong `<id>.hls` service name). Always verify inside the wrapper.

### 5.2 fMP4 → local TS remux — solved

Channels on a custom transcode stack (`TRANSCODESTACK="Custom:…"`, ~10–20% of live streams,
including Pisty, plus their VODs) serve fMP4 (`#EXT-X-MAP`, `.mp4`).

**Every fMP4 decode path on this TV is dead** (all verified on-device):

| Path | Behavior |
| --- | --- |
| Native HLS on an fMP4 playlist | Demuxes (duration + buffered grow) but never decodes a frame: `videoWidth=0`, `readyState` stuck at 1 |
| MSE (bridge player) | Ingests init + media, emits zero buffered samples, dies `MEDIA_ERR_SRC_NOT_SUPPORTED` at the init append |
| Progressive MP4 of the same codec (clips) | Works — the decoder itself is fine |
| **MPEG-TS native HLS** | **Works flawlessly**, ABR up to 1280x720 |

So the app stops asking the browser to decode fMP4: `tools/tv-serve.js` transmuxes fMP4→TS and
serves a local HLS playlist (`/hls/master.m3u8?u=<original>`, variants → `/hls/var.m3u8?u=…`,
segments → `/hls/seg.ts?u=…&m=…`, `EXT-X-MAP` dropped). Server hardening: one retry per
upstream fetch (WiFi), last-good playlist cache + 1s background refresh, out-of-bounds sample
tolerance (ad-inserted segments skipped instead of failing), LRU segment cache, request log at
`/tmp/httpd.log`.

Deployment: copy `tools/tv-serve.js` → `/media/developer/sttv_stage/sttv_serve.js`.
**Lifecycle:** starts only on a manual app open, stops ~90 s after the app closes (bridge
`pagehide`/`beforeunload` → `pkill`, plus a `/health` heartbeat every 10 s with a 90 s
no-request timeout).

Validation: Pisty VOD `2919603413` transmuxes and plays continuously
(`readyState=4`, `currentTime` 0→47 s+, buffered →200 s, no stalls). Re-verified with the Plan
B build (`3d7eaaf5a`).

### 5.3 Ad-free live proxy — code shipped, effect not observed (see §6)

Chain ported from `adamff-dev/twitch-adfree-webos` (`patch_usher_xhr.js`): luminous bare
template `https://as.luminous.dev/live/<channel>` (original query params merged, template wins)
→ rte prefix proxies → direct request as last tier. Only **live masters** are proxied; VOD/clip
keep the direct flow.

- **Plan A (attach the proxy URL natively) is dead on this TV:** the media stack cannot fetch
  `as.luminous.dev`/rte hosts → `MEDIA_ERR_SRC_NOT_SUPPORTED` (error 4), even though page and
  service XHR to those hosts work fine.
- **Plan B (shipped, `3d7eaaf5a`):** `sourceFromQuality()` detects an ad-free proxy URI
  (`isAdfreeProxyUrl`) and — when no explicit quality pick or `SetMainPlayerBitrate` cap
  applies — returns a variant picked from the proxied master body (`pickFromMaster`) instead of
  the proxy URL. Body comes from the proxy (ad-free property preserved), attach URL stays in the
  natively-playable `*.playlist.ttvnw.net` family. Falls back to the raw proxy URI when no
  usable variant exists. `attachNativeMain()` also clears stale `crossorigin="anonymous"` for
  non-REMUX URIs (ttvnw 403s any foreign `Origin`).

Verified 2026-11-07: `adfree_proxy_success tier:luminous` → `main_playlist_parsed` →
`main_source_selected … proxyMaster:true variantAttach:true` → live plays for minutes,
`Android.SetQuality(1)` switches cleanly.

Known non-blockers: the rte prefix tier currently 404s (fallback only).

---

## 6. Current open issues (as of 2026-11-10)

Reported by the user:

> "VODs fully working well, while live streams sometimes work and sometimes keep loading until
> one frame and show it and keep loading again until show another frame and so, while the ads
> still showing in live streams."

### 6.1 Live ads still showing

Hypotheses to test, in order:

1. The proxy chain is not being attempted at all for this stream (flag off, or the master URL
   doesn't match `isAdfreeProxyUrl`).
2. The chain fails (`adfree_proxy_success` never logged) → falls back to the **direct** master →
   origin ads.
3. Plan B picks a variant but the proxied body has no usable variant → raw proxy URI →
   Plan A path → media error → some fallback that re-fetches directly.

**What to capture:** `adfree_proxy_success`, `main_source_selected` with `proxyMaster` /
`variantAttach` flags, and any `main_video_error`.

### 6.2 Live rebuffering (one frame → load → one frame)

Classic segment starvation. Leading hypothesis is **WiFi throughput/latency** (§1.5), not the
player — but verify with actual segment timings before concluding.

**What to capture:** segment request timings from `/tmp/httpd.log` (if the remux path is in
use), CDP console for media/network errors, `video.readyState`/`buffered`/`currentTime` sampled
over a few minutes, and a comparison run against a VOD (known-good) to determine whether it's
live-specific.

### 6.3 SSH does not auto-start at boot

See §4.2 — unresolved.

---

## 7. Console noise to ignore

When reading logs, exclude:

- `player_scene_optimizer_run`
- `chat_mutation`
- `Key event:`
- `Refused to set unsafe header`
- `app_call_missing Play_CheckIfIsLiveCleanEnd`
- WiFi-truncation `Uncaught SyntaxError: Unexpected end of input` +
  `app_call_exception Main_CheckBasexmlHttpGet`

---

## 8. Runbook

### 8.1 Quality gates (run before every push)

```bash
npm run lint                        # jshint on app/ + webos bridge
node tools/chrome38-audit.js        # FAILS on any non-ES5 syntax in shipped JS/HTML
node tools/chrome38-apiscan.js      # reports runtime APIs newer than Chrome 38
npm run hosted:prepare              # stages release/ + injects bridge before main.js
npm run webos:package               # builds the IPK
```

`chrome38-apiscan.js` is *expected* to report `URL.prototype.searchParams` and `window.fetch`
inside the bridge — both are guarded.

### 8.2 Useful TV commands

```sh
# boot / activity
grep -a 'SIGNAL_' /var/log/bootd.log
luna-send -n 1 luna://com.palm.activitymanager/list \
  '{"details":true,"subscribers":true,"current":true,"internal":true}'
luna-send -a com.palm.activitymanager -n 1 luna://com.palm.db/find \
  "$(printf '%s' '{"query":{"from":"com.palm.activity:1"}}')"

# did the app auto-launch?
grep -a 'NL_APP_LAUNCH ' /var/log/messages | grep -o '"app_id":"[^"]*"'

# boot chain state
stat -c '%n %y' /tmp/webosbrew_startup /tmp/motd /tmp/hosts
for p in /proc/[0-9]*; do c=$(tr '\0' ' ' < $p/cmdline 2>/dev/null);
  case "$c" in *dropbear*|*telnetd*) echo "${p#/proc/} $c";; esac; done
grep ' /etc/shadow ' /proc/mounts

# kick startup.sh by hand
luna-send -n 1 luna://org.webosbrew.hbchannel.service/autostart '{}'
# → {"returnValue":true,"message":"Startup script already executed."}  (marker exists)

# reboot / launch
luna-send -n 1 luna://com.webos.service.sleep/shutdown/machineReboot '{"reason":"remoteKey"}'
luna-send -n 1 luna://com.webos.service.applicationManager/launch '{"id":"com.tbsniller.smarttwitchwebostv"}'
```

Note: `grep -ac 'NL_APP_LAUNCH_BEGIN.*smarttwitchwebostv' /var/log/messages` is the canonical
"did SmartTwitch auto-launch?" check — must be `0`.

### 8.3 Deploying the remux server

```sh
# from Windows
scp -P 22 tools/tv-serve.js root@192.168.1.105:/media/developer/sttv_stage/sttv_serve.js
# on TV, only while the app is open
```

---

## 9. Key file map

| Path | What |
| --- | --- |
| `webos/app/index.js` | Wrapper: launch params, HB kick, `ensureSttvServe()`, navigation. Dormant `sttv_boot_kick` branch ~lines 138–320. |
| `webos/bridge/webosCompatBridge.js` | The bridge. **Must stay byte-identical to `release/githubio/js/webosCompatBridge.js`.** |
| `webos/service/hls_service.js` | Luna playlist-fetch service (allowlist lives here). |
| `tools/tv-serve.js` | Remux server (fMP4 → TS), port 8099. |
| `tools/upstream/prepareHostedRelease.js` | Builds `release/`, injects the bridge before `main.js`. |
| `tools/chrome38-audit.js` / `-apiscan.js` / `-audit-file.js` | ES5 regression gates. |
| `docs/CHROME38.md` | The main technical doc: Chrome 38 constraints, playlist fetch, ad-free proxy, fMP4 remux, boot. |
| `docs/WEBOS_LIMITATIONS.md` | Canonical Android→webOS non-parity rationale. |
| `AGENTS.md` / `CLAUDE.md` / `CODEX.md` | Agent instructions incl. documented exceptions (e.g. ES5 fixes allowed in `app/specific/Play.js`). |
| TV `/var/lib/webosbrew/startup.sh` | Starts telnetd, dropbear, binds motd/hosts/shadow, runs `init.d`, runs `elevate-service`. |
| TV `/var/lib/webosbrew/init.d/90_root_password_bind` | Keeps root password `alpine` across reboots. |
| TV `/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/` | Homebrew service (`autostart`, `hb exec`, `elevate-service`). |
| PC `C:\Users\alkpe\AppData\Local\Temp\opencode\` | Session helpers: `tvcdp.js`, `cdp_*.py/js`, `test_remux.js`, `tvkey`. |

---

## 10. Decisions already made (do not re-litigate)

1. **Ad-free proxy uses Plan B**, not Plan A — the TV's media stack cannot fetch proxy hosts.
   Plan B picks a ttvnw variant out of the proxied master body. Kill switches must stay.
2. **fMP4 is never handed to the browser** — always transmux to TS locally. Native HLS and MSE
   on fMP4 are both proven dead on this device.
3. **Playlists are fetched only through the luna service**, never page XHR.
4. **SmartTwitch must not auto-launch at boot**; the remux server runs only while the app is
   open. Activity #111 must stay cancelled.
5. **Shipped code must be ES5** — no exceptions except the documented one in
   `app/specific/Play.js`.
6. **Root password `alpine`** is provisioned by the init.d bind hook, not by `startup.sh`
   (because `authorized_keys` exists).
