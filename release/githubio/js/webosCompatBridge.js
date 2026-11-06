// =============================================================================
// webosCompatBridge.js — webOS Compatibility Bridge for SmartTwitchTV
// =============================================================================
// Shims the window.Android interface expected by the upstream SmartTwitchTV app
// (app/specific/OSInterface.js) so it runs on webOS TVs without upstream changes.
// Android: The original Android app provides window.Android natively via WebView.
// webOS:   This bridge recreates that full API surface using HTML5 <video>,
//          XHR networking, and webOS platform APIs (webOS.js / PalmSystem).
//
// Loaded as a userscript before main.js in release/index.html.
// Must remain ES5-compatible for older webOS WebKit runtimes.
// =============================================================================
(function (w) {
    'use strict';
    // Guard: abort if no DOM or already loaded (prevents double-init on re-inject).
    if (!w || !w.document) return;
    if (w.__sttvHostedBridgeLoaded) return;
    w.__sttvHostedBridgeLoaded = true;
    var ua = w.navigator && w.navigator.userAgent ? w.navigator.userAgent : '';
    // Runtime detection: determine if we are on webOS or if forced bridge mode is active.
    // Android: not needed — native bridge is always present.
    // webOS:   detect via webOSSystem/PalmSystem globals or UA string.
    function isForcedBridgeEnabled() {
        try {
            if (w.location && typeof w.location.search === 'string' && /(?:\?|&)sttv_force_bridge=1(?:&|$)/.test(w.location.search)) return true;
        } catch (e) {}
        try {
            return !!(w.localStorage && w.localStorage.getItem('STTV_FORCE_BRIDGE') === '1');
        } catch (e2) {
            return false;
        }
    }
    function isWebOSRuntime() {
        if (w.webOSSystem || w.PalmSystem) return true;
        var lowUa = (ua || '').toLowerCase();
        return lowUa.indexOf('web0s') !== -1 || lowUa.indexOf('webos') !== -1;
    }
    var ENABLE_WEBOS_BRIDGE = isWebOSRuntime() || isForcedBridgeEnabled();
    if (!ENABLE_WEBOS_BRIDGE) {
        return;
    }
    // =========================================================================
    // Early Android Shim Queue Configuration
    // =========================================================================
    // When the upstream app loads, it immediately calls window.Android methods
    // before initAndroid() has run. The early shim queues these calls and
    // replays them once the full bridge is ready. Only safe, idempotent
    // methods are queueable — playback/network calls are NOT queued.
    // Android: native WebView bridge is ready before JS runs, no queue needed.
    // webOS:   bridge init is async, so queue bridges the race condition gap.
    var EARLY_ANDROID_MAX_QUEUE = 120;
    var EARLY_ANDROID_QUEUEABLE_METHODS = {
        setAppIds: true,
        setAppToken: true,
        SetLanguage: true,
        upDateLang: true,
        SetCheckSource: true,
        SetKeysOpacity: true,
        SetKeysPosition: true,
        mKeepScreenOn: true,
        SetNotificationPosition: true,
        SetNotificationRepeat: true,
        SetNotificationSinceTime: true,
        upNotificationState: true,
        SetNotificationLive: true,
        SetNotificationTitle: true,
        SetNotificationGame: true,
        Settings_SetPingWarning: true,
        SetAudioEnabled: true,
        SetVolumes: true,
        SetPreviewAudio: true,
        SetPreviewOthersAudio: true,
        SetPreviewSize: true,
        SetFeedPosition: true,
        mshowLoading: true,
        mshowLoadingBottom: true
    };
    // =========================================================================
    // State Variables
    // =========================================================================

    // --- Token & DOM state ---
    var appToken = null;       // Persisted OAuth token. Android: stored in SharedPreferences.
    var root = null;           // Container <div> for video elements, injected into document.body.
    var mv = null;             // Main <video> element. Android: ExoPlayer / MediaPlayer surface.
    var pv = null;             // Preview/feed <video> element. Android: secondary player surface.

    // --- Playback state (main & preview) ---
    // ms/ps track current stream state. Android: maintained by ExoPlayer instance state.
    var ms = {type: 1, uri: '', rawUri: '', playlist: '', q: [], qp: -1, resume: 0};
    var ps = {type: 1, uri: '', rawUri: '', playlist: '', q: [], qp: -1, mode: 'preview', slot: 1, multi: 1, resume: 0, feedPos: 2};

    // --- Audio state ---
    // Per-slot audio enables/volumes. Android: managed natively per ExoPlayer instance.
    var audioEnabled = [true, false, false, false];
    var audioVolumes = [1, 1, 1, 1];
    var previewScale = 1;      // Preview volume multiplier (0-1).
    var previewCap = 1;        // Main volume cap when preview is playing (0-1).

    // --- Layout state ---
    // Android: handled by native View layout params. webOS: CSS position/size on <video>.
    var previewSize = 1;       // Preview size variant (1-3).
    var picPos = 4;            // PiP position index (1-4 corners).
    var picSize = 2;           // PiP size variant (1-3).
    var isFull = true;         // Fullscreen vs split mode toggle.
    var fsPos = 0;             // Fullscreen position variant.
    var fsSize = 3;            // Fullscreen size variant.
    var feedBottomPx = 0;      // Feed bottom viewport offset in pixels.
    var sideRect = null;       // Side panel rect {left, top, width, height}.
    var mainMaxRes = 0;        // Max resolution cap for main player (0 = unlimited).
    var smallMaxRes = 0;       // Max resolution cap for preview player (0 = unlimited).
    // --- Storage & constants ---
    var STORAGE_PREFIX = 'sttv_webos_';
    // Persist last seen hosted WebTag to avoid repeated reloads for the same build.
    var WEBTAG_STORAGE_KEY = STORAGE_PREFIX + 'webtag';
    // Multi-stream rejection notices. Android: supports multi-stream natively.
    // webOS: single hardware decoder, so multi/PiP/side-panel are rejected.
    var MULTISTREAM_NOTICE_COOLDOWN_MS = 3000;
    var MULTISTREAM_NOTICE_MESSAGE = 'webOS limitation: Multi/PiP playback is not available. Using single-player mode.';
    var MULTISTREAM_FAIL_MESSAGE = 'webOS limitation: Multi/PiP playback is not available.';
    var keyUiOpacity = 1;       // Keys overlay opacity (0-1). Android: SetKeysOpacity native call.
    // Device info cache — read once from PalmSystem.deviceInfo at init.
    // Android: Build.MODEL / Build.MANUFACTURER accessed via Java bridge.
    var cachedDeviceInfo = (function () {
        try {
            var raw = w.PalmSystem && w.PalmSystem.deviceInfo ? w.PalmSystem.deviceInfo : null;
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    })();
    function detectRepoBasePath() {
        var pathname = (w.location && w.location.pathname) || '';
        var markers = ['/release/', '/hosted/', '/webos/app/'];
        var i;
        for (i = 0; i < markers.length; i++) {
            var idx = pathname.indexOf(markers[i]);
            if (idx > 0) return pathname.slice(0, idx);
        }
        return '/SmartTwitchWebOSTV';
    }
    var FORK_BASE_URL = (w.location && w.location.origin ? w.location.origin : 'https://tbsniller.github.io') + detectRepoBasePath();
    var FORK_RELEASE_URL = FORK_BASE_URL + '/release/index.html';
    var FORK_VERSION_URL = FORK_BASE_URL + '/release/githubio/version/version.json';
    // --- Multi-stream warning state ---
    var multiWarnShown = false;       // Whether multi-stream rejection notice was shown.
    var secondaryWarnAt = 0;          // Timestamp of last secondary stream warning.

    // --- Version refresh state ---
    var versionRefreshInFlight = false; // Guards concurrent version check fetches.
    var versionRefreshLastAt = 0;       // Timestamp of last successful version check.
    var versionRefreshIntervalId = 0;   // Interval ID — cleared when app goes hidden.

    // --- Preview deduplication & transition guards ---
    var previewTransitionUntil = 0;   // Timestamp until which preview end/error events are suppressed.
    var previewSetLastAt = 0;         // Timestamp of last setPrev call (for cooldown dedup).
    var previewSetLastKey = '';        // Composite key of last setPrev request.

    // --- Error recovery state ---
    // Retry counters: max 2 retries with exponential backoff (120ms * N).
    // Android: ExoPlayer has its own internal retry/reconnect logic.
    var mainErrorCount = 0;
    var previewErrorCount = 0;
    var mainStallTimerId = 0;         // 8-second stall check timer for main player.
    var previewStallTimerId = 0;      // 7-second stall check timer for preview player.
    var reuseFeedSwitchTimerId = 0;   // Timer for ReuseFeedPlayer delayed switch.
    var sceneSafetyStopTimerId = 0;   // Deduped timer for delayed scene-leave cleanup.
    var mainLastProgressWallMs = 0;   // Last wall-clock timestamp with meaningful playback progress.
    var mainLastCurrentTime = 0;      // Last sampled main currentTime (seconds).
    var mainLastBufferedAhead = 0;    // Last sampled buffered-ahead seconds for main.
    var mainHardReloadCount = 0;      // Number of hard reloads (mv.load) in current cooldown window.
    var mainLastHardReloadMs = 0;     // Wall-clock timestamp of most recent hard reload.
    var mainDecoderJamRecoveryTimerId = 0; // Timer id for decoder-jam soft recovery follow-up.

    // --- Loading indicator state ---
    var mainLoadingSinceAt = 0;       // When main loader was first shown (for hysteresis).
    var mainLoadingProbeAt = 0;       // Last timeupdate/progress probe timestamp (debounce).

    // --- Duration caches ---
    // Android: ExoPlayer provides duration directly. webOS: read from video.duration/seekable.
    var mainDurationMsCached = 0;
    var previewDurationMsCached = 0;
    // --- Video status telemetry counters ---
    // Android: ExoPlayer provides native bandwidth/dropped-frame/latency stats.
    // webOS:   approximated from HTML5 video buffered ranges, RTT measurements,
    //          and getVideoPlaybackQuality() where available.
    var statusConSpeed = 0;
    var statusConSpeedAVG = 0;
    var statusSpeedCounter = 0;
    var statusNetActivity = 0;
    var statusNetActivityAVG = 0;
    var statusNetCounter = 0;
    var statusPingValue = 0;
    var statusPingValueAVG = 0;
    var statusPingCounter = 0;
    var statusDroppedFrames = 0;
    var statusDroppedFramesTotal = 0;
    var statusDroppedFramesLastSample = 0;
    var statusLastSampleAt = 0;
    var statusLastBufferedEndSeconds = 0;
    var statusLiveOffsetMainDisplayMs = 0;
    var statusLiveOffsetPreviewDisplayMs = 0;
    var liveLatencyOffsetMainMs = 0;
    var liveLatencyOffsetPreviewMs = 0;
    // --- Launch/relaunch event state ---
    // Android: handled by Activity onNewIntent(). webOS: webOSRelaunch event.
    var launchEventHandlersInstalled = false;
    var launchLastComparableTarget = '';
    var launchBootstrapTimerId = 0;
    var launchSystemEventSeen = false;

    // --- Back key alias state ---
    // Dispatches synthetic F2 key as "back" since webOS remote back key differs from Android.
    var backAliasDispatching = false;
    var backAliasLastDispatchAt = 0;

    // --- Lifecycle / visibility state ---
    // Android: Activity onPause/onResume. webOS: visibilitychange + page show/hide.
    var lifecycleHooksInstalled = false;
    var lifecycleSuspended = false;
    var lifecycleHiddenSinceAt = 0;
    var lifecycleStopTimerId = 0;
    // --- Network layer constants ---
    // Android: OkHttp handles timeouts, retries, connection pooling natively.
    // webOS:   XHR-based with manual circuit-breaker, RTT tracking, and response caching.
    var NETWORK_MAX_TIMEOUT_MS = 10000;               // Default XHR timeout cap (async).
    var NETWORK_HIGH_RISK_TIMEOUT_MS = 8000;           // Timeout for high-risk hosts (async).
    var NETWORK_SYNC_MAX_TIMEOUT_MS = 3000;            // Sync XHR timeout cap — blocks main thread.
    var NETWORK_SYNC_HIGH_RISK_TIMEOUT_MS = 2500;      // Sync timeout for high-risk hosts.
    var NETWORK_CIRCUIT_FAIL_WINDOW_MS = 60 * 1000;    // Window for counting host failures.
    var NETWORK_CIRCUIT_OPEN_MS = 120 * 1000;           // How long a tripped circuit stays open.
    var NETWORK_CIRCUIT_FAIL_LIMIT = 3;                // Failures in window to trip circuit.
    var NETWORK_MEDIA_PROBE_TIMEOUT_MS = 2500;         // Timeout for media accessibility probes.
    var NETWORK_MEDIA_PROBE_MIN_INTERVAL_MS = 30000;   // Min interval between probes per host.
    var NETWORK_SYNC_CACHE_MAX_AGE_MS = 120000;        // Max age for sync XHR response cache (fresh).
    var NETWORK_SYNC_CACHE_STALE_MAX_MS = 300000;     // Absolute max age — stale entries beyond this are evicted.
    var NETWORK_STATE_PRUNE_INTERVAL_MS = 60000;       // How often to prune stale network state.
    var NETWORK_RESPONSE_CACHE_MAX = 32;               // Max cached responses.
    var NETWORK_RESPONSE_CACHE_MAX_TEXT = 32768;       // Max responseText bytes per cache entry (32 KB).
    var NETWORK_RTT_HOST_MAX = 64;                     // Max tracked RTT hosts.
    var NETWORK_PROBE_HOST_MAX = 32;                   // Max tracked probe hosts.
    var NETWORK_CIRCUIT_HOST_MAX = 48;                 // Max tracked circuit-breaker hosts.
    var USHER_PLAYLIST_SERVICE_ID_SUFFIX = '.hls';     // Local JS service suffix appended to app id.
    var USHER_PLAYLIST_SERVICE_TIMEOUT_MS = 4500;      // Timeout for local service playlist fetch.
    var USHER_PLAYLIST_SERVICE_TIMEOUT_MIN_MS = 1200;  // Min allowed timeout sent to local service.
    var USHER_PLAYLIST_SERVICE_TIMEOUT_MAX_MS = 7000;  // Max allowed timeout sent to local service.
    var USHER_PLAYLIST_SERVICE_COLD_GRACE_MS = 10000; // Extra bridge wait on first call: ls2 must spawn the node service process first.
    var USHER_PLAYLIST_SERVICE_WARM_MARGIN_MS = 4000; // Bridge wait beyond the service's own deadline (DNS/TLS/fetch + luna delivery slack).
    var USHER_PLAYLIST_CACHE_TTL_MS = 45000;           // In-memory TTL for service-fetched playlists.
    var USHER_PLAYLIST_CACHE_MAX = 24;                 // Max cached service playlist entries.
    var USHER_PLAYLIST_INFLIGHT_MAX_AGE_MS = 20000;    // Safety prune age for stale in-flight entries.
    var PREVIEW_SET_COOLDOWN_MS = 450;                 // Dedup cooldown for repeated setPrev calls.
    var LIFECYCLE_STOP_MIN_HIDDEN_MS = 12000;          // Min hidden time before stopping playback.
    var STALL_PROGRESS_THRESHOLD_MS = 4000;            // No-progress window before stall is considered persistent.
    var STALL_BUFFER_LOW_SECONDS = 1.0;                // Buffer-ahead threshold that indicates network starvation.
    var HARD_RELOAD_COOLDOWN_WINDOW_MS = 30000;        // Time window for mv.load() cooldown accounting.
    var HARD_RELOAD_MAX_IN_WINDOW = 2;                 // Max mv.load() attempts per cooldown window.
    var DECODER_JAM_SOFT_RECOVERY_MS = 1200;           // Follow-up delay for pause/play soft recovery checks.

    // --- Network layer state ---
    var networkInFlightByKey = {};            // In-flight XHR requests by dedup key.
    var networkCircuitByHost = {};            // Per-host circuit-breaker state.
    var networkFilterWarningShown = false;    // Whether DNS filter warning was shown.
    var networkRttByHost = {};                // Per-host RTT samples.
    var networkRttByFamily = {};              // Per-host-family RTT aggregates.
    var networkMediaProbeByHost = {};         // Per-host media probe timestamps.
    var networkResponseCacheByKey = {};       // Cached sync XHR responses by request key.
    var networkRttGlobalAvgMs = 0;            // Global average RTT across all hosts.
    var networkPruneLastAt = 0;               // Last network state prune timestamp.
    var usherPlaylistCacheByKey = {};         // Short-TTL in-memory playlist cache (service path).
    var usherPlaylistInFlightByKey = {};      // In-flight service fetch callbacks by request key.
    var usherPlaylistCorsFailureSeen = false; // Session flag: if true, skip doomed browser XHR on usher playlist.
    var usherServiceWarm = false;            // True once the local HLS service answered at least once (node process spawned).
    // --- Loading indicator debounce ---
    // Loader show is delayed by DEBOUNCE_MS to prevent flicker on fast loads.
    // Loader hide is always immediate (canplay/playing/loadeddata events).
    // Android: native loading overlay controlled by ExoPlayer state callbacks.
    var MAIN_LOADING_DEBOUNCE_MS = 450;    // Delay before showing main loader.
    var FEED_LOADING_DEBOUNCE_MS = 450;    // Delay before showing feed loader.
    var mainLoadingShowTimerId = 0;        // Debounce timer ID for main loader.
    var feedLoadingShowTimerId = 0;        // Debounce timer ID for feed loader.
    var mainLoadingVisibleState = false;   // In-memory tracked main loader visibility (avoids DOM read).
    var mainVideoShown = false;            // In-memory tracked main video display state.
    var previewVideoShown = false;         // In-memory tracked preview video display state.

    // --- Browser fallback visibility cache ---
    // Cached result of isBrowserFallbackVisible() to avoid 4x getElementById per hot-path call.
    var browserFallbackVisibleCached = false;
    var browserFallbackCacheAt = 0;
    var BROWSER_FALLBACK_CACHE_TTL_MS = 30000;

    // --- Reusable objects (avoid GC pressure in hot paths) ---
    var codecProbeElement = null;          // Shared <video> element for codec capability probes.
    var timelineResultMain = {durationMs: 0, positionMs: 0, seekStartSeconds: 0, seekEndSeconds: 0, useSeekableWindow: false};
    var timelineResultPreview = {durationMs: 0, positionMs: 0, seekStartSeconds: 0, seekEndSeconds: 0, useSeekableWindow: false};
    var timelineResultTemp = {durationMs: 0, positionMs: 0, seekStartSeconds: 0, seekEndSeconds: 0, useSeekableWindow: false};
    var lastMainRect = {left: -1, top: -1, width: -1, height: -1};       // Cached applyRect values for main.
    var lastPreviewRect = {left: -1, top: -1, width: -1, height: -1};    // Cached applyRect values for preview.
    var VERSION_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
    var BACK_DISPATCH_KEY = 113; // Android bridge uses KEYCODE_F2 as "back"
    var BRIDGE_DEBUG_ENABLED = isBridgeDebugEnabled();
    var PLAYER_SCENE_OPT_CHAT_MAX = 72;
    var PLAYER_SCENE_OPT_RECENT_ACTIVE = 48;
    var PLAYER_SCENE_OPT_VISIBILITY_MARGIN_PX = 96;
    var PLAYER_SCENE_OPT_MUTATION_DEBOUNCE_MS = 180;
    var PLAYER_SCENE_OPT_FALLBACK_INTERVAL_MS = 1200;
    var PLAYER_SCENE_OPT_SCENE_POLL_MS = 900;
    var PLAYER_SCENE_OPT_MAX_PRUNE_PER_PASS = 12;
    var PLAYER_SCENE_OPT_MAX_MEDIA_OPS_PER_PASS = 64;
    var PLAYER_SCENE_OPT_PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    var playerSceneOptimizerMonitorId = 0;
    var playerSceneOptimizer = {
        active: false,
        pendingReason: '',
        runTimerId: 0,
        fallbackTimerId: 0,
        scene: null,
        styleNode: null,
        mutationObserver: null,
        attrObservers: [],
        chatBoxes: [null, null],
        chatContainers: [null, null],
        chatHolders: [null, null]
    };
    // =========================================================================
    // Bootstrap Sequence (runs immediately at parse time)
    // =========================================================================
    // 1. Install early shim so window.Android exists before upstream JS runs.
    // 2. Polyfill missing ES6+ globals for older webOS WebKit (globalThis, WeakRef).
    // 3. Block Twitch embed scripts that conflict with native <video> playback.
    // 4. Seed OSInterface globals so upstream detects "native" mode.
    installEarlyAndroidShim();
    installLegacyRuntimePolyfills();
    installEmbedScriptBlocker();
    seedOsInterfaceGlobalsEarly();
    // Returns the key code used to signal "back" to the upstream app.
    // Android: uses KEYCODE_BACK (4). webOS: remapped to F2 (113) via keyEvent bridge.
    function getBackDispatchKey() {
        return BACK_DISPATCH_KEY;
    }
    // Seeds global flags that OSInterface.js checks to detect native bridge presence.
    // Android: set by WebView.addJavascriptInterface(). webOS: set early to avoid fallback path.
    function seedOsInterfaceGlobalsEarly() {
        if (typeof w.Main_IsOn_OSInterface === 'undefined') {
            w.Main_IsOn_OSInterface = true;
        }
        if (typeof w.Main_IsOn_OSInterfaceVersion === 'undefined') {
            w.Main_IsOn_OSInterfaceVersion = 'webos';
        }
        if (typeof w.Main_isDebug === 'undefined') {
            w.Main_isDebug = false;
        }
        if (typeof w.KEY_RETURN !== 'undefined') w.KEY_RETURN = BACK_DISPATCH_KEY;
    }

    // Safe JSON.parse wrapper with fallback. Used throughout for parsing API responses.
    function safeParse(v, f) {
        try {
            return v ? JSON.parse(v) : f;
        } catch (e) {
            return f;
        }
    }
    function isBridgeDebugEnabled() {
        try {
            if (w.location && typeof w.location.search === 'string' && /(?:\?|&)sttv_debug=1(?:&|$)/.test(w.location.search)) return true;
        } catch (e) {}
        try {
            return !!(w.localStorage && w.localStorage.getItem('STTV_DEBUG') === '1');
        } catch (e2) {
            return false;
        }
    }
    function isForceHlsServiceFetchEnabled() {
        try {
            if (w.location && typeof w.location.search === 'string' && /(?:\?|&)sttv_debug_force_hls_service_fetch=1(?:&|$)/i.test(w.location.search)) {
                return true;
            }
        } catch (e0) {}
        try {
            if (!w.localStorage) return false;
            var value = w.localStorage.getItem('STTV_DEBUG_FORCE_HLS_SERVICE_FETCH');
            if (value === '1' || value === 'true' || value === 'TRUE') return true;
        } catch (e1) {}
        return false;
    }
    function bridgeDebugLog(event, extra) {
        if (!BRIDGE_DEBUG_ENABLED) return;
        var payload = {event: event || 'event', t: Date.now()};
        if (extra && typeof extra === 'object') {
            var key;
            for (key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
            }
        }
        try {
            if (w.console && typeof w.console.log === 'function') {
                w.console.log('[STTV webOS bridge]', JSON.stringify(payload));
            }
        } catch (e3) {}
    }
    // Polyfills for ES6+ features missing on older webOS WebKit runtimes.
    // Android: modern WebView has these natively. webOS 3.x/4.x may not.
    // CHROME38 (webOS 3.4 / Chrome 38 / V8 3.28): additionally provides the
    // ES2015+ methods the upstream app calls at runtime. Feature-detected and
    // ES5-only; see docs/CHROME38.md. Must run before main.js (script order
    // in release/index.html is guaranteed by tools/upstream/prepareHostedRelease.js).
    function installLegacyRuntimePolyfills() {
        if (typeof w.globalThis === 'undefined') {
            w.globalThis = w;
        }
        if (typeof w.WeakRef === 'undefined') {
            var WeakRefPolyfill = function (target) {
                this.__sttvTarget = target;
            };
            WeakRefPolyfill.prototype.deref = function () {
                return this.__sttvTarget;
            };
            w.WeakRef = WeakRefPolyfill;
        }
        // --- String.prototype (Chrome 41+) ---
        if (!String.prototype.startsWith) {
            String.prototype.startsWith = function (search, pos) {
                pos = !pos || pos < 0 ? 0 : Number(pos);
                return this.substring(pos, pos + search.length) === search;
            };
        }
        if (!String.prototype.endsWith) {
            String.prototype.endsWith = function (search, end) {
                var endPosition = this.length;
                if (typeof end === 'undefined' || end > endPosition) end = endPosition;
                var startPosition = end - search.length;
                return startPosition >= 0 && this.substr(startPosition, search.length) === search;
            };
        }
        if (!String.prototype.includes) {
            String.prototype.includes = function (search, start) {
                if (typeof start !== 'number') start = 0;
                return this.indexOf(search, start) !== -1;
            };
        }
        if (!String.prototype.repeat) {
            String.prototype.repeat = function (count) {
                var str = String(this);
                var result = '';
                var n = count;
                if (n < 0 || n === Infinity) throw new RangeError('Invalid count value');
                n = Math.floor(n);
                if (str.length === 0 || n === 0) return '';
                while (n > 0) {
                    if (n % 2 === 1) result += str;
                    if (n > 1) str += str;
                    n = Math.floor(n / 2);
                }
                return result;
            };
        }
        if (!String.prototype.padStart) {
            String.prototype.padStart = function (targetLength, padString) {
                var str = String(this);
                var pad = padString === undefined || padString === '' ? ' ' : String(padString);
                var length = targetLength >> 0;
                var padLength = length - str.length;
                if (padLength <= 0) return str;
                var repeated = '';
                while (repeated.length < padLength) repeated += pad;
                return repeated.substr(0, padLength) + str;
            };
        }
        if (!String.prototype.padEnd) {
            String.prototype.padEnd = function (targetLength, padString) {
                var str = String(this);
                var pad = padString === undefined || padString === '' ? ' ' : String(padString);
                var length = targetLength >> 0;
                var padLength = length - str.length;
                if (padLength <= 0) return str;
                var repeated = '';
                while (repeated.length < padLength) repeated += pad;
                return str + repeated.substr(0, padLength);
            };
        }
        // --- Array.prototype (Chrome 45/47+) ---
        if (!Array.prototype.includes) {
            Array.prototype.includes = function (searchElement, fromIndex) {
                var o = Object(this);
                var len = o.length >>> 0;
                if (len === 0) return false;
                var n = fromIndex | 0;
                if (n < 0) n = Math.max(len + n, 0);
                while (n < len) {
                    if (o[n] === searchElement) return true;
                    n++;
                }
                return false;
            };
        }
        if (!Array.prototype.find) {
            Array.prototype.find = function (predicate, thisArg) {
                if (this === null || typeof this === 'undefined') throw new TypeError('Array.prototype.find called on null or undefined');
                if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
                var value;
                var list = Object(this);
                var length = list.length >>> 0;
                for (var i = 0; i < length; i++) {
                    value = list[i];
                    if (predicate.call(thisArg, value, i, list)) return value;
                }
                return undefined;
            };
        }
        if (!Array.prototype.findIndex) {
            Array.prototype.findIndex = function (predicate, thisArg) {
                if (this === null || typeof this === 'undefined') throw new TypeError('Array.prototype.findIndex called on null or undefined');
                if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
                var list = Object(this);
                var length = list.length >>> 0;
                for (var i = 0; i < length; i++) {
                    if (predicate.call(thisArg, list[i], i, list)) return i;
                }
                return -1;
            };
        }
        // --- Object statics (Chrome 45/54+) ---
        if (typeof Object.assign !== 'function') {
            Object.assign = function (target) {
                if (target === null || typeof target === 'undefined') throw new TypeError('Cannot convert undefined or null to object');
                var to = Object(target);
                for (var i = 1; i < arguments.length; i++) {
                    var source = arguments[i];
                    if (source === null || typeof source === 'undefined') continue;
                    for (var key in source) {
                        if (Object.prototype.hasOwnProperty.call(source, key)) to[key] = source[key];
                    }
                }
                return to;
            };
        }
        if (typeof Object.values !== 'function') {
            Object.values = function (obj) {
                if (obj === null || typeof obj === 'undefined') throw new TypeError('Cannot convert undefined or null to object');
                var vals = [];
                for (var key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) vals.push(obj[key]);
                }
                return vals;
            };
        }
        if (typeof Object.entries !== 'function') {
            Object.entries = function (obj) {
                if (obj === null || typeof obj === 'undefined') throw new TypeError('Cannot convert undefined or null to object');
                var entries = [];
                for (var key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) entries.push([key, obj[key]]);
                }
                return entries;
            };
        }
        // --- DOM helpers (Chrome 41+) ---
        if (w.Element && w.Element.prototype && !w.Element.prototype.closest) {
            w.Element.prototype.closest = function (selector) {
                var element = this;
                var matches = element.matches || element.msMatchesSelector || element.webkitMatchesSelector;
                while (element) {
                    if (matches.call(element, selector)) return element;
                    element = element.parentElement;
                }
                return null;
            };
        }
        if (w.NodeList && w.NodeList.prototype && !w.NodeList.prototype.forEach) {
            w.NodeList.prototype.forEach = Array.prototype.forEach;
        }
    }
    // =========================================================================
    // Embed Script Blocker
    // =========================================================================
    // Prevents Twitch embed.js from loading, which would create an iframe-based
    // player that conflicts with our native <video> element playback.
    // Android: not needed — ExoPlayer handles streams directly.
    // webOS:   we play HLS via <video>.src, so embed.js must be suppressed.
    function isEmbedScriptSource(src) {
        if (!src) return false;
        var lower = String(src).toLowerCase();
        return lower.indexOf('embed.twitch.tv') !== -1;
    }
    function shouldBlockEmbedScriptNode(node) {
        if (!node || node.nodeType !== 1) return false;
        var tag = node.tagName;
        if (!tag || (tag !== 'SCRIPT' && tag !== 'script')) return false;
        var src = '';
        try {
            src = node.src || (typeof node.getAttribute === 'function' ? node.getAttribute('src') : '') || '';
        } catch (e) {}
        return isEmbedScriptSource(src);
    }
    function installEmbedScriptBlocker() {
        if (w.__sttvEmbedScriptBlockerInstalled) return;
        var proto = w.Node && w.Node.prototype;
        if (!proto || typeof proto.appendChild !== 'function') return;
        if (proto.appendChild.__sttvEmbedBlockPatched && (!proto.insertBefore || proto.insertBefore.__sttvEmbedBlockPatched)) {
            w.__sttvEmbedScriptBlockerInstalled = true;
            return;
        }
        var removeBlockedNode = function (node) {
            try {
                if (node && node.parentNode) node.parentNode.removeChild(node);
            } catch (e) {}
        };
        var wrapMethod = function (methodName) {
            var original = proto[methodName];
            if (typeof original !== 'function') return;
            if (original.__sttvEmbedBlockPatched) return;
            proto[methodName] = function () {
                var node = arguments[0];
                if (shouldBlockEmbedScriptNode(node)) {
                    removeBlockedNode(node);
                    return node;
                }
                return original.apply(this, arguments);
            };
            proto[methodName].__sttvEmbedBlockPatched = true;
        };
        wrapMethod('appendChild');
        wrapMethod('insertBefore');
        if (w.HTMLHeadElement && w.HTMLHeadElement.prototype && typeof w.HTMLHeadElement.prototype.append === 'function') {
            var headAppend = w.HTMLHeadElement.prototype.append;
            if (!headAppend.__sttvEmbedBlockPatched) {
                w.HTMLHeadElement.prototype.append = function () {
                    var i;
                    for (i = 0; i < arguments.length; i++) {
                        if (shouldBlockEmbedScriptNode(arguments[i])) {
                            return;
                        }
                    }
                    return headAppend.apply(this, arguments);
                };
                w.HTMLHeadElement.prototype.append.__sttvEmbedBlockPatched = true;
            }
        }
        if (w.HTMLScriptElement && w.HTMLScriptElement.prototype) {
            var scriptProto = w.HTMLScriptElement.prototype;
            var scriptSetAttribute = scriptProto.setAttribute;
            if (typeof scriptSetAttribute === 'function' && !scriptSetAttribute.__sttvEmbedBlockPatched) {
                scriptProto.setAttribute = function (name, value) {
                    var key = typeof name === 'string' ? name.toLowerCase() : '';
                    if (key === 'src' && isEmbedScriptSource(value)) {
                        removeBlockedNode(this);
                        return;
                    }
                    return scriptSetAttribute.apply(this, arguments);
                };
                scriptProto.setAttribute.__sttvEmbedBlockPatched = true;
            }
            var srcDescriptor = null;
            try {
                srcDescriptor = Object.getOwnPropertyDescriptor(scriptProto, 'src');
            } catch (e3) {}
            if (srcDescriptor && typeof srcDescriptor.set === 'function' && !srcDescriptor.set.__sttvEmbedBlockPatched) {
                (function (descriptor) {
                    var srcGet = descriptor.get;
                    var srcSet = descriptor.set;
                    Object.defineProperty(scriptProto, 'src', {
                        configurable: true,
                        enumerable: descriptor.enumerable,
                        get: function () {
                            if (typeof srcGet === 'function') return srcGet.call(this);
                            return '';
                        },
                        set: function (value) {
                            if (isEmbedScriptSource(value)) {
                                removeBlockedNode(this);
                                return value;
                            }
                            return srcSet.call(this, value);
                        }
                    });
                    try {
                        var patchedDescriptor = Object.getOwnPropertyDescriptor(scriptProto, 'src');
                        if (patchedDescriptor && patchedDescriptor.set) patchedDescriptor.set.__sttvEmbedBlockPatched = true;
                    } catch (e4) {}
                })(srcDescriptor);
            }
        }
        if (w.document && w.document.head && w.document.head.childNodes && w.document.head.childNodes.length) {
            var i;
            for (i = 0; i < w.document.head.childNodes.length; i++) {
                var child = w.document.head.childNodes[i];
                if (shouldBlockEmbedScriptNode(child)) {
                    removeBlockedNode(child);
                }
            }
        }
        w.__sttvEmbedScriptBlockerInstalled = true;
    }
    // =========================================================================
    // Early Android Shim + Queue System
    // =========================================================================
    // Problem: Upstream JS calls window.Android.* immediately at parse time,
    // but the full bridge (initAndroid) hasn't run yet. The early shim provides
    // stub methods that queue safe calls, then drainEarlyQueue replays them.
    // Android: WebView.addJavascriptInterface() is synchronous — no race.
    // webOS:   bridge init is deferred, so we queue calls during the gap.

    // Queues a method call on the early shim for later replay.
    function queueEarlyAndroidCall(methodName, argsLike) {
        var android = w.Android;
        if (!android || !android.__isEarlyShim || !Array.isArray(android.__earlyQueue) || !methodName) return;
        var args = [];
        var i;
        for (i = 0; i < (argsLike ? argsLike.length : 0); i++) {
            args.push(argsLike[i]);
        }
        if (android.__earlyQueue.length >= EARLY_ANDROID_MAX_QUEUE) {
            android.__earlyQueue.shift();
        }
        android.__earlyQueue.push({method: methodName, args: args});
    }
    // Creates a no-op stub that optionally queues the call for later replay.
    function createEarlyAndroidNoop(methodName) {
        return function () {
            if (EARLY_ANDROID_QUEUEABLE_METHODS[methodName]) {
                queueEarlyAndroidCall(methodName, arguments);
            }
        };
    }
    // Installs the temporary early shim on window.Android with stub methods.
    // Each method either queues (if safe) or is a silent no-op.
    function installEarlyAndroidShim() {
        var existing = w.Android;
        if (existing && existing.__isWebOSPolyfill && !existing.__isEarlyShim) {
            return {active: false, queueLength: 0};
        }
        var shim = existing && typeof existing === 'object' ? existing : {};
        if (!Array.isArray(shim.__earlyQueue)) {
            shim.__earlyQueue = [];
        }
        shim.__platform = 'webos';
        shim.__isWebOSPolyfill = true;
        shim.__isEarlyShim = true;
        shim.__earlyInstalledAt = Date.now();

        var deviceInfo = cachedDeviceInfo;
        var sdk = parseInt(deviceInfo.platformVersionMajor || 0, 10) || 0;
        shim.getversion = function () { return 'webos-bridge-early'; };
        shim.getdebug = function () { return false; };
        shim.getDevice = function () { return deviceInfo.modelName || 'webOS TV'; };
        shim.getManufacturer = function () { return 'LG'; };
        shim.getSDK = function () { return sdk; };
        shim.deviceIsTV = function () { return true; };
        shim.getWebviewVersion = function () { return ua || ''; };
        shim.mPageUrl = function () { return (w.location && w.location.href) || ''; };
        shim.gettime = function () { return Date.now(); };
        shim.getsavedtime = shim.gettime;
        shim.gettimepreview = function () { return 0; };
        shim.getPlaybackState = function () { return true; };
        shim.getAppToken = function () { return appToken; };
        shim.GetLastIntentObj = function () { return null; };
        shim.getQualities = function () { return '[]'; };
        shim.getcodecCapabilities = function () { return '[]'; };
        shim.getInstallFromPLay = function () { return true; };
        shim.hasNotificationPermission = function () { return true; };
        shim.isAccessibilitySettingsOn = function () { return false; };
        shim.isKeyboardConnected = function () { return false; };
        shim.mMethodUrlHeaders = function (u, to, pm, m, ck) {
            void u;
            void to;
            void pm;
            void m;
            return res(0, '', ck);
        };
        shim.getDuration = function (cb) { call(cb, [0]); };
        shim.getVideoStatus = function () {};
        shim.getVideoQuality = function () {};
        shim.getLatency = function (n) { call('ChatLive_SetLatency', [n, 0]); };

        var queueableNames = Object.keys(EARLY_ANDROID_QUEUEABLE_METHODS);
        var i;
        for (i = 0; i < queueableNames.length; i++) {
            var name = queueableNames[i];
            if (typeof shim[name] !== 'function') {
                shim[name] = createEarlyAndroidNoop(name);
            }
        }
        w.Android = shim;
        return {active: true, queueLength: shim.__earlyQueue.length || 0};
    }
    // Replays queued early shim calls on the real (fully initialized) bridge.
    function drainEarlyAndroidShimQueue(realAndroid) {
        var current = w.Android;
        if (!current || !current.__isEarlyShim || !Array.isArray(current.__earlyQueue)) return 0;
        var queue = current.__earlyQueue.slice(0);
        current.__earlyQueue.length = 0;
        var i;
        var replayed = 0;
        for (i = 0; i < queue.length; i++) {
            var item = queue[i];
            if (!item || !item.method) continue;
            var fn = realAndroid[item.method];
            if (typeof fn !== 'function') continue;
            try {
                fn.apply(realAndroid, item.args || []);
                replayed += 1;
            } catch (e) {}
        }
        return replayed;
    }
    // Removes early-shim metadata from the Android object after full init.
    function clearEarlyAndroidShimFlags(android) {
        if (!android || typeof android !== 'object') return;
        delete android.__isEarlyShim;
        delete android.__earlyQueue;
        delete android.__earlyInstalledAt;
    }
    // =========================================================================
    // Launch Parameter Handling
    // =========================================================================
    // Android: launch intents parsed in Activity.onCreate()/onNewIntent().
    // webOS:   launch params come from PalmSystem.launchParams or webOSRelaunch event.

    // Normalizes raw launch params to an object.
    function normalizeLaunchParams(raw) {
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        return safeParse(raw, {});
    }
    function readPalmLaunchParams() {
        if (!w.PalmSystem || typeof w.PalmSystem.launchParams === 'undefined' || w.PalmSystem.launchParams === null || w.PalmSystem.launchParams === '') {
            return {available: false, params: {}};
        }
        return {available: true, params: normalizeLaunchParams(w.PalmSystem.launchParams)};
    }
    function resolveLaunchParams(eventDetail) {
        if (eventDetail && typeof eventDetail === 'object') return eventDetail;
        var palm = readPalmLaunchParams();
        if (palm.available) return palm.params;
        return {};
    }
    function isHttpTarget(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }
    function pickLaunchTarget(params) {
        if (params && isHttpTarget(params.target)) return params.target;
        if (params && isHttpTarget(params.contentTarget)) return params.contentTarget;
        return '';
    }
    function withLaunchNavigationToken(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            var parsed = new URL(url, w.location && w.location.href ? w.location.href : undefined);
            parsed.searchParams.set('sttv_webos_launch', String(Date.now()));
            return parsed.toString();
        } catch (e) {
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            return url + sep + 'sttv_webos_launch=' + Date.now();
        }
    }
    function comparableLaunchTarget(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            var parsed = new URL(url, w.location && w.location.href ? w.location.href : undefined);
            parsed.searchParams.delete('sttv_webos_launch');
            parsed.searchParams.delete('sttv_update');
            return parsed.origin + parsed.pathname + parsed.search;
        } catch (e) {
            var hashless = url.split('#')[0];
            var q = hashless.indexOf('?');
            return q >= 0 ? hashless.slice(0, q) : hashless;
        }
    }
    // Brings the webOS app to foreground. Android: not needed (Activity focus).
    function activateAppWindow() {
        try {
            if (w.webOSSystem && typeof w.webOSSystem.activate === 'function') {
                w.webOSSystem.activate();
                return true;
            }
            if (w.PalmSystem && typeof w.PalmSystem.activate === 'function') {
                w.PalmSystem.activate();
                return true;
            }
        } catch (e) {}
        return false;
    }
    function isBridgePolyfillActive() {
        return !!(w.Android && w.Android.__isWebOSPolyfill);
    }
    function clamp(v, a, b) {
        return Math.min(b, Math.max(a, v));
    }
    // =========================================================================
    // Bridge Utility Functions
    // =========================================================================

    // Resolves a function by name or reference. Looks in smartTwitchTV namespace first.
    // Android: Java bridge calls JS functions directly. webOS: we call them via fn()/call().
    function fn(n) {
        if (typeof n === 'function') return n;
        if (typeof n === 'string') return (w.smartTwitchTV && w.smartTwitchTV[n]) || w[n] || null;
        return null;
    }
    // Calls a named function from the upstream app with arguments.
    function call(n, a) {
        var f = fn(n);
        if (typeof f !== 'function') {
            bridgeDebugLog('app_call_missing', {name: n || ''});
            return null;
        }
        try {
            return f.apply(w, a || []);
        } catch (e) {
            // App exceptions would otherwise vanish here; surface them in debug
            // mode so playback failures can be traced to the throwing callback.
            bridgeDebugLog('app_call_exception', {name: n || '', error: String((e && e.message) || e)});
            return null;
        }
    }
    // Builds a JSON response string matching the Android sync XHR return format.
    function res(st, tx, ck, u) {
        var out = {status: st || 0, responseText: tx || '', checkResult: ck || 0};
        if (typeof u === 'string' && u) out.url = u;
        return JSON.stringify(out);
    }
    // =========================================================================
    // Key Dispatch
    // =========================================================================
    // Creates and dispatches synthetic keyboard events. Used by keyEvent() bridge
    // method to translate Android key codes into DOM events.
    // Android: sends key events to WebView via dispatchKeyEvent().
    // webOS:   synthesizes KeyboardEvent and dispatches to active element / body.
    function createSyntheticKeyEvent(type, code) {
        if (!w.document) return null;
        var e;
        try {
            var KeyboardEventCtor = w.KeyboardEvent;
            e = new KeyboardEventCtor(type, {
                keyCode: code,
                which: code,
                bubbles: true,
                cancelable: true
            });
            if (typeof e.keyCode !== 'number' || e.keyCode !== code) {
                Object.defineProperty(e, 'keyCode', {get: function () { return code; }});
            }
            if (typeof e.which !== 'number' || e.which !== code) {
                Object.defineProperty(e, 'which', {get: function () { return code; }});
            }
        } catch (x) {
            return null;
        }
        return e;
    }
    // Dispatches a synthetic key event to the focused element and document body.
    function dispatchBodyKey(code, isUp) {
        if (!code || !w.document || !w.document.body) return;
        var type = isUp ? 'keyup' : 'keydown';
        var targets = [];
        if (w.document.activeElement && typeof w.document.activeElement.dispatchEvent === 'function') {
            targets.push(w.document.activeElement);
        }
        targets.push(w.document.body);
        targets.push(w.document);
        var i;
        var dispatched = [];
        for (i = 0; i < targets.length; i++) {
            var t = targets[i];
            if (!t || dispatched.indexOf(t) !== -1) continue;
            dispatched.push(t);
            var ev = createSyntheticKeyEvent(type, code);
            if (ev) t.dispatchEvent(ev);
        }
    }
    // =========================================================================
    // Loading Indicator State Management
    // =========================================================================
    // Controls the visibility of loading spinners (dialog_loading_play, dialog_loading_feed).
    // Android: loading overlay controlled by ExoPlayer state callbacks (native View).
    // webOS:   CSS class toggle ('hide') on upstream DOM elements.
    //
    // Design: Show is debounced (450ms) to prevent flicker on fast loads.
    //         Hide is always immediate (on canplay/playing/loadeddata).
    //         maybeAutoClearMainLoading provides hysteresis (minimum visible duration).

    // Low-level DOM toggle — adds/removes 'hide' class. Skips if already in target state.
    function setLoadingElement(id, show) {
        if (!w.document) return;
        var el = w.document.getElementById(id);
        if (!el || !el.classList) return;
        var hidden = el.classList.contains('hide');
        if (show && !hidden) return;
        if (!show && hidden) return;
        el.classList[show ? 'remove' : 'add']('hide');
    }
    // Cancels pending debounce timer for main loader.
    function clearMainLoadingShowTimer() {
        if (!mainLoadingShowTimerId) return;
        w.clearTimeout(mainLoadingShowTimerId);
        mainLoadingShowTimerId = 0;
    }
    // Cancels pending debounce timer for feed loader.
    function clearFeedLoadingShowTimer() {
        if (!feedLoadingShowTimerId) return;
        w.clearTimeout(feedLoadingShowTimerId);
        feedLoadingShowTimerId = 0;
    }
    // Debounced show for main loader — delays by MAIN_LOADING_DEBOUNCE_MS (450ms).
    // If video starts playing before timer fires, the timer is cancelled (no flicker).
    function requestMainLoadingShow() {
        if (isMainLoadingVisible() || mainLoadingShowTimerId) return;
        mainLoadingShowTimerId = w.setTimeout(function () {
            mainLoadingShowTimerId = 0;
            setMainLoading(true);
        }, MAIN_LOADING_DEBOUNCE_MS);
    }
    // Debounced show for feed/preview loader.
    function requestFeedLoadingShow() {
        if (isLoadingElementVisible('dialog_loading_feed') || feedLoadingShowTimerId) return;
        feedLoadingShowTimerId = w.setTimeout(function () {
            feedLoadingShowTimerId = 0;
            setFeedLoading(true);
        }, FEED_LOADING_DEBOUNCE_MS);
    }
    // Sets main loader visibility. Updates in-memory state and DOM.
    // Called with false (immediate hide) from canplay/playing/loadeddata event handlers.
    function setMainLoading(show) {
        var next = !!show;
        if (!next) clearMainLoadingShowTimer();
        if (next) {
            if (!mainLoadingSinceAt) mainLoadingSinceAt = Date.now();
        } else {
            mainLoadingSinceAt = 0;
        }
        mainLoadingVisibleState = next;
        setLoadingElement('dialog_loading_play', next);
    }
    // Sets feed/preview loader visibility.
    function setFeedLoading(show) {
        if (!show) clearFeedLoadingShowTimer();
        setLoadingElement('dialog_loading_feed', !!show);
    }
    // Checks if a loading element is visible via DOM query. Used for feed loader
    // (main loader uses in-memory flag instead for hot-path performance).
    function isLoadingElementVisible(id) {
        if (!w.document) return false;
        var el = w.document.getElementById(id);
        if (!el) return false;
        if (el.classList && el.classList.contains('hide')) return false;
        if (el.style && el.style.display === 'none') return false;
        return true;
    }
    // Returns main loader visibility from in-memory state (no DOM read — hot-path safe).
    function isMainLoadingVisible() {
        return mainLoadingVisibleState;
    }
    // Opportunistically hides the main loader if video is playing normally.
    // Called from timeupdate (~4Hz) and progress events. Has internal debounce
    // (250ms for timeupdate, 350ms for progress) and hysteresis (minVisibleMs
    // ensures the loader stays visible for at least that long to avoid blink).
    // Android: ExoPlayer state machine handles this natively.
    function maybeAutoClearMainLoading(source, minVisibleMs) {
        var now = Date.now();
        if (source === 'timeupdate' && now - mainLoadingProbeAt < 250) return false;
        if (source === 'progress' && now - mainLoadingProbeAt < 350) return false;
        mainLoadingProbeAt = now;
        if (!isMainLoadingVisible()) return false;
        if (isBrowserFallbackVisible()) return false;
        if (!isMainActive() || !mv || !hasVideoSource(mv)) return false;
        if (mv.ended || mv.paused || mv.readyState < 2) return false;
        var minMs = minVisibleMs > 0 ? minVisibleMs : 0;
        if (minMs > 0 && mainLoadingSinceAt > 0 && now - mainLoadingSinceAt < minMs) return false;
        clearMainStallTimer();
        setMainLoading(false);
        return true;
    }
    // Checks if a video element has an active source (src or currentSrc).
    function hasVideoSource(v) {
        if (!v) return false;
        return !!(v.currentSrc || v.src);
    }
    // Checks if video is paused by user (not by end-of-stream).
    function isVideoPausedByUser(video) {
        return !!(video && video.paused && !video.ended);
    }
    // Returns true if main video is active (has source and visible). Uses in-memory flag.
    function isMainActive() {
        return !!(mv && hasVideoSource(mv) && mainVideoShown);
    }
    // Returns true if preview video is active (has source and visible). Uses in-memory flag.
    function isPreviewActive() {
        return !!(pv && hasVideoSource(pv) && previewVideoShown);
    }
    // =========================================================================
    // Codec & URL Utilities
    // =========================================================================

    // Checks if a codec string is an audio codec (used to skip audio-only probes).
    // Android: ExoPlayer handles codec selection natively.
    // webOS:   we probe via canPlayType() on a cached <video> element.
    function isAudioCodec(codec) {
        if (!codec) return false;
        var c = String(codec).toLowerCase();
        return (
            c.indexOf('mp4a') === 0 ||
            c.indexOf('ac-3') === 0 ||
            c.indexOf('ec-3') === 0 ||
            c.indexOf('opus') === 0 ||
            c.indexOf('vorbis') === 0
        );
    }
    // Probes whether all video codecs in a comma-separated list are supported.
    // Uses a cached <video> element (codecProbeElement) to avoid per-call allocation.
    function isCodecSetSupported(codecs) {
        if (!codecs) return true;
        try {
            if (!codecProbeElement && w.document && w.document.createElement) codecProbeElement = w.document.createElement('video');
            var probe = codecProbeElement;
            if (!probe || typeof probe.canPlayType !== 'function') return true;
            var parts = String(codecs)
                .split(',')
                .map(function (s) {
                    return s.trim();
                })
                .filter(function (s) {
                    return !!s;
                });
            var i;
            for (i = 0; i < parts.length; i++) {
                if (isAudioCodec(parts[i])) continue;
                if (!probe.canPlayType('video/mp4; codecs="' + parts[i] + '"')) return false;
            }
            return true;
        } catch (e) {
            return true;
        }
    }
    // Resolves a relative URL to absolute.
    function toAbsoluteUrl(url, base) {
        if (!url || typeof url !== 'string') return '';
        try {
            return new URL(url, base || w.location.href).toString();
        } catch (e) {
            return url;
        }
    }
    // Notifies upstream that preview tracking should be cleared.
    function clearPreviewTracking() {
        call('Play_CheckIfIsLiveCleanEnd');
    }
    // Checks if a text input is focused (prevents key events from interfering).
    function isTextInputActive() {
        if (!w.document || !w.document.activeElement) return false;
        var ae = w.document.activeElement;
        var tag = ae.tagName ? ae.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea') return true;
        return !!ae.isContentEditable;
    }
    // Returns a version string compatible with the upstream version check format.
    // Android: returns BuildConfig.VERSION_NAME. webOS: synthesized from app version globals.
    function getCompatibleVersion() {
        var fallback = '3.0.377';
        try {
            if (!w.version) return fallback;
            var base = String(w.version.VersionBase || '').trim();
            var patch = parseInt(w.version.publishVersionCode, 10);
            if (!base) return fallback;
            if (base.indexOf('.') === -1) base = base + '.0';
            if (isNaN(patch) || patch < 0) return fallback;
            return base + '.' + patch;
        } catch (e) {
            return fallback;
        }
    }
    // =========================================================================
    // Lifecycle Management
    // =========================================================================
    // Android: Activity lifecycle (onPause/onResume/onStop) managed by Android OS.
    // webOS:   visibilitychange + pageshow/pagehide events. App may be hidden
    //          (e.g., user presses Home) and must pause playback to release decoder.
    //          After LIFECYCLE_STOP_MIN_HIDDEN_MS (12s), playback is stopped entirely.

    // Returns true if the upstream app has completed initial startup.
    function hasStartedApp() {
        return typeof w.Main_started !== 'undefined' && !!w.Main_started;
    }
    // Guard: only handle lifecycle events if app is started and bridge is active.
    function shouldLifecycleHandle() {
        if (!hasStartedApp()) return false;
        if (typeof w.Main_IsOn_OSInterface !== 'undefined' && !w.Main_IsOn_OSInterface) return false;
        return true;
    }
    // Cross-browser check for document visibility (standard + webkit prefix).
    function isDocumentHiddenNow() {
        if (!w.document) return false;
        if (w.document.visibilityState === 'hidden' || w.document.webkitVisibilityState === 'hidden') return true;
        if (typeof w.document.hidden !== 'undefined') return !!w.document.hidden;
        if (typeof w.document.webkitHidden !== 'undefined') return !!w.document.webkitHidden;
        return false;
    }
    // Stops playback if app has been hidden long enough. Called from delayed timer.
    function tryLifecycleStop() {
        if (!shouldLifecycleHandle()) return;
        if (lifecycleSuspended) return;
        if (!isDocumentHiddenNow()) return;
        if (lifecycleHiddenSinceAt > 0 && Date.now() - lifecycleHiddenSinceAt < LIFECYCLE_STOP_MIN_HIDDEN_MS) {
            scheduleLifecycleStop(LIFECYCLE_STOP_MIN_HIDDEN_MS - (Date.now() - lifecycleHiddenSinceAt));
            return;
        }
        if (call('Main_CheckStop') !== null) lifecycleSuspended = true;
    }
    // Resumes playback after app returns to foreground.
    function tryLifecycleResume() {
        if (!shouldLifecycleHandle()) return;
        lifecycleHiddenSinceAt = 0;
        var isStopped = !!w.Main_isStopped;
        var shouldUnblock = lifecycleSuspended || isStopped;
        if (!shouldUnblock) return;
        clearStopBlockers();
        if (call('Main_CheckResume') !== null) lifecycleSuspended = false;
        clearStopBlockers();
    }
    function scheduleLifecycleStop(delayMs) {
        if (!shouldLifecycleHandle()) return;
        if (lifecycleStopTimerId) w.clearTimeout(lifecycleStopTimerId);
        lifecycleStopTimerId = w.setTimeout(function () {
            lifecycleStopTimerId = 0;
            tryLifecycleStop();
        }, delayMs > 0 ? delayMs : 0);
    }
    function clearScheduledLifecycleStop() {
        if (!lifecycleStopTimerId) return;
        w.clearTimeout(lifecycleStopTimerId);
        lifecycleStopTimerId = 0;
    }
    // =========================================================================
    // Back Key Handling
    // =========================================================================
    // Android: KEYCODE_BACK (4) handled by Activity.onBackPressed().
    // webOS:   various key codes (461/Escape/BrowserBack) mapped to back action.

    // Detects if a key event is a "back" key on any webOS remote/keyboard.
    function keyLooksLikeBack(code, key, domCode) {
        return (
            code === BACK_DISPATCH_KEY ||
            code === 461 ||
            code === 27 ||
            code === 8 ||
            code === 10009 ||
            key === 'Escape' ||
            key === 'BrowserBack' ||
            key === 'GoBack' ||
            domCode === 'BrowserBack'
        );
    }
    function tryResumeIfStopped() {
        if (!shouldLifecycleHandle()) return false;
        if (!w.Main_isStopped) return false;
        tryLifecycleResume();
        return !w.Main_isStopped;
    }
    function clearStopBlockers() {
        try {
            if (typeof w.Main_PreventClick === 'function' && typeof w.Main_PreventClickfun === 'function') {
                w.Main_PreventClick(false, w.Main_PreventClickfun);
            }
        } catch (e) {}
    }
    // Installs visibilitychange, pageshow/pagehide, focus/blur, and back-key handlers.
    // This is the webOS equivalent of Activity lifecycle + onBackPressed().
    function installLifecycleHooks() {
        if (lifecycleHooksInstalled || !w.addEventListener || !w.document) return;
        var hiddenProp = typeof w.document.hidden !== 'undefined' ? 'hidden' : typeof w.document.webkitHidden !== 'undefined' ? 'webkitHidden' : 'hidden';
        var onVisibilityChange = function () {
            clearScheduledLifecycleStop();
            var hidden = !!w.document[hiddenProp] || w.document.visibilityState === 'hidden' || w.document.webkitVisibilityState === 'hidden';
            if (hidden) {
                if (!lifecycleHiddenSinceAt) lifecycleHiddenSinceAt = Date.now();
                if (versionRefreshIntervalId) { w.clearInterval(versionRefreshIntervalId); versionRefreshIntervalId = 0; }
                scheduleLifecycleStop(LIFECYCLE_STOP_MIN_HIDDEN_MS);
            }
            else if (
                w.document.visibilityState === 'visible' ||
                w.document.webkitVisibilityState === 'visible' ||
                !w.document[hiddenProp]
            ) {
                lifecycleHiddenSinceAt = 0;
                if (!versionRefreshIntervalId) versionRefreshIntervalId = w.setInterval(checkForkVersionAndRefresh, VERSION_REFRESH_MIN_INTERVAL_MS);
                tryLifecycleResume();
            }
        };
        w.document.addEventListener('visibilitychange', onVisibilityChange, true);
        w.document.addEventListener('webkitvisibilitychange', onVisibilityChange, true);
        w.addEventListener(
            'pageshow',
            function () {
                clearScheduledLifecycleStop();
                lifecycleHiddenSinceAt = 0;
                tryLifecycleResume();
            },
            true
        );
        w.addEventListener(
            'focus',
            function () {
                clearScheduledLifecycleStop();
                lifecycleHiddenSinceAt = 0;
                tryLifecycleResume();
            },
            true
        );
        lifecycleHooksInstalled = true;
    }
    // Forces KEY_RETURN global to stay at our back dispatch key code (F2/113).
    // Upstream may try to reassign it — this prevents that via defineProperty.
    function enforceBackKeyConstant() {
        if (typeof w.KEY_RETURN === 'undefined') return;
        var key = getBackDispatchKey();
        try {
            Object.defineProperty(w, 'KEY_RETURN', {
                get: function () { return key; },
                set: function () {},
                configurable: true,
                enumerable: true
            });
        } catch (e) {
            if (w.KEY_RETURN !== key) w.KEY_RETURN = key;
        }
    }
    // Intercepts native back/escape key events and re-dispatches them as F2 (113).
    // Android: onBackPressed() in Activity. webOS: key codes 461/Escape/BrowserBack.
    function installBackAliasBridge() {
        if (w.__sttvWebOSBackAliasInstalled || !w.addEventListener) return;
        var alias = function (event) {
            if (!event || backAliasDispatching) return;
            var code = event.keyCode || event.which || 0;
            var key = typeof event.key === 'string' ? event.key : '';
            var domCode = typeof event.code === 'string' ? event.code : '';
            var isAlias = keyLooksLikeBack(code, key, domCode);
            if (code === 8 && isTextInputActive()) return;
            if (!isAlias) return;
            clearStopBlockers();
            tryResumeIfStopped();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            else if (event.stopPropagation) event.stopPropagation();
            if (event.preventDefault) event.preventDefault();
            enforceBackKeyConstant();
            var now = Date.now();
            if (now - backAliasLastDispatchAt < 120) return;
            backAliasLastDispatchAt = now;
            backAliasDispatching = true;
            var dispatchKey = getBackDispatchKey();
            dispatchBodyKey(dispatchKey, false);
            dispatchBodyKey(dispatchKey, true);
            backAliasDispatching = false;
        };
        w.addEventListener('keydown', alias, true);
        w.addEventListener('keyup', alias, true);
        w.__sttvWebOSBackAliasInstalled = true;
    }
    // =========================================================================
    // HLS Playlist Parser
    // =========================================================================
    // Parses an HLS master playlist (#EXT-X-STREAM-INF) into a quality array.
    // Android: ExoPlayer parses playlists internally. webOS: we parse to offer
    // quality selection via the upstream UI, then set video.src to chosen variant.
    function parseQ(pl, rawBaseUri) {
        if (!pl || typeof pl !== 'string') return [];
        var l = pl.replace(/\r/g, '').split('\n');
        var out = [];
        var seen = {};
        var i;
        for (i = 0; i < l.length; i++) {
            var streamLine = l[i] && typeof l[i] === 'string' ? l[i].trim() : '';
            if (streamLine.toUpperCase().indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
            var n = l[i + 1] && typeof l[i + 1] === 'string' ? l[i + 1].trim() : '';
            if (!n || n.indexOf('#') === 0) continue;
            var rm = streamLine.match(/RESOLUTION=\d+x(\d+)/i);
            var fm = streamLine.match(/FRAME-RATE=([0-9.]+)/i);
            var cm = streamLine.match(/CODECS="([^"]+)"/i);
            var bm = streamLine.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
            var r = rm && rm[1] ? parseInt(rm[1], 10) : 0;
            var f = fm && fm[1] ? Math.round(parseFloat(fm[1]) / 10) * 10 : 30;
            var bw = bm && bm[1] ? parseInt(bm[1], 10) : 0;
            var id = r > 0 ? r + 'p' + f : 'Auto';
            var item = {id: id, resolution: r, url: toAbsoluteUrl(n, rawBaseUri), codecs: cm && cm[1] ? cm[1] : '', bandwidth: bw > 0 ? bw : 0};
            if (typeof seen[id] === 'undefined') {
                seen[id] = out.length;
                out.push(item);
            } else {
                var idx = seen[id];
                var oldItem = out[idx];
                if (!isCodecSetSupported(oldItem.codecs) && isCodecSetSupported(item.codecs)) {
                    out[idx] = item;
                }
            }
        }
        out.sort(function (a, b) {
            return b.resolution - a.resolution;
        });
        return out;
    }
    // =========================================================================
    // Video Element Creation + Event Handlers (Core Media Pipeline)
    // =========================================================================
    // Android: ExoPlayer manages media lifecycle via Java. State changes trigger
    //          callbacks to JS via evaluateJavascript().
    // webOS:   HTML5 <video> element with HLS src. Event listeners map video
    //          events to the same upstream callback flow.

    // Creates a <video> element with fixed positioning and z-index.
    function makeVideo(id, z) {
        var v = w.document.createElement('video');
        v.id = id;
        v.preload = 'metadata';
        v.playsInline = true;
        v.setAttribute('playsinline', 'playsinline');
        v.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#000;object-fit:cover;display:none;pointer-events:none;z-index:' + z;
        return v;
    }
    function ensureRoot() {
        if (!w.document || !w.document.body) return false;
        if (!root) {
            root = w.document.createElement('div');
            root.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1';
        }
        if (!root.parentNode) {
            w.document.body.insertBefore(root, w.document.body.firstChild);
        }
        return true;
    }
    // Lazily creates root + main video and installs main event handlers.
    function ensure() {
        if (!ensureRoot()) return;
        if (mv) return;
        mv = makeVideo('sttv_main', 2);
        root.appendChild(mv);
        // --- Main video event handlers ---
        // These map HTML5 video events to the upstream app's ExoPlayer callback flow.
        // Android: ExoPlayer.Listener.onPlaybackStateChanged() etc.
        // webOS:   HTML5 media events → bridge → upstream JS callbacks.

        // loadedmetadata: metadata (duration, dimensions) available. Resume VOD/clip position.
        mv.addEventListener('loadedmetadata', function () {
            var resumeTarget = ms.resume;
            if (resumeTarget > 0 && (ms.type === 2 || ms.type === 3)) {
                bridgeDebugLog('resume_seek', {resume: resumeTarget, type: ms.type, ct: mtime()});
                try { mv.currentTime = Math.max(0, resumeTarget / 1000); } catch (e) {}
            } else {
                bridgeDebugLog('resume_skip', {resume: resumeTarget, type: ms.type, ct: mtime()});
            }
            call('Play_UpdateDuration', [getMainDurationMs()]);
            mainErrorCount = 0;
            clearMainStallTimer();
            markMainProgressBaseline();
            tryPlay(mv);
            applyAudio();
        });
        // canplay: enough data to start playing. Hide loader immediately.
        mv.addEventListener('canplay', function () {
            mainErrorCount = 0;
            clearMainStallTimer();
            markMainProgressBaseline();
            setMainLoading(false);
        });
        // playing: playback started or resumed. Hide loader immediately.
        mv.addEventListener('playing', function () {
            mainErrorCount = 0;
            clearMainStallTimer();
            markMainProgressBaseline();
            setMainLoading(false);
        });
        // pause: user paused or stream ended. Hide loader if not ended.
        mv.addEventListener('pause', function () {
            clearMainStallTimer();
            clearMainDecoderJamRecoveryTimer();
            if (!mv || mv.ended) return;
            setMainLoading(false);
        });
        // loadeddata: first frame decoded. Hide loader immediately.
        mv.addEventListener('loadeddata', function () {
            mainErrorCount = 0;
            clearMainStallTimer();
            markMainProgressBaseline();
            setMainLoading(false);
        });
        // timeupdate: fires ~4Hz during playback. Opportunistically hides loader.
        mv.addEventListener('timeupdate', function () {
            mainErrorCount = 0;
            var current = !isNaN(mv.currentTime) && isFinite(mv.currentTime) ? mv.currentTime : 0;
            if (current > mainLastCurrentTime + 0.01) {
                mainLastCurrentTime = current;
                mainLastProgressWallMs = Date.now();
            }
            maybeAutoClearMainLoading('timeupdate', 300);
            if (mse && !mse.dead) msePump(mse);
        });
        // progress: new data downloaded. Opportunistically hides loader.
        mv.addEventListener('progress', function () {
            var bufferedAhead = getBufferedAheadSeconds(mv);
            if (bufferedAhead > mainLastBufferedAhead + 0.05) {
                mainLastProgressWallMs = Date.now();
            }
            mainLastBufferedAhead = bufferedAhead;
            maybeAutoClearMainLoading('progress', 600);
        });
        // seeking: user seeked. Request debounced loader show + schedule stall check.
        mv.addEventListener('seeking', function () {
            requestMainLoadingShow();
            scheduleMainStallCheck();
            if (mse && !mse.dead) mseHandleSeek(mse);
        });
        // waiting: playback stalled (buffer underrun). Show loader unless user-paused.
        mv.addEventListener('waiting', function () {
            if (isVideoPausedByUser(mv)) {
                clearMainStallTimer();
                setMainLoading(false);
                return;
            }
            requestMainLoadingShow();
            scheduleMainStallCheck();
        });
        // stalled: network stall. For live HLS, this can fire during normal
        // inter-segment idle gaps. Only treat as buffering when buffer is low.
        mv.addEventListener('stalled', function () {
            if (isVideoPausedByUser(mv)) {
                clearMainStallTimer();
                setMainLoading(false);
                return;
            }
            if (mv.readyState >= 3) {
                clearMainLoadingShowTimer();
                scheduleMainStallCheck();
                return;
            }
            requestMainLoadingShow();
            scheduleMainStallCheck();
        });
        // ended: playback finished. Notify upstream app.
        mv.addEventListener('ended', function () {
            clearMainStallTimer();
            clearMainDecoderJamRecoveryTimer();
            call('Play_PannelEndStart', [ms.type, 0, 0]);
        });
        // error: playback error. Retry up to 2x, then escalate to upstream failure handler.
        mv.addEventListener('error', function () {
            bridgeDebugLog('main_video_error', {
                code: mv && mv.error ? mv.error.code : 0,
                rs: mv ? mv.readyState : -1,
                mseActive: mseActive(),
                blob: mse && mse.blobUrl ? mse.blobUrl.substring(0, 60) : '',
                msReady: mse && mse.ms ? String(mse.ms.readyState) : 'none',
                src: String((mv && (mv.currentSrc || mv.src)) || '').substring(0, 60)
            });
            clearMainStallTimer();
            clearMainDecoderJamRecoveryTimer();
            setMainLoading(false);
            if (mv && mv.error && mv.error.code === 1) return;
            if (retryMainPlayback()) return;
            handleMainPlaybackFailure(1, mv && mv.error ? mv.error.code || 0 : 0);
        });
    }
    // Lazily creates preview video and installs preview event handlers.
    function ensurePreview() {
        if (!ensureRoot()) return;
        if (pv) return;
        pv = makeVideo('sttv_preview', 4);
        pv.muted = true;
        pv.defaultMuted = true;
        pv.setAttribute('muted', 'muted');
        root.appendChild(pv);
        // --- Preview video event handlers (mirror main with preview-specific behavior) ---
        pv.addEventListener('loadedmetadata', function () {
            if (ps.resume > 0 && ps.type === 2) try { pv.currentTime = Math.max(0, ps.resume / 1000); } catch (e) {}
            previewErrorCount = 0;
            clearPreviewStallTimer();
            tryPlay(pv);
            applyAudio();
        });
        pv.addEventListener('canplay', function () {
            previewErrorCount = 0;
            clearPreviewStallTimer();
            setFeedLoading(false);
        });
        pv.addEventListener('playing', function () {
            previewErrorCount = 0;
            clearPreviewStallTimer();
            setFeedLoading(false);
        });
        pv.addEventListener('pause', function () {
            clearPreviewStallTimer();
            if (!pv || pv.ended) return;
            setFeedLoading(false);
        });
        pv.addEventListener('loadeddata', function () {
            previewErrorCount = 0;
            clearPreviewStallTimer();
            setFeedLoading(false);
        });
        pv.addEventListener('seeking', function () {
            requestFeedLoadingShow();
            schedulePreviewStallCheck();
        });
        pv.addEventListener('waiting', function () {
            requestFeedLoadingShow();
            schedulePreviewStallCheck();
        });
        pv.addEventListener('stalled', function () {
            if (pv.readyState >= 3) {
                clearFeedLoadingShowTimer();
                clearPreviewStallTimer();
                return;
            }
            requestFeedLoadingShow();
            schedulePreviewStallCheck();
        });
        pv.addEventListener('ended', function () {
            clearPreviewStallTimer();
            if (!isPreviewActive()) return;
            if (Date.now() < previewTransitionUntil) return;
            handlePreviewPlaybackFinished(0, 0);
        });
        pv.addEventListener('error', function () {
            clearPreviewStallTimer();
            setFeedLoading(false);
            if (!isPreviewActive()) return;
            if (Date.now() < previewTransitionUntil) return;
            if (pv && pv.error && pv.error.code === 1) return;
            if (retryPreviewPlayback()) return;
            handlePreviewPlaybackFinished(1, pv && pv.error ? pv.error.code || 0 : 0);
        });
    }
    // Shows a video element (display:block) and updates in-memory visibility flag.
    function show(v) {
        if (v) {
            v.style.display = 'block';
            if (v === mv) mainVideoShown = true;
            else if (v === pv) previewVideoShown = true;
        }
    }
    // Hides a video element (display:none) and updates in-memory visibility flag.
    function hide(v) {
        if (v) {
            v.style.display = 'none';
            if (v === mv) mainVideoShown = false;
            else if (v === pv) previewVideoShown = false;
        }
    }
    // Stops and hides a video element, clearing its source and resetting state.
    // Android: ExoPlayer.release() or ExoPlayer.stop(). webOS: pause + remove src + hide.
    function clear(v) {
        if (!v) return;
        if (v === mv) stopMse();
        try { v.pause(); } catch (e) {}
        try { v.removeAttribute('src'); v.load(); } catch (e2) {}
        hide(v);
        if (v === mv) {
            clearMainStallTimer();
            mainErrorCount = 0;
            resetMainRecoveryState();
            setMainLoading(false);
            lastMainRect.left = -1;
            lastMainRect.top = -1;
            lastMainRect.width = -1;
            lastMainRect.height = -1;
        }
        if (v === pv) {
            previewTransitionUntil = Date.now() + 600;
            clearPreviewStallTimer();
            previewErrorCount = 0;
            setFeedLoading(false);
            clearPreviewTracking();
            applyAudio();
            lastPreviewRect.left = -1;
            lastPreviewRect.top = -1;
            lastPreviewRect.width = -1;
            lastPreviewRect.height = -1;
        }
    }
    // Attempts to play a video element. Swallows Promise rejection (autoplay policy).
    function tryPlay(v) { try { var r = v.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {} }
    // Returns main player position in ms. Android: ExoPlayer.getCurrentPosition().
    function mtime() { return !mv || isNaN(mv.currentTime) ? 0 : Math.floor(mv.currentTime * 1000); }
    // Returns preview player position in ms.
    function ptime() { return !pv || isNaN(pv.currentTime) ? 0 : Math.floor(pv.currentTime * 1000); }
    // =========================================================================
    // Timeline, Duration & Video Status Utilities
    // =========================================================================

    // Reads duration, position, and seekable window from a video element.
    // Returns a reusable object (no per-call allocation) to reduce GC pressure.
    // Android: ExoPlayer provides these via Player.getDuration()/getCurrentPosition().
    function getVideoTimelineState(video) {
        var out = video === mv ? timelineResultMain : video === pv ? timelineResultPreview : timelineResultTemp;
        out.durationMs = 0;
        out.positionMs = 0;
        out.seekStartSeconds = 0;
        out.seekEndSeconds = 0;
        out.useSeekableWindow = false;
        if (!video) return out;
        // MSE VOD: the element duration stays Infinity until endOfStream, so
        // report the full playlist duration instead of the append window.
        if (video === mv && mse && !mse.dead && mse.durationMs > 0) {
            var mct = parseFloat(video.currentTime);
            out.durationMs = mse.durationMs;
            out.positionMs = isFinite(mct) && mct > 0 ? Math.floor(mct * 1000) : 0;
            if (out.positionMs > out.durationMs) out.positionMs = out.durationMs;
            return out;
        }
        var rawDuration = parseFloat(video.duration);
        if (isFinite(rawDuration) && rawDuration > 0) {
            out.durationMs = Math.floor(rawDuration * 1000);
        }
        var currentSeconds = parseFloat(video.currentTime);
        if (isFinite(currentSeconds) && currentSeconds > 0) {
            out.positionMs = Math.floor(currentSeconds * 1000);
        }
        if (out.durationMs <= 0) {
            try {
                if (video.seekable && video.seekable.length > 0) {
                    out.seekStartSeconds = parseFloat(video.seekable.start(0));
                    out.seekEndSeconds = parseFloat(video.seekable.end(video.seekable.length - 1));
                    if (isFinite(out.seekStartSeconds) && isFinite(out.seekEndSeconds) && out.seekEndSeconds > out.seekStartSeconds) {
                        out.useSeekableWindow = true;
                        out.durationMs = Math.floor((out.seekEndSeconds - out.seekStartSeconds) * 1000);
                        if (isFinite(currentSeconds)) {
                            out.positionMs = Math.floor((currentSeconds - out.seekStartSeconds) * 1000);
                        } else {
                            out.positionMs = out.durationMs;
                        }
                    }
                }
            } catch (e) {}
        }
        if (out.durationMs > 0) {
            if (out.positionMs < 0) out.positionMs = 0;
            if (out.positionMs > out.durationMs) out.positionMs = out.durationMs;
        }
        out.durationMs = out.durationMs > 0 ? out.durationMs : 0;
        out.positionMs = out.positionMs > 0 ? out.positionMs : 0;
        return out;
    }
    // Refreshes only the main player's duration cache (not preview).
    function refreshMainDurationCache() {
        var md = getVideoTimelineState(mv);
        if (md.durationMs > 0) mainDurationMsCached = md.durationMs;
    }
    // Refreshes only the preview player's duration cache (not main).
    function refreshPreviewDurationCache() {
        var pd = getVideoTimelineState(pv);
        if (pd.durationMs > 0) previewDurationMsCached = pd.durationMs;
    }
    function getMainDurationMs() {
        refreshMainDurationCache();
        if (mainDurationMsCached > 0) return mainDurationMsCached;
        var appDuration = parseFloat(w.Play_DurationSeconds);
        if (isFinite(appDuration) && appDuration > 0) return Math.floor(appDuration * 1000);
        return 0;
    }
    function getPreviewDurationMs() {
        refreshPreviewDurationCache();
        return previewDurationMsCached > 0 ? previewDurationMsCached : 0;
    }
    // Returns main player position in ms (used by gettime/getsavedtime bridge methods).
    // Android: ExoPlayer.getCurrentPosition(). webOS: video.currentTime * 1000.
    function getMainCurrentTimeMs() {
        var mt = getVideoTimelineState(mv);
        if (mt.positionMs > 0) return mt.positionMs;
        var now = mtime();
        return now > 0 ? now : 0;
    }
    // Returns preview player position in ms.
    function getPreviewCurrentTimeMs() {
        var pt = getVideoTimelineState(pv);
        if (pt.positionMs > 0) return pt.positionMs;
        var now = ptime();
        return now > 0 ? now : 0;
    }
    function getAndroidCounterText(fullValue, fullValueAVG, counter) {
        var current = parseFloat(fullValue);
        if (!isFinite(current) || current < 0) current = 0;
        var avg = parseFloat(fullValueAVG);
        if (!isFinite(avg) || avg < 0) avg = 0;
        avg = counter > 0 ? avg / counter : 0;
        var c = current.toFixed(2);
        var a = avg.toFixed(2);
        return (current < 10 ? '&nbsp;&nbsp;' : '') + c + ' | ' + (avg < 10 ? '&nbsp;&nbsp;' : '') + a;
    }
    function getAndroidTimeText(msValue) {
        var seconds = parseFloat(msValue);
        if (!isFinite(seconds) || seconds <= 0) seconds = 0;
        else seconds = seconds / 1000;
        var out = seconds.toFixed(2);
        return (seconds < 10 ? '&nbsp;&nbsp;' : '') + out;
    }
    // Calculates live stream latency offset (how far behind live edge).
    // Android: ExoPlayer provides this natively. webOS: estimated from seekable window.
    function getCurrentLiveOffsetMs(video, durationMs, positionMs, previewPath) {
        if (!video) return 0;
        var liveOffsetMs = 0;
        try {
            if (video.seekable && video.seekable.length > 0) {
                var liveEdge = video.seekable.end(video.seekable.length - 1);
                var now = !isNaN(video.currentTime) && isFinite(video.currentTime) ? video.currentTime : 0;
                liveOffsetMs = Math.max(0, Math.floor((liveEdge - now) * 1000));
            }
        } catch (e) {
            liveOffsetMs = 0;
        }
        var offset = durationMs - positionMs;
        if (offset < 0) offset = 0;
        var localOffset = previewPath ? liveLatencyOffsetPreviewMs : liveLatencyOffsetMainMs;
        if (localOffset === 0 && offset > 0 && liveOffsetMs > offset + 3000) {
            localOffset = liveOffsetMs - offset;
            if (previewPath) liveLatencyOffsetPreviewMs = localOffset;
            else liveLatencyOffsetMainMs = localOffset;
        }
        liveOffsetMs -= localOffset;
        if (liveOffsetMs < 0) {
            if (previewPath) liveLatencyOffsetPreviewMs = 0;
            else liveLatencyOffsetMainMs = 0;
            liveOffsetMs = 0;
        }
        return smoothLiveOffsetMs(liveOffsetMs, !!previewPath);
    }
    function smoothLiveOffsetMs(rawMs, previewPath) {
        var next = parseInt(rawMs, 10);
        if (!isFinite(next) || next < 0) next = 0;
        var prev = previewPath ? statusLiveOffsetPreviewDisplayMs : statusLiveOffsetMainDisplayMs;
        if (!isFinite(prev) || prev < 0) prev = 0;
        var out = next;
        if (prev > 0) {
            var diff = Math.abs(next - prev);
            if (diff <= 1200) out = Math.round(prev * 0.8 + next * 0.2);
            else if (diff <= 3000) out = Math.round(prev * 0.6 + next * 0.4);
        }
        if (previewPath) statusLiveOffsetPreviewDisplayMs = out;
        else statusLiveOffsetMainDisplayMs = out;
        return out;
    }
    // Returns the furthest buffered position in seconds.
    function getBufferedEndSeconds(video) {
        if (!video || !video.buffered || !video.buffered.length) return 0;
        var maxEnd = 0;
        var i;
        for (i = 0; i < video.buffered.length; i++) {
            var end = video.buffered.end(i);
            if (isFinite(end) && end > maxEnd) maxEnd = end;
        }
        return maxEnd > 0 ? maxEnd : 0;
    }
    // Estimates network transfer speed in Mbps from buffer growth rate.
    // Android: ExoPlayer BandwidthMeter. webOS: approximated from buffered delta.
    function estimateTransferMbps(video, bitrateBps) {
        var now = Date.now();
        var bufferEnd = getBufferedEndSeconds(video);
        var out = 0;
        if (statusLastSampleAt > 0 && bufferEnd > 0 && now > statusLastSampleAt) {
            var dt = (now - statusLastSampleAt) / 1000;
            var deltaEnd = bufferEnd - statusLastBufferedEndSeconds;
            if (dt > 0) {
                if (!isFinite(deltaEnd) || deltaEnd < 0) deltaEnd = 0;
                if (deltaEnd > 12) deltaEnd = 12;
                var bitrateMbps = bitrateBps > 0 ? bitrateBps / 1000000 : 0;
                if (bitrateMbps > 0) out = (deltaEnd * bitrateMbps) / dt;
            }
        }
        statusLastSampleAt = now;
        if (bufferEnd > 0) statusLastBufferedEndSeconds = bufferEnd;
        if (!isFinite(out) || out < 0) out = 0;
        return out;
    }
    // Returns seconds of data buffered ahead of current playhead.
    function getBufferedAheadSeconds(video) {
        if (!video || !video.buffered || !video.buffered.length) return 0;
        var t = !isNaN(video.currentTime) && isFinite(video.currentTime) ? video.currentTime : 0;
        var i;
        for (i = 0; i < video.buffered.length; i++) {
            var start = video.buffered.start(i);
            var end = video.buffered.end(i);
            if (t >= start && t <= end) return Math.max(0, end - t);
        }
        var nextAhead = 0;
        for (i = 0; i < video.buffered.length; i++) {
            var s = video.buffered.start(i);
            if (s > t) {
                nextAhead = Math.max(0, video.buffered.end(i) - s);
                break;
            }
        }
        return nextAhead;
    }
    function getFrameStats(video) {
        var dropped = 0;
        var total = 0;
        if (!video) return {dropped: 0, total: 0};
        try {
            if (typeof video.getVideoPlaybackQuality === 'function') {
                var q = video.getVideoPlaybackQuality();
                dropped = parseInt(q && q.droppedVideoFrames, 10) || 0;
                total = parseInt(q && q.totalVideoFrames, 10) || 0;
                return {dropped: Math.max(0, dropped), total: Math.max(0, total)};
            }
        } catch (e) {}
        dropped = parseInt(video.webkitDroppedFrameCount, 10) || 0;
        var decoded = parseInt(video.webkitDecodedFrameCount, 10) || 0;
        total = decoded > dropped ? decoded : dropped;
        return {dropped: Math.max(0, dropped), total: Math.max(0, total)};
    }
    function getStreamBandwidthBps(video, usePreviewList) {
        var list = usePreviewList ? ps.q : ms.q;
        var index = usePreviewList ? ps.qp : ms.qp;
        if (!Array.isArray(list) || !list.length) return 0;
        if (index >= 0 && list[index] && list[index].bandwidth > 0) return parseInt(list[index].bandwidth, 10) || 0;
        var currentSrc = '';
        try {
            currentSrc = video && video.currentSrc ? toAbsoluteUrl(video.currentSrc, w.location && w.location.href ? w.location.href : '') : '';
        } catch (e) {}
        var i;
        for (i = 0; i < list.length; i++) {
            if (!list[i] || !list[i].url) continue;
            var itemSrc = toAbsoluteUrl(list[i].url, w.location && w.location.href ? w.location.href : '');
            if (currentSrc && itemSrc === currentSrc && list[i].bandwidth > 0) return parseInt(list[i].bandwidth, 10) || 0;
        }
        for (i = 0; i < list.length; i++) {
            if (list[i] && list[i].bandwidth > 0) return parseInt(list[i].bandwidth, 10) || 0;
        }
        return 0;
    }
    function collectStatusSourceHost(video) {
        try {
            var meta = safeParseRequestMeta(video && video.currentSrc ? video.currentSrc : '');
            return meta.host || '';
        } catch (e) {
            return '';
        }
    }
    function updateStatusDroppedFrames(video) {
        var frameStats = getFrameStats(video);
        var sample = frameStats.dropped > 0 ? frameStats.dropped : 0;
        if (sample < statusDroppedFramesLastSample) statusDroppedFramesLastSample = 0;
        var delta = sample - statusDroppedFramesLastSample;
        if (delta < 0) delta = 0;
        statusDroppedFramesLastSample = sample;
        statusDroppedFrames += delta;
        statusDroppedFramesTotal += delta;
    }
    // Updates telemetry counters (dropped frames, speed, ping, network activity).
    // Android: ExoPlayer provides DecoderCounters and BandwidthMeter stats natively.
    // webOS:   approximated from getVideoPlaybackQuality(), RTT, and buffer growth.
    function updateStatusCounters(video, usePreviewList) {
        if (!video) {
            statusConSpeed = 0;
            statusNetActivity = 0;
            statusPingValue = 0;
            return;
        }
        var bitrateBps = getStreamBandwidthBps(video, !!usePreviewList);
        var estimatedMbps = estimateTransferMbps(video, bitrateBps);
        statusConSpeed = estimatedMbps > 0 ? estimatedMbps : bitrateBps > 0 ? bitrateBps / 1000000 : 0;
        if (statusConSpeed > 0) {
            statusSpeedCounter += 1;
            statusConSpeedAVG += statusConSpeed;
        }
        statusNetActivity = estimatedMbps > 0 ? estimatedMbps : 0;
        if (statusNetActivity > 0) {
            statusNetCounter += 1;
            statusNetActivityAVG += statusNetActivity;
        }
        var sourceHost = collectStatusSourceHost(video);
        statusPingValue = getNetworkRttMsForHost(sourceHost);
        if (statusPingValue <= 0) {
            maybeProbeMediaHostRtt(video, sourceHost);
            statusPingValue = getNetworkRttMsForHost(sourceHost);
        }
        if (statusPingValue > 0) {
            statusPingCounter += 1;
            statusPingValueAVG += statusPingValue;
        }
        updateStatusDroppedFrames(video);
    }
    // Builds the video status JSON payload for getVideoStatus bridge method.
    // Android: ExoPlayer stats formatted in Java. webOS: assembled from HTML5 video properties.
    function buildVideoStatusPayload(showLatency, video, usePreviewList) {
        var timeline = getVideoTimelineState(video);
        var durationMs = timeline.durationMs > 0 ? timeline.durationMs : video === pv ? getPreviewDurationMs() : getMainDurationMs();
        var positionMs = timeline.positionMs > 0 ? timeline.positionMs : video === pv ? getPreviewCurrentTimeMs() : getMainCurrentTimeMs();
        if (video === pv && durationMs > 0) previewDurationMsCached = durationMs;
        if (video === mv && durationMs > 0) mainDurationMsCached = durationMs;
        var bufferSeconds = getBufferedAheadSeconds(video);
        var bufferMs = Math.round(bufferSeconds * 1000);
        var liveOffsetMs = showLatency ? getCurrentLiveOffsetMs(video, durationMs, positionMs, !!usePreviewList) : 0;
        updateStatusCounters(video, !!usePreviewList);
        var payload = [
            getAndroidCounterText(statusConSpeed, statusConSpeedAVG, statusSpeedCounter),
            getAndroidCounterText(statusNetActivity, statusNetActivityAVG, statusNetCounter),
            statusDroppedFrames,
            statusDroppedFramesTotal,
            getAndroidTimeText(bufferMs),
            getAndroidTimeText(liveOffsetMs),
            getAndroidCounterText(statusPingValue, statusPingValueAVG, statusPingCounter),
            bufferMs / 1000.0,
            durationMs,
            positionMs
        ];
        statusNetActivity = 0;
        return payload;
    }
    // Resets all telemetry counters (called on channel change).
    function resetVideoStatusCounters() {
        statusConSpeed = 0;
        statusConSpeedAVG = 0;
        statusSpeedCounter = 0;
        statusNetActivity = 0;
        statusNetActivityAVG = 0;
        statusNetCounter = 0;
        statusPingValue = 0;
        statusPingValueAVG = 0;
        statusPingCounter = 0;
        statusDroppedFrames = 0;
        statusDroppedFramesTotal = 0;
        statusDroppedFramesLastSample = 0;
        statusLastSampleAt = 0;
        statusLastBufferedEndSeconds = 0;
        statusLiveOffsetMainDisplayMs = 0;
        statusLiveOffsetPreviewDisplayMs = 0;
        liveLatencyOffsetMainMs = 0;
        liveLatencyOffsetPreviewMs = 0;
    }
    // =========================================================================
    // Seek, Audio, Quality, and Playback Control
    // =========================================================================

    // Seeks the main player to a position in milliseconds.
    // Android: ExoPlayer.seekTo(). webOS: video.currentTime = seconds.
    function seekMainToMs(positionMs) {
        if (!mv) return;
        var timeline = getVideoTimelineState(mv);
        var jumpPosition = positionMs > 0 ? positionMs : 0;
        var duration = timeline.durationMs > 0 ? timeline.durationMs : getMainDurationMs();
        if (duration > 0 && jumpPosition >= duration) jumpPosition = Math.max(0, duration - 1000);
        var seekSeconds = jumpPosition / 1000;
        if (timeline.useSeekableWindow && isFinite(timeline.seekStartSeconds) && isFinite(timeline.seekEndSeconds) && timeline.seekEndSeconds > timeline.seekStartSeconds) {
            seekSeconds = timeline.seekStartSeconds + seekSeconds;
            if (seekSeconds > timeline.seekEndSeconds) seekSeconds = timeline.seekEndSeconds;
            if (seekSeconds < timeline.seekStartSeconds) seekSeconds = timeline.seekStartSeconds;
        }
        tryPlay(mv);
        try {
            mv.currentTime = seekSeconds;
        } catch (e) {}
    }
    // Applies audio settings (volume, mute, enable) to both video elements.
    // Android: ExoPlayer per-player volume control. webOS: video.volume + video.muted.
    function applyAudio() {
        if (mv) {
            var mainEnabled = !!audioEnabled[0];
            if (!mainEnabled && !isPreviewActive() && !w.Play_MultiEnable && !w.PlayExtra_PicturePicture) {
                // Recover from stale multi-audio state leaking into single-player playback.
                mainEnabled = true;
                audioEnabled[0] = true;
            }
            var mainScale = isPreviewActive() ? previewCap : 1;
            mv.volume = clamp((mainEnabled ? audioVolumes[0] : 0) * mainScale, 0, 1);
            if (mainEnabled && !isPreviewActive() && mv.muted) mv.muted = false;
        }
        if (pv) { var s = clamp(ps.slot, 1, 3); pv.volume = clamp((audioEnabled[s] ? audioVolumes[s] : 0) * previewScale, 0, 1); }
    }
    function pickFromMaster(rawUri, list, maxRes) {
        if (list && list.length) {
            var supported = list.filter(function (item) {
                return isCodecSetSupported(item.codecs);
            });
            var candidates = supported.length ? supported : list;
            if (maxRes > 0) {
                var i;
                for (i = 0; i < candidates.length; i++) {
                    if (candidates[i].resolution > 0 && candidates[i].resolution <= maxRes) return candidates[i].url;
                }
                return candidates[candidates.length - 1].url;
            }
            return candidates[0].url;
        }
        return rawUri || '';
    }
    // Selects the best quality variant URL from the parsed playlist.
    // Android: ExoPlayer TrackSelector handles quality. webOS: manual URL selection.
    function sourceFromQuality(state, maxRes) {
        if (!state) return '';
        if (state.qp >= 0 && state.q[state.qp]) return state.q[state.qp].url;
        if (state.rawUri && (!maxRes || maxRes <= 0)) return state.rawUri;
        return pickFromMaster(state.rawUri, state.q, maxRes);
    }
    function normalizeQualityPosition(pos, listLength) {
        var parsed = -1;
        if (typeof pos === 'number' && isFinite(pos)) {
            parsed = Math.round(pos);
        } else if (typeof pos === 'string') {
            var trimmed = pos.trim();
            if (trimmed) parsed = parseInt(trimmed, 10);
        }
        if (!isFinite(parsed)) parsed = -1;
        if (parsed < -1) parsed = -1;
        // Some runtimes may deliver 1-based indexes across bridge boundaries.
        if (parsed >= 0 && listLength > 0 && parsed >= listLength && parsed - 1 >= 0 && parsed - 1 < listLength) {
            parsed = parsed - 1;
        }
        return parsed;
    }
    function clearMainStallTimer() {
        if (!mainStallTimerId) return;
        w.clearTimeout(mainStallTimerId);
        mainStallTimerId = 0;
    }
    function clearPreviewStallTimer() {
        if (!previewStallTimerId) return;
        w.clearTimeout(previewStallTimerId);
        previewStallTimerId = 0;
    }
    function clearMainDecoderJamRecoveryTimer() {
        if (!mainDecoderJamRecoveryTimerId) return;
        w.clearTimeout(mainDecoderJamRecoveryTimerId);
        mainDecoderJamRecoveryTimerId = 0;
    }
    function resetMainRecoveryState() {
        clearMainDecoderJamRecoveryTimer();
        mainLastProgressWallMs = Date.now();
        mainLastCurrentTime = 0;
        mainLastBufferedAhead = 0;
        mainHardReloadCount = 0;
        mainLastHardReloadMs = 0;
    }
    function markMainProgressBaseline() {
        var now = Date.now();
        mainLastProgressWallMs = now;
        if (!mv) {
            mainLastCurrentTime = 0;
            mainLastBufferedAhead = 0;
            return;
        }
        var current = !isNaN(mv.currentTime) && isFinite(mv.currentTime) ? mv.currentTime : 0;
        mainLastCurrentTime = current;
        mainLastBufferedAhead = getBufferedAheadSeconds(mv);
    }
    function classifyMainStall() {
        if (!mv || !hasVideoSource(mv) || !isMainActive() || isVideoPausedByUser(mv) || mv.ended) return 'not_applicable';
        var now = Date.now();
        var sinceProgress = mainLastProgressWallMs > 0 ? now - mainLastProgressWallMs : Number.MAX_VALUE;
        if (sinceProgress < STALL_PROGRESS_THRESHOLD_MS) return 'transient';
        var bufferAhead = getBufferedAheadSeconds(mv);
        var readyState = mv.readyState || 0;
        if (bufferAhead < STALL_BUFFER_LOW_SECONDS && readyState < 3) return 'network_buffering';
        return 'decoder_jam';
    }
    function debugStallDecision(classification, context) {
        if (!w.Main_isDebug || !w.console || typeof w.console.warn !== 'function') return;
        var readyState = mv ? mv.readyState || 0 : 0;
        var networkState = mv ? mv.networkState || 0 : 0;
        var bufferAhead = mv ? getBufferedAheadSeconds(mv) : 0;
        var now = Date.now();
        var sinceProgress = mainLastProgressWallMs > 0 ? now - mainLastProgressWallMs : -1;
        var current = mv && !isNaN(mv.currentTime) && isFinite(mv.currentTime) ? mv.currentTime : 0;
        w.console.warn('[sttv-webos] stall=' + classification +
            ' ctx=' + (context || '') +
            ' rs=' + readyState +
            ' ns=' + networkState +
            ' buf=' + bufferAhead.toFixed(2) +
            ' since=' + sinceProgress +
            ' ct=' + current.toFixed(2) +
            ' hardReloads=' + mainHardReloadCount +
            ' errCount=' + mainErrorCount);
    }
    function attemptDecoderJamRecovery() {
        if (!isMainActive() || !mv) return false;
        if (isVideoPausedByUser(mv) || mv.ended) return false;
        clearMainDecoderJamRecoveryTimer();
        requestMainLoadingShow();
        var startTime = !isNaN(mv.currentTime) && isFinite(mv.currentTime) ? mv.currentTime : 0;
        debugStallDecision('decoder_jam', 'soft_recovery_start');
        try { mv.pause(); } catch (e) {}
        w.setTimeout(function () {
            if (!isMainActive() || !mv) return;
            if (isVideoPausedByUser(mv) || mv.ended) return;
            tryPlay(mv);
            applyAudio();
        }, 100);
        mainDecoderJamRecoveryTimerId = w.setTimeout(function () {
            mainDecoderJamRecoveryTimerId = 0;
            if (!isMainActive() || !mv) return;
            if (isVideoPausedByUser(mv) || mv.ended) {
                setMainLoading(false);
                return;
            }
            var current = !isNaN(mv.currentTime) && isFinite(mv.currentTime) ? mv.currentTime : 0;
            if (current > startTime + 0.1) {
                markMainProgressBaseline();
                setMainLoading(false);
                clearMainLoadingShowTimer();
                debugStallDecision('decoder_jam_recovered', 'soft_recovery_check');
                return;
            }
            debugStallDecision('decoder_jam_failed', 'soft_recovery_check');
            handleMainPlaybackFailure(1, 0);
        }, DECODER_JAM_SOFT_RECOVERY_MS);
        return true;
    }
    // =========================================================================
    // Error Recovery (Stall Detection + Retry with Backoff)
    // =========================================================================
    // Android: ExoPlayer has built-in retry logic. webOS: manual retry with
    // exponential backoff (120ms * errorCount), max 2 retries.

    // Retries main player playback after error. Returns true if retry was initiated.
    function retryMainPlayback() {
        if (!isMainActive() || !mv) return false;
        if (isVideoPausedByUser(mv)) return false;
        if (mseActive()) {
            // MSE owns the pipeline: mv.load() would detach the MediaSource.
            // Re-drive the pump and re-arm the stall check; progress events
            // reset mainErrorCount, so only a persistently dead pump fails.
            clearMainDecoderJamRecoveryTimer();
            mainErrorCount += 1;
            if (mainErrorCount >= 3) {
                handleMainPlaybackFailure(1, 0);
                return false;
            }
            requestMainLoadingShow();
            msePump(mse);
            scheduleMainStallCheck();
            return true;
        }
        var now = Date.now();
        if (mainLastHardReloadMs > 0 && now - mainLastHardReloadMs > HARD_RELOAD_COOLDOWN_WINDOW_MS) {
            mainHardReloadCount = 0;
        }
        if (mainHardReloadCount >= HARD_RELOAD_MAX_IN_WINDOW) {
            debugStallDecision('network_buffering', 'retry_cooldown_block');
            return false;
        }
        if (mainErrorCount >= 2) return false;
        clearMainDecoderJamRecoveryTimer();
        mainErrorCount += 1;
        requestMainLoadingShow();
        if (ms.type === 2 || ms.type === 3) {
            // Only snapshot a REAL position: during a src swap (emptied) or a
            // cold-start stall currentTime is 0 and would wipe a pending
            // resume seek (quality switch restarted VOD from the beginning).
            var savedResume = mtime();
            if (savedResume > 0) ms.resume = savedResume;
        }
        w.setTimeout(function () {
            if (!isMainActive() || !mv) return;
            var loadNow = Date.now();
            if (mainLastHardReloadMs > 0 && loadNow - mainLastHardReloadMs > HARD_RELOAD_COOLDOWN_WINDOW_MS) {
                mainHardReloadCount = 0;
            }
            mainHardReloadCount += 1;
            mainLastHardReloadMs = loadNow;
            try {
                mv.load();
            } catch (e) {}
            tryPlay(mv);
            applyAudio();
        }, 120 * mainErrorCount);
        return true;
    }
    function retryPreviewPlayback() {
        if (!isPreviewActive() || !pv) return false;
        if (previewErrorCount >= 2) return false;
        previewErrorCount += 1;
        requestFeedLoadingShow();
        if (ps.type === 2) {
            var savedPreviewResume = ptime();
            if (savedPreviewResume > 0) ps.resume = savedPreviewResume;
        }
        w.setTimeout(function () {
            if (!isPreviewActive() || !pv) return;
            try {
                pv.load();
            } catch (e) {}
            tryPlay(pv);
        }, 120 * previewErrorCount);
        return true;
    }
    // Notifies upstream that preview playback ended (normal end or failure).
    function handlePreviewPlaybackFinished(failType, errorCode) {
        var mode = ps.mode || 'preview';
        if (mode === 'multi') {
            call('Play_MultiEnd', [ps.multi, parseInt(failType, 10) || 0, parseInt(errorCode, 10) || 0]);
            return;
        }
        if (mode === 'extra') {
            call('PlayExtra_End', [false, parseInt(failType, 10) || 0, parseInt(errorCode, 10) || 0]);
            return;
        }
        // Feed/side/preview helpers must never terminate main playback state.
        clear(pv);
        resetPreviewState();
    }
    // Notifies upstream that main playback failed after retries exhausted.
    // For live streams, prefers Play_CheckIfIsLiveClean to avoid aggressive reload loops.
    function handleMainPlaybackFailure(failType, errorCode) {
        var ft = parseInt(failType, 10) || 1;
        var ec = parseInt(errorCode, 10) || 0;
        setMainLoading(false);
        clearMainStallTimer();
        resetMainRecoveryState();
        // For live playback, prefer the live-clean path to avoid aggressive forced
        // end/start loops that can bounce back to the home screen on transient failures.
        if ((ms.type || 1) === 1 && typeof w.Play_CheckIfIsLiveClean === 'function') {
            clear(mv);
            call('Play_CheckIfIsLiveClean', [ft, ec]);
            return;
        }
        call('Play_PannelEndStart', [ms.type, ft, ec]);
    }
    // Schedules an 8-second stall check for main player. If unresolved, retries or fails.
    function scheduleMainStallCheck() {
        clearMainStallTimer();
        mainStallTimerId = w.setTimeout(function () {
            mainStallTimerId = 0;
            var classification = classifyMainStall();
            debugStallDecision(classification, 'stall_timer');
            if (classification === 'not_applicable') {
                setMainLoading(false);
                clearMainLoadingShowTimer();
                if (!isMainActive()) stopMainIfLeavingPlayerScene(0);
                return;
            }
            if (classification === 'transient') {
                var hadLoader = isMainLoadingVisible();
                setMainLoading(false);
                clearMainLoadingShowTimer();
                if (hadLoader && isMainActive() && mv && !isVideoPausedByUser(mv) && !mv.ended) {
                    scheduleMainStallCheck();
                }
                return;
            }
            if (classification === 'decoder_jam') {
                if (maybeAutoClearMainLoading('stall_timer', 1000)) return;
                if (attemptDecoderJamRecovery()) return;
                handleMainPlaybackFailure(1, 0);
                return;
            }
            if (maybeAutoClearMainLoading('stall_timer', 1000)) return;
            if (retryMainPlayback()) return;
            handleMainPlaybackFailure(1, 0);
        }, 8000);
    }
    function schedulePreviewStallCheck() {
        clearPreviewStallTimer();
        previewStallTimerId = w.setTimeout(function () {
            previewStallTimerId = 0;
            if (!isPreviewActive()) return;
            if (pv && pv.readyState >= 3 && !pv.paused && !pv.ended) {
                setFeedLoading(false);
                clearFeedLoadingShowTimer();
                return;
            }
            if (retryPreviewPlayback()) return;
            handlePreviewPlaybackFinished(1, 0);
        }, 7000);
    }
    // =========================================================================
    // Layout Functions
    // =========================================================================
    // Android: native View layout params (setLayoutParams). webOS: CSS position/size.
    // applyRect uses a cache to skip writes when values haven't changed.

    // Sets video element position/size. Caches values to avoid redundant style writes.
    function applyRect(v, left, top, width, height) {
        if (!v) return;
        var rl = Math.round(left);
        var rt = Math.round(top);
        var rw = Math.max(1, Math.round(width));
        var rh = Math.max(1, Math.round(height));
        var cache = v === mv ? lastMainRect : v === pv ? lastPreviewRect : null;
        if (cache && cache.left === rl && cache.top === rt && cache.width === rw && cache.height === rh) return;
        if (cache) { cache.left = rl; cache.top = rt; cache.width = rw; cache.height = rh; }
        v.style.left = rl + 'px';
        v.style.top = rt + 'px';
        v.style.width = rw + 'px';
        v.style.height = rh + 'px';
    }
    // Returns viewport dimensions (defaults to 1920x1080 for webOS TVs).
    function viewport() {
        return {w: w.innerWidth || 1920, h: w.innerHeight || 1080};
    }
    // Applies main video layout based on fullscreen/split mode and size/position settings.
    function applyMainLayout() {
        if (!mv) return;
        var vp = viewport();
        if (isFull) {
            applyRect(mv, 0, 0, vp.w, vp.h);
            return;
        }
        var scales = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6];
        var scale = scales[clamp(fsSize, 0, scales.length - 1)];
        var mw = vp.w * scale;
        var mh = vp.h * scale;
        var left = fsPos === 0 ? vp.w - mw : 0;
        var top = (vp.h - mh) / 2;
        applyRect(mv, left, top, mw, mh);
    }
    function applyPreviewPiPLayout() {
        if (!pv) return;
        var vp = viewport();
        if (!isFull) {
            var halfW = vp.w * 0.5;
            var halfH = vp.h * 0.5;
            applyRect(pv, (vp.w - halfW) / 2, vp.h - halfH, halfW, halfH);
            return;
        }
        var div = [2, 2.5, 3, 3.5, 4];
        var d = div[clamp(picSize, 0, div.length - 1)];
        var pw = vp.w / d;
        var ph = vp.h / d;
        var pos = clamp(picPos, 0, 7);
        var hAlign = [2, 2, 2, 1, 0, 0, 0, 1][pos];
        var vAlign = [2, 1, 0, 0, 0, 1, 2, 2][pos];
        var left = hAlign === 0 ? 0 : hAlign === 1 ? (vp.w - pw) / 2 : vp.w - pw;
        var top = vAlign === 0 ? 0 : vAlign === 1 ? (vp.h - ph) / 2 : vp.h - ph;
        applyRect(pv, left, top, pw, ph);
    }
    function feedMarginPx(vp) {
        if (feedBottomPx > 0) return feedBottomPx;
        return Math.round(vp.w / 11);
    }
    function applyFeedLayout(position) {
        if (!pv) return;
        var vp = viewport();
        var sizeDiv = [5, 3.77, 3.25, 2.7];
        var d = sizeDiv[clamp(previewSize, 0, sizeDiv.length - 1)];
        var pw = vp.w / d;
        var ph = vp.h / d;
        var pos = clamp(position, 0, 4);
        var centerOffset = vp.w * 0.3 - pw / 2;
        var left;
        if (pos === 0) left = 0;
        else if (pos === 1) left = centerOffset;
        else if (pos === 2) left = (vp.w - pw) / 2;
        else if (pos === 3) left = vp.w - pw - centerOffset;
        else left = vp.w - pw;
        var top = vp.h - feedMarginPx(vp) - ph;
        applyRect(pv, left, top, pw, ph);
    }
    function calcPreviewRect(bottom, right, left, webHeight, bigger) {
        var vp = viewport();
        var scale = webHeight && webHeight > 0 ? vp.h / webHeight : 1;
        var l = Math.max(0, Math.round(left * scale));
        var r = Math.max(l + 1, Math.round(right * scale));
        var width = r - l;
        var height = Math.round(width * 9 / 16);
        var top = Math.max(0, Math.round(bottom * scale - height));
        if (bigger) {
            width = Math.round(width * 1.15);
            height = Math.round(height * 1.15);
            top = Math.max(0, top - Math.round(height * 0.05));
        }
        return {left: l, top: top, width: width, height: height};
    }
    // Applies preview video layout based on current mode (preview/PiP/feed/side).
    function applyPreviewModeLayout() {
        if (!pv) return;
        if (ps.mode === 'feed') applyFeedLayout(ps.feedPos);
        else if (ps.mode === 'side' && sideRect) applyRect(pv, sideRect.left, sideRect.top, sideRect.width, sideRect.height);
        else applyPreviewPiPLayout();
    }
    function resetMainState() {
        ms.type = 1;
        ms.uri = '';
        ms.rawUri = '';
        ms.playlist = '';
        ms.q = [];
        ms.qp = -1;
        ms.resume = 0;
        mainDurationMsCached = 0;
        liveLatencyOffsetMainMs = 0;
    }
    function resetPreviewState() {
        ps.type = 1;
        ps.uri = '';
        ps.rawUri = '';
        ps.playlist = '';
        ps.q = [];
        ps.qp = -1;
        ps.mode = 'preview';
        ps.slot = 1;
        ps.multi = 1;
        ps.resume = 0;
        previewDurationMsCached = 0;
        liveLatencyOffsetPreviewMs = 0;
    }
    // =========================================================================
    // Core Playback Entry Points
    // =========================================================================

    // Starts main playback. Clears preview, parses playlist, sets source and loads.
    // Android: StartAuto(url, playlist, type, resume) → ExoPlayer.prepare().
    // webOS:   video.src = url, video.load(), debounced loader show.
    function setMain(u, pl, t, rs) {
        ensure();
        clear(pv);
        resetPreviewState();
        resetVideoStatusCounters();
        clearMainStallTimer();
        mainErrorCount = 0;
        resetMainRecoveryState();
        requestMainLoadingShow();
        ms.type = t || 1;
        ms.rawUri = limitUsherCodecs(u || '');
        ms.playlist = pl || '';
        ms.q = parseQ(ms.playlist, ms.rawUri);
        ms.qp = -1;
        ms.resume = rs > 0 ? rs : 0;
        bridgeDebugLog('main_playlist_parsed', {
            count: ms.q.length,
            hasPlaylist: !!ms.playlist,
            hasRawUri: !!ms.rawUri,
            firstQuality: ms.q[0] && ms.q[0].id ? ms.q[0].id : ''
        });
        ms.uri = sourceFromQuality(ms, mainMaxRes);
        mainStreamFormat = null; // new stream: segment format unknown until probed
        startMainPlayback();
        // Align with Android PlayerActivity.onTracksChanged: refresh quality list
        // for main player (live/vod) when not in PiP/multistream mode.
        if (ms.type < 3 && !w.PlayExtra_PicturePicture && !w.Play_MultiEnable) {
            call('Play_getQualities', [ms.type, false]);
            bridgeDebugLog('main_quality_refresh_requested', {
                type: ms.type,
                parsedCount: ms.q.length
            });
        }
    }
    // Starts preview/feed playback. Deduplicates rapid repeated calls.
    // Rejects multi/extra/feed/side/screens modes when main is active (hardware limit).
    // Android: StartAuto with player > 0 → secondary ExoPlayer.
    // webOS:   single hardware decoder, so only non-concurrent modes are allowed.
    function setPrev(u, pl, t, rs, m, s, mp) {
        var now = Date.now();
        var mode = m || 'preview';
        var slot = clamp(s || 1, 1, 3);
        var multi = typeof mp === 'number' ? mp : 1;
        var type = t || 1;
        var rawUri = u || '';
        // Deduplicate fast repeated preview starts to avoid decoder thrashing on webOS.
        var requestKey = [rawUri, mode, slot, multi, type].join('|');
        if (previewSetLastKey === requestKey && previewSetLastAt > 0 && now - previewSetLastAt < PREVIEW_SET_COOLDOWN_MS) {
            if (isMainActive() && (mode === 'multi' || mode === 'extra' || mode === 'feed' || mode === 'side' || mode === 'screens')) {
                return false;
            }
            return true;
        }
        previewSetLastKey = requestKey;
        previewSetLastAt = now;
        previewTransitionUntil = now + 250;
        if (isMainActive() && (mode === 'multi' || mode === 'extra' || mode === 'feed' || mode === 'side' || mode === 'screens')) {
            setFeedLoading(false);
            clear(pv);
            if (mode === 'multi') rejectMultiStream(multi);
            else showMultiLimitNotice();
            return false;
        }
        ensurePreview();
        requestFeedLoadingShow();
        ps.type = type;
        ps.rawUri = limitUsherCodecs(rawUri);
        ps.playlist = pl || '';
        ps.q = parseQ(ps.playlist, ps.rawUri);
        ps.qp = -1;
        ps.resume = rs > 0 ? rs : 0;
        ps.mode = mode;
        ps.slot = slot;
        ps.multi = multi;
        ps.uri = sourceFromQuality(ps, smallMaxRes);
        previewErrorCount = 0;
        clearPreviewStallTimer();
        if (pv) {
            try {
                pv.pause();
            } catch (e) {}
            try {
                pv.removeAttribute('src');
                pv.load();
            } catch (e2) {}
            pv.muted = true;
            pv.src = ps.uri;
            applyPreviewModeLayout();
            show(pv);
            try { pv.load(); } catch (e) {}
        }
        return true;
    }
    // =========================================================================
    // MSE fMP4 Main Player (webOS 3.4 / Chrome 38)
    // =========================================================================
    // Chrome 38's native HLS demuxer only understands MPEG-TS segments. Twitch
    // channels on custom transcode stacks serve fMP4 segments (#EXT-X-MAP +
    // .mp4): the bytes download but never decode (MEDIA_ERR_DECODE, readyState
    // stuck at 1, videoWidth 0). MSE on this browser does support fMP4
    // (MediaSource.isTypeSupported('video/mp4; codecs="avc1..."') === true), so
    // for those streams we parse the media playlist ourselves and pump init +
    // media segments into a SourceBuffer.
    // Playlists are fetched through the local luna service (usher and variant
    // playlist hosts omit CORS headers for our origin: XHR status 0 / 403);
    // segments are fetched by page XHR (live segment hosts answer ACAO:*) with
    // a same-origin /sttv_proxy fallback for VOD hosts that send no ACAO.
    // MPEG-TS channels keep the untouched native path.
    var mse = null; // Active MSE playback state, or null while native.
    var mainStreamFormat = null; // Segment format of the current stream: null|'ts'|'fmp4'.
    var mainDetectGen = 0; // Bumped per startMainPlayback; probes check against it.
    var MSE_POLL_INTERVAL_MS = 3000; // Live playlist refresh period.
    var MSE_BUFFER_TARGET_SECONDS = 45; // Append this far ahead of the playhead.
    var MSE_BUFFER_KEEP_SECONDS = 30; // Trim to this much behind the playhead.
    var MSE_PROBE_TIMEOUT_MS = 3000; // Playlist fetch timeout; must stay under the 8s stall window.
    var MSE_SEGMENT_MAX_FAILS = 4; // Segment failures before restarting the pipeline.
    var MSE_DEFAULT_MAX_RES = 480; // Default MSE quality cap when the app has not picked one yet.

    function mseActive() {
        return !!mse && !mse.dead;
    }

    // Tears down the MSE pipeline: timers, in-flight XHR, SourceBuffer, blob.
    // The video element itself is handled by the caller (clear()/src swap).
    function stopMse() {
        var state = mse;
        if (!state) return;
        mse = null;
        state.dead = true;
        if (state.pollTimer) {
            w.clearTimeout(state.pollTimer);
            state.pollTimer = 0;
        }
        if (state.xhr) {
            try { state.xhr.abort(); } catch (eAbort) {}
            state.xhr = null;
        }
        try {
            if (state.sb && state.onUpdateEnd) state.sb.removeEventListener('updateend', state.onUpdateEnd);
        } catch (eSb) {}
        try {
            if (state.ms && state.ms.readyState === 'open') state.ms.abort();
        } catch (eMs) {}
        if (state.blobUrl) {
            try { w.URL.revokeObjectURL(state.blobUrl); } catch (eRev) {}
            state.blobUrl = '';
        }
        bridgeDebugLog('mse_stopped', {});
    }

    // Parses an HLS media playlist for MSE pumping: init segment (EXT-X-MAP),
    // media segments with durations, live/VOD markers. Segment URIs may be
    // relative (VOD playlists) and are resolved against the playlist URL.
    function parseMsePlaylist(text, baseUrl) {
        var out = {initUri: '', segs: [], endList: false, mediaSeq: 0, targetDur: 6, byterange: false};
        if (!text || typeof text !== 'string') return out;
        var lines = text.replace(/\r/g, '').split('\n');
        var pendingDur = 0;
        var i;
        for (i = 0; i < lines.length; i++) {
            var line = lines[i] ? lines[i].trim() : '';
            if (!line) continue;
            if (line.charAt(0) === '#') {
                if (line.indexOf('#EXT-X-MAP:') === 0) {
                    var um = line.match(/URI="([^"]+)"/);
                    if (um && um[1]) out.initUri = toAbsoluteUrl(um[1], baseUrl);
                } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
                    out.endList = true;
                } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
                    out.mediaSeq = parseInt(line.substring(line.indexOf(':') + 1), 10) || 0;
                } else if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
                    out.targetDur = parseFloat(line.substring(line.indexOf(':') + 1)) || 6;
                } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
                    out.byterange = true; // byte-range segments unsupported -> stay native
                } else if (line.indexOf('#EXTINF:') === 0) {
                    pendingDur = parseFloat(line.substring(8)) || 0;
                }
                continue;
            }
            if (line.indexOf(' ') !== -1) continue;
            if (line.indexOf('http') === 0 || line.charAt(0) === '/' || /^[A-Za-z0-9_.-]/.test(line)) {
                out.segs.push({url: toAbsoluteUrl(line, baseUrl), dur: pendingDur});
                pendingDur = 0;
            }
        }
        return out;
    }

    // Fetches playlist text (master/media/variant) through the local luna
    // service — the only path that works: these hosts omit CORS headers for
    // our origin, and variant hosts reject the browser's Origin with 403.
    function fetchPlaylistText(url, timeoutMs, cb) {
        var meta = buildNetworkRequestMeta(url, 'GET', '');
        callUsherPlaylistService(meta, timeoutMs || MSE_PROBE_TIMEOUT_MS, function (result, reason) {
            if (result && result.status === 200 && hasUsablePlaylistBody(result.responseText)) {
                cb(null, result.responseText);
            } else {
                cb(reason || 'playlist_fetch_failed', '');
            }
        });
    }

    // Fetches one media segment as an ArrayBuffer. Page XHR first (live
    // segment hosts send ACAO:*); on CORS failure retry through the same
    // origin /sttv_proxy route (VOD cloudfront hosts send no ACAO header).
    function fetchMseSegment(state, segUrl, cb) {
        if (mse !== state || state.dead) return;
        var done = false;
        var x = null;
        var finish = function (err, data) {
            if (done) return;
            done = true;
            state.xhr = null;
            cb(err, data);
        };
        var viaProxy = function () {
            if (done) return;
            if (mse !== state || state.dead) { finish('stale', null); return; }
            var origin = w.location && w.location.origin ? w.location.origin : '';
            if (!origin || origin.indexOf('http') !== 0) { finish('cors_no_proxy', null); return; }
            var px = new XMLHttpRequest();
            state.xhr = px;
            try {
                px.open('GET', origin + '/sttv_proxy?url=' + encodeURIComponent(segUrl), true);
                px.responseType = 'arraybuffer';
                px.onload = function () {
                    if (px.status === 200 && px.response && px.response.byteLength) finish(null, px.response);
                    else finish('proxy_status_' + px.status, null);
                };
                px.onerror = function () { finish('proxy_error', null); };
                px.onabort = function () { finish('proxy_abort', null); };
                px.send();
            } catch (eProxy) {
                finish('proxy_send', null);
            }
        };
        x = new XMLHttpRequest();
        state.xhr = x;
        try {
            x.open('GET', segUrl, true);
            x.responseType = 'arraybuffer';
            x.onload = function () {
                if (x.status === 200 && x.response && x.response.byteLength) finish(null, x.response);
                else viaProxy();
            };
            x.onerror = viaProxy;
            x.onabort = function () { finish('abort', null); };
            x.send();
        } catch (eOpen) {
            viaProxy();
        }
    }

    // Chrome 38's MP4 parser rejects boxes it does not know — Twitch inserts
    // `emsg` ID3 metadata boxes (spec'd in 2015) at media segment top level,
    // and the append then fails with MEDIA_ERR_DECODE and garbage timestamps
    // (buffered shows nonsense ranges like 62.0-62.1). Keep only the boxes
    // this parser definitely understands; unknown ones are metadata-only and
    // safe to drop for playback.
    var MSE_KEEP_BOXES = {ftyp: 1, styp: 1, moov: 1, moof: 1, mdat: 1, sidx: 1, free: 1, skip: 1};
    function readBoxHeader(view, o) {
        var size = ((view[o] << 24) | (view[o + 1] << 16) | (view[o + 2] << 8) | view[o + 3]) >>> 0;
        var hdr = 8;
        if (size === 1) {
            if (o + 16 > view.length) return null;
            var hi = ((view[o + 8] << 24) | (view[o + 9] << 16) | (view[o + 10] << 8) | view[o + 11]) >>> 0;
            var lo = ((view[o + 12] << 24) | (view[o + 13] << 16) | (view[o + 14] << 8) | view[o + 15]) >>> 0;
            size = hi * 4294967296 + lo;
            hdr = 16;
        } else if (size === 0) {
            size = view.length - o; // box extends to end of file
        }
        if (size < hdr || o + size > view.length) return null;
        var type = String.fromCharCode(view[o + 4], view[o + 5], view[o + 6], view[o + 7]);
        return {size: size, hdr: hdr, type: type};
    }
    function sanitizeMseSegment(buf) {
        try {
            if (!buf || !buf.byteLength || buf.byteLength < 8) return buf;
            var view = new Uint8Array(buf);
            var o = 0;
            var count = 0;
            var needCopy = false;
            while (o + 8 <= view.length && count++ < 1024) {
                var box = readBoxHeader(view, o);
                if (!box) return buf; // malformed walk: hand back as-is
                if (!MSE_KEEP_BOXES[box.type]) needCopy = true;
                o += box.size;
            }
            if (!needCopy) return buf;
            var parts = [];
            o = 0;
            count = 0;
            while (o + 8 <= view.length && count++ < 1024) {
                var b2 = readBoxHeader(view, o);
                if (!b2) return buf;
                if (MSE_KEEP_BOXES[b2.type]) parts.push(view.subarray(o, o + b2.size));
                o += b2.size;
            }
            if (!parts.length) return buf;
            var total = 0;
            var pi;
            for (pi = 0; pi < parts.length; pi++) total += parts[pi].length;
            var out = new Uint8Array(total);
            var off = 0;
            for (pi = 0; pi < parts.length; pi++) {
                out.set(parts[pi], off);
                off += parts[pi].length;
            }
            bridgeDebugLog('mse_segment_sanitized', {from: buf.byteLength, to: out.byteLength});
            return out.buffer;
        } catch (e) {
            return buf;
        }
    }

    // Chrome 38 (media/formats/mp4/mp4_stream_parser.cc @38.0.2125.122) reads
    // sample data at moof_position + trun.data_offset and parses truns with
    // the LEGACY flag table (data-offset=0x1, first-sample-flags=0x4,
    // duration=0x100, size=0x200, flags=0x400) as per-sample rows. Twitch's
    // truns parse correctly under that table, but some custom-stack segments
    // ship a track layout where the second track's data_offset overlaps the
    // first track's data by a byte (audio sizes sum to N, video starts at
    // N-1): every video sample then reads one byte early, the Annex-B length
    // fields decode as garbage and the pipeline dies with MEDIA_ERR_DECODE,
    // freezing all buffered ranges. Detect overlapping track runs per moof
    // and shift the affected data_offsets so runs are contiguous. No-op for
    // well-formed segments. Chrome 38 also hard-rejects tfhd with an explicit
    // base-data-offset ("RCHECK(!(flags & 0x1))"), so offsets must stay
    // moof-relative.
    function mseRd32(v, o) {
        return ((v[o] << 24) | (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3]) >>> 0;
    }
    function mseWr32(v, o, n) {
        v[o] = (n >>> 24) & 255;
        v[o + 1] = (n >>> 16) & 255;
        v[o + 2] = (n >>> 8) & 255;
        v[o + 3] = n & 255;
    }
    function parseTrafRunForOverlap(v, trafOff, trafSize) {
        var p = trafOff + 8;
        var end = trafOff + trafSize;
        var doVal = -1;
        var doPos = -1;
        var total = 0;
        var trunCount = 0;
        var g = 0;
        while (p + 8 <= end && g++ < 8) {
            var box = readBoxHeader(v, p);
            if (!box) return null;
            if (box.type === 'trun') {
                trunCount++;
                if (trunCount > 1) return null;
                var version = v[p + 8];
                var flags = ((v[p + 9] << 16) | (v[p + 10] << 8) | v[p + 11]) & 0xffffff;
                if (version !== 0) return null;
                var hasDo = (flags & 0x1) !== 0;
                var hasFsf = (flags & 0x4) !== 0;
                var hasDur = (flags & 0x100) !== 0;
                var hasSize = (flags & 0x200) !== 0;
                var hasFlags = (flags & 0x400) !== 0;
                var hasCts = (flags & 0x800) !== 0;
                if (!hasDo || !hasSize) return null;
                var count = mseRd32(v, p + 12);
                var row = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCts ? 4 : 0);
                if (row === 0 || count === 0) return null;
                var dataStart = p + 16 + (hasDo ? 4 : 0) + (hasFsf ? 4 : 0);
                if (dataStart + row * count !== p + box.size) return null;
                doVal = mseRd32(v, p + 16);
                doPos = p + 16;
                var sizeOff = hasDur ? 4 : 0;
                var si;
                for (si = 0; si < count; si++) {
                    total += mseRd32(v, dataStart + si * row + sizeOff);
                }
            }
            p += box.size;
        }
        if (trunCount !== 1 || doPos < 0) return null;
        return {do: doVal, total: total, doPos: doPos};
    }
    function fixMseTrackOverlaps(buf) {
        try {
            if (!buf || buf.byteLength < 24) return buf;
            var v = new Uint8Array(buf);
            var o = 0;
            var g = 0;
            while (o + 8 <= v.length && g++ < 600) {
                var box = readBoxHeader(v, o);
                if (!box) return buf;
                if (box.type === 'moof') {
                    var entries = [];
                    var p = o + box.hdr;
                    var end = o + box.size;
                    var g2 = 0;
                    while (p + 8 <= end && g2++ < 30) {
                        var b2 = readBoxHeader(v, p);
                        if (!b2) return buf;
                        if (b2.type === 'traf') {
                            var info = parseTrafRunForOverlap(v, p, b2.size);
                            if (!info) return buf; // unexpected layout: leave segment untouched
                            entries.push(info);
                        }
                        p += b2.size;
                    }
                    if (entries.length > 1) {
                        entries.sort(function (a, b) { return a.do - b.do; });
                        var k;
                        var fixed = 0;
                        for (k = 1; k < entries.length; k++) {
                            var prevEnd = entries[k - 1].do + entries[k - 1].total;
                            if (entries[k].do < prevEnd) {
                                mseWr32(v, entries[k].doPos, prevEnd);
                                entries[k].do = prevEnd;
                                fixed++;
                            }
                        }
                        if (fixed > 0) bridgeDebugLog('mse_overlap_fixed', {runs: fixed});
                    }
                }
                o += box.size;
            }
            return buf;
        } catch (eFix) {
            return buf;
        }
    }
    // Track timescales (track id -> mdhd timescale) from an init segment.
    function mseWalkFindTimescales(v) {
        var out = {};
        var walk = function (start, end, depth) {
            if (depth > 6) return;
            var p = start;
            var g = 0;
            while (p + 8 <= end && g++ < 500) {
                var box = readBoxHeader(v, p);
                if (!box) return;
                if (box.type === 'trak') {
                    var track = 0;
                    var sc = 0;
                    var q = p + box.hdr;
                    var g2 = 0;
                    while (q + 8 <= p + box.size && g2++ < 40) {
                        var b2 = readBoxHeader(v, q);
                        if (!b2) break;
                        if (b2.type === 'tkhd') {
                            var ver = v[q + b2.hdr];
                            track = mseRd32(v, q + b2.hdr + (ver === 0 ? 12 : 20));
                        } else if (b2.type === 'mdia') {
                            var r = q + b2.hdr;
                            var g3 = 0;
                            while (r + 8 <= q + b2.size && g3++ < 40) {
                                var b3 = readBoxHeader(v, r);
                                if (!b3) break;
                                if (b3.type === 'mdhd') {
                                    var ver3 = v[r + b3.hdr];
                                    sc = ver3 === 0 ? mseRd32(v, r + b3.hdr + 12) : mseRd32(v, r + b3.hdr + 20);
                                }
                                r += b3.size;
                            }
                        }
                        q += b2.size;
                    }
                    if (track && sc) out[track] = sc;
                }
                if (box.type === 'moov' || box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl') {
                    walk(p + box.hdr, p + box.size, depth + 1);
                }
                p += box.size;
            }
        };
        walk(0, v.length, 0);
        return out;
    }
    // First-fragment media start in seconds (min over tracks of tfdt/timescale)
    // from the init + first media segment. Used to shift MSE timestamps to a
    // 0-based timeline (Twitch media often starts at an absolute offset while
    // the app's resume seek, EXTINF duration and progress UI are 0-based).
    function computeMediaStart(initBuf, mediaBuf) {
        try {
            if (!initBuf || !mediaBuf) return 0;
            var tsMap = mseWalkFindTimescales(new Uint8Array(initBuf));
            var v = new Uint8Array(mediaBuf);
            var best = 0;
            var o = 0;
            var g = 0;
            while (o + 8 <= v.length && g++ < 600) {
                var box = readBoxHeader(v, o);
                if (!box) return 0;
                if (box.type === 'moof') {
                    var p = o + box.hdr;
                    var g2 = 0;
                    while (p + 8 <= o + box.size && g2++ < 30) {
                        var b2 = readBoxHeader(v, p);
                        if (!b2) break;
                        if (b2.type === 'traf') {
                            var track = 0;
                            var bmdt = 0;
                            var q = p + b2.hdr;
                            var g3 = 0;
                            while (q + 8 <= p + b2.size && g3++ < 20) {
                                var b3 = readBoxHeader(v, q);
                                if (!b3) break;
                                if (b3.type === 'tfhd') track = mseRd32(v, q + b3.hdr + 4);
                                if (b3.type === 'tfdt') {
                                    var ver = v[q + b3.hdr];
                                    bmdt = ver === 1 ? Number(mseRd32(v, q + b3.hdr + 4)) * 4294967296 + mseRd32(v, q + b3.hdr + 8) : mseRd32(v, q + b3.hdr + 4);
                                }
                                q += b3.size;
                            }
                            var sc = tsMap[track];
                            if (sc > 0 && bmdt > 0) {
                                var secs = bmdt / sc;
                                if (best === 0 || secs < best) best = secs;
                            }
                        }
                        p += b2.size;
                    }
                    break;
                }
                o += box.size;
            }
            return Math.round(best * 1000) / 1000;
        } catch (e) {
            return 0;
        }
    }

    // Attaches the native HLS source to the main video (MPEG-TS channels).
    function attachNativeMain() {
        if (!mv) return;
        mv.src = ms.uri;
        applyMainLayout();
        show(mv);
        try { mv.load(); } catch (eLoad) {}
    }

    // Same as attachNativeMain but with an explicit URI (used for the local
    // remux playlist so ms.rawUri/ms.uri keep pointing at the real stream).
    function attachNativeMainTo(uri) {
        if (!mv) return;
        // CORS-mode fetch for the local remux server only: tv-serve sends
        // ACAO * on every response, and crossorigin=anonymous is what makes
        // canvas readback (drawImage + toDataURL) of frames possible -
        // response headers alone do not untaint in no-cors mode. Direct
        // Twitch URLs stay no-cors (they may lack CORS headers).
        try {
            if (uri && uri.indexOf(REMUX_BASE) === 0) {
                mv.crossOrigin = 'anonymous';
            } else if (mv.crossOrigin) {
                mv.crossOrigin = '';
            }
        } catch (eCo) {}
        mv.src = uri;
        applyMainLayout();
        show(mv);
        try { mv.load(); } catch (eLoad) {}
    }

    // --- fMP4 -> local TS remux -------------------------------------------
    // webOS 3.4 (Chrome 38) cannot decode fMP4 in any path: MSE ingests it
    // but emits zero samples / dies at init, and the platform HLS player
    // demuxes it without ever producing a frame. MPEG-TS native HLS plays
    // flawlessly, so the TV-local node server (tools/tv-serve.js, port 8099)
    // transmuxes fMP4 segments to TS and serves a local HLS playlist that
    // the platform player consumes like any TS channel. Chrome 38 allows the
    // required mixed content (https page -> http://127.0.0.1) for both the
    // health XHR and the media element. Falls back to the MSE path only when
    // the local server is not running.
    var REMUX_BASE = 'http://127.0.0.1:8099';

    function remuxUrlFor(originalUrl) {
        return REMUX_BASE + '/hls/master.m3u8?u=' + encodeURIComponent(originalUrl);
    }

    function startRemuxNative(probeUrl, gen, parsed) {
        var settled = false;
        var healthRetried = false;
        function checkHealth() {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', REMUX_BASE + '/health', true);
                xhr.timeout = 2500;
                xhr.onload = function () {
                    finish(xhr.status === 200 && String(xhr.responseText || '').indexOf('ok') !== -1);
                };
                xhr.onerror = function () {
                    finish(false);
                };
                xhr.ontimeout = function () {
                    finish(false);
                };
                xhr.send();
            } catch (eRemux) {
                finish(false);
            }
        }
        function finish(ok) {
            if (settled) return;
            if (gen !== mainDetectGen) {
                settled = true;
                return; // superseded by a newer start
            }
            if (ok) {
                settled = true;
                w.clearTimeout(timer);
                bridgeDebugLog('remux_native_start', {url: String(probeUrl).substring(0, 90)});
                attachNativeMainTo(remuxUrlFor(probeUrl));
                return;
            }
            if (!healthRetried) {
                // The server only lives while the app is open and has an
                // idle self-stop: kick it once and re-check before falling
                // back to the (non-decoding) MSE path.
                healthRetried = true;
                w.clearTimeout(timer);
                bridgeDebugLog('remux_server_down_retry', {});
                ensureSttvServe();
                timer = w.setTimeout(checkHealth, 3500);
                return;
            }
            settled = true;
            w.clearTimeout(timer);
            bridgeDebugLog('remux_server_down', {});
            if (ms.uri !== probeUrl) ms.uri = probeUrl; // align quality logic
            startMse(parsed, probeUrl, 0);
        }
        var timer = w.setTimeout(checkHealth, 2500);
    }

    // --- sttv_serve lifecycle: start with the app page, stop on close ------
    // The remux server is intentionally NOT part of the boot chain: it lives
    // only while SmartTwitch is open - started by the wrapper on a manual
    // app open, re-ensured here after page reloads, and stopped on page
    // teardown (app close) so it never keeps running in the background.
    //
    // NOTE on the guard: hb exec runs commands as `/bin/sh -c "<cmd>"`, so a
    // `pgrep -f sttv_serve.js` guard self-matches the shell's own cmdline
    // (it contains the script name) and the nohup branch NEVER ran. The start
    // guard therefore checks the listening port instead (netstat output has
    // no cmdline collision), and stop uses the bracket trick so pkill cannot
    // match its own shell.
    var STTV_SERVE_START_CMD =
        "netstat -ltn 2>/dev/null | grep -q ':8099' || " +
        '(cd /media/developer/sttv_stage && nohup node sttv_serve.js 8099 >/dev/null 2>&1 &)';
    var STTV_SERVE_STOP_CMD = "pkill -f 'sttv[_]serve' || true";
    function sttvServeExec(command) {
        try {
            if (typeof w.PalmServiceBridge !== 'function') return false;
            var b = new w.PalmServiceBridge();
            b.onservicecallback = function () {};
            b.call('luna://org.webosbrew.hbchannel.service/exec', JSON.stringify({command: command}));
            return true;
        } catch (e) {
            bridgeDebugLog('sttv_serve_exec_error', {error: String(e)});
            return false;
        }
    }
    function ensureSttvServe() {
        return sttvServeExec(STTV_SERVE_START_CMD);
    }
    function stopSttvServe() {
        return sttvServeExec(STTV_SERVE_STOP_CMD);
    }
    // Heartbeat: while this app page is alive, ping /health every 10s. The
    // server exits after ~90s without a ping, so closing/killing the app (webOS
    // process kills do NOT reliably fire pagehide/beforeunload) stops it for
    // sure; a failed ping means the server is already gone (idle self-stop or
    // suspend) - restart it immediately so fMP4 playback never stays broken.
    var sttvHeartbeatTimerId = 0; // -1 = app is closing, stay stopped
    function sttvServeHeartbeat() {
        if (sttvHeartbeatTimerId === -1) return;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', REMUX_BASE + '/health', true);
            xhr.timeout = 3000;
            var onFail = function () {
                if (sttvHeartbeatTimerId === -1) return; // closing: do not restart
                ensureSttvServe();
            };
            xhr.onload = function () {};
            xhr.onerror = onFail;
            xhr.ontimeout = onFail;
            xhr.send();
        } catch (eHb) {
            ensureSttvServe();
        }
    }
    sttvHeartbeatTimerId = w.setInterval(sttvServeHeartbeat, 10000);

    // --- stall recovery watchdog ------------------------------------------
    // The platform player occasionally wedges on remuxed fMP4 live (audio +
    // video stop, ct pinned at buffered-end+1, loader still downloading) - a
    // platform/HLS live-quirk that survived the EOS-NAL strip. Recovery via
    // RestartPlayer (full probe flow) ONLY for mid-playback wedges: it arms
    // only after real progress (ct >=30) and a >=15s frozen clock, then resets
    // its progress bar so it cannot hot-loop during warm-up (a re-attach needs
    // ~10-20s to start advancing; restarting before that starves playback
    // forever). An attach-phase stall (never reached30s) retries at most once
    // every2 minutes.
    var sttvStallLastCt = -1;
    var sttvStallSince = 0;
    var sttvStallLastRestart = 0;
    var sttvStallBestCt = 0;
    var sttvStallLastSeek = 0;
    var sttvStallSeeks = 0;
    function sttvStallWatchdog() {
        try {
            var v = mv;
            if (!v || !v.src || v.paused) {
                sttvStallSince = 0;
                sttvStallLastCt = -1;
                return;
            }
            var ct = v.currentTime || 0;
            // REAL progress = new personal best. Only this counts as recovery;
            // backward seek movement must not reset the stall clock (otherwise
            // the gap-buster can cycle forever: seek -> one frame -> stall ->
            // seek ... which shows as frame-by-frame slideshow with no audio).
            if (ct > sttvStallBestCt + 0.5) {
                sttvStallBestCt = ct;
                sttvStallSince = 0;
                sttvStallLastCt = -1;
                sttvStallSeeks = 0;
                return;
            }
            // Jitter-proof stall clock (whole seconds).
            var key = Math.floor(ct);
            if (key !== sttvStallLastCt) {
                sttvStallLastCt = key;
                if (!sttvStallSince) sttvStallSince = Date.now();
                return;
            }
            if (key <= 0) return;
            var now = Date.now();
            if (!sttvStallSince) {
                sttvStallSince = now;
                return;
            }
            var elapsed = now - sttvStallSince;
            // Gap-buster: ONE attempt per stall episode only (each seek renders
            // as frame+spinner; the restart is the real recovery) and only on
            // genuine stasis with the frontier signature - never during normal
            // frontier-riding play.
            var be = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : -1;
            if (elapsed >= 10000 && be >= 0 && ct > be + 0.5 && now - sttvStallLastSeek >= 6000 && sttvStallSeeks < 1) {
                sttvStallLastSeek = now;
                sttvStallSeeks++;
                var target = Math.max(0, be - 3);
                bridgeDebugLog('stall_gap_seek', {ct: ct, bufEnd: be, to: target, n: sttvStallSeeks});
                try { v.currentTime = target; } catch (eSeek) {}
                return;
            }
            // Restart only after real stasis (>=25s) - by then the single
            // gap-seek attempt has had its chance.
            if (elapsed < 25000) return;
            var armed = sttvStallBestCt >= 30;
            var cooldown = armed ? 15000 : 30000; // attach-phase wedge: retry every30s
            if (now - sttvStallLastRestart < cooldown) return;
            sttvStallLastRestart = now;
            sttvStallSince = 0;
            sttvStallBestCt = 0;
            sttvStallSeeks = 0;
            bridgeDebugLog('stall_recovery_restart', {ct: ct, armed: armed, seeks: sttvStallSeeks});
            try {
                if (w.Android && typeof w.Android.RestartPlayer === 'function') {
                    w.Android.RestartPlayer();
                }
            } catch (eRestart) {
                bridgeDebugLog('stall_recovery_error', {error: String(eRestart)});
            }
        } catch (eWd) {}
    }
    w.setInterval(sttvStallWatchdog, 3000);

    // Starts main playback for ms.uri. Native HLS is attached immediately (no
    // added delay for MPEG-TS channels) while a parallel probe fetches the
    // media playlist; if it is fMP4 we swap to the MSE pump. Generation
    // guarded: any newer start (setMain/SetQuality) abandons stale probes.
    function startMainPlayback() {
        var gen = ++mainDetectGen;
        var url = ms.uri;
        if (!url) return;
        stopMse(); // detach any previous MSE pipeline
        if (ms.type === 3 || mainStreamFormat === 'ts') {
            attachNativeMain(); // clips are direct MP4; TS is known-good here
            return;
        }
        attachNativeMain();
        // Slow-retry budget: when the format probe fails entirely (luna service
        // cold start, WiFi blip), keep re-probing every few seconds instead of
        // giving up - otherwise fMP4 streams stay attached as raw URLs and spin
        // on "loading" forever (typical after a session restore).
        var probeSlowLeft = 8;
        var attemptProbe = function (probeUrl, isVariantProbe, retryLeft) {
            fetchPlaylistText(probeUrl, MSE_PROBE_TIMEOUT_MS, function (err, text) {
                if (gen !== mainDetectGen || ms.uri !== url) return; // superseded
                if (err || !text) {
                    bridgeDebugLog('mse_probe_fail', {error: String(err || 'empty'), retryLeft: retryLeft, slowLeft: probeSlowLeft});
                    if (retryLeft > 0) {
                        w.setTimeout(function () {
                            if (gen !== mainDetectGen || ms.uri !== url) return;
                            attemptProbe(probeUrl, isVariantProbe, retryLeft - 1);
                        }, 2000);
                    } else if (probeSlowLeft > 0) {
                        probeSlowLeft--;
                        w.setTimeout(function () {
                            if (gen !== mainDetectGen || ms.uri !== url) return;
                            attemptProbe(probeUrl, isVariantProbe, 1);
                        }, 8000);
                    }
                    return;
                }
                if (!isVariantProbe && text.indexOf('#EXT-X-STREAM-INF') !== -1) {
                    // Master playlist: resolve to the variant media playlist the
                    // player would use and probe that instead. The segment format
                    // is a per-stream property (transcode stack), so any variant
                    // works, but the quality position wins when already set.
                    var q = parseQ(text, probeUrl);
                    var variantUrl = '';
                    if (ms.qp >= 0 && ms.q[ms.qp] && ms.q[ms.qp].url) variantUrl = ms.q[ms.qp].url;
                    else if (q.length) {
                        // No quality chosen yet: default to the highest variant
                        // at or below MSE_DEFAULT_MAX_RES. A 1080p60 fMP4
                        // segment can be ~10MB; fetching it cold takes longer
                        // than the app's start watchdog allows, while a low
                        // variant starts in seconds (native ABR also ramps up
                        // from a low variant). SetQuality upgrades later.
                        var cap = mainMaxRes > 0 ? mainMaxRes : MSE_DEFAULT_MAX_RES;
                        var pick = null;
                        var qi2;
                        for (qi2 = 0; qi2 < q.length; qi2++) {
                            if (q[qi2].resolution > 0 && q[qi2].resolution <= cap) {
                                pick = q[qi2];
                                break;
                            }
                        }
                        if (!pick) pick = q[q.length - 1];
                        variantUrl = pick.url;
                    }
                    if (variantUrl && variantUrl !== probeUrl) {
                        attemptProbe(variantUrl, true, 1);
                        return;
                    }
                    bridgeDebugLog('mse_probe_master_unresolved', {variants: q.length});
                    return;
                }
                var parsed = parseMsePlaylist(text, probeUrl);
                if (parsed.initUri && parsed.segs.length && !parsed.byterange) {
                    mainStreamFormat = 'fmp4';
                    bridgeDebugLog('mse_probe_fmp4', {segs: parsed.segs.length, vod: !!parsed.endList});
                    if (ms.uri !== probeUrl) ms.uri = probeUrl; // align quality logic with the probed variant
                    startRemuxNative(probeUrl, gen, parsed);
                } else {
                    mainStreamFormat = 'ts';
                    bridgeDebugLog('mse_probe_ts', {segs: parsed.segs.length});
                }
            });
        };
        attemptProbe(url, false, 1);
    }

    // Boots the MSE pipeline for an already-parsed fMP4 media playlist.
    function startMse(parsed, playlistUrl, restarts) {
        if (!mv || !w.MediaSource || !w.URL || typeof w.URL.createObjectURL !== 'function') {
            attachNativeMain();
            return;
        }
        var codecs = '';
        var qi;
        for (qi = 0; qi < ms.q.length; qi++) {
            if (ms.q[qi].url === playlistUrl) {
                codecs = ms.q[qi].codecs;
                break;
            }
        }
        if (!codecs) codecs = 'avc1.4D401F,mp4a.40.2';
        var mime = 'video/mp4; codecs="' + codecs + '"';
        var supported = false;
        try { supported = !!w.MediaSource.isTypeSupported(mime); } catch (eSup) {}
        if (!supported) {
            bridgeDebugLog('mse_unsupported', {mime: mime});
            attachNativeMain();
            return;
        }
        stopMse();
        var state = {
            playlistUrl: playlistUrl,
            mime: mime,
            restarts: restarts || 0,
            ms: null,
            sb: null,
            onUpdateEnd: null,
            blobUrl: '',
            segs: parsed.segs,
            initUri: parsed.initUri || '',
            initPending: !!parsed.initUri,
            initBytes: null,
            pendingIsMedia: false,
            offsetApplied: false,
            targetDur: parsed.targetDur || 6,
            durationMs: 0,
            nextIdx: 0,
            pending: null,
            fetching: false,
            xhr: null,
            lastUrl: '',
            appendCount: 0,
            fetchFails: 0,
            pollFails: 0,
            endList: !!parsed.endList,
            eos: false,
            dead: false,
            pollTimer: 0
        };
        if (state.endList) {
            // VOD: full duration for the progress UI, and start pumping at the
            // segment containing the resume offset so the loadedmetadata
            // resume seek lands inside the buffered range.
            var totalDur = 0;
            var si;
            for (si = 0; si < state.segs.length; si++) totalDur += state.segs[si].dur || parsed.targetDur;
            state.durationMs = Math.round(totalDur * 1000);
            if (ms.resume > 0) {
                var targetSec = ms.resume / 1000;
                var acc = 0;
                var rIdx = 0;
                for (; rIdx < state.segs.length; rIdx++) {
                    var rd = state.segs[rIdx].dur || parsed.targetDur;
                    if (acc + rd > targetSec) break;
                    acc += rd;
                }
                state.nextIdx = Math.min(rIdx, Math.max(0, state.segs.length - 1));
            }
        } else {
            // Live: start near the edge (native HLS behavior), not the oldest
            // segment in the DVR window.
            state.nextIdx = Math.max(0, state.segs.length - 3);
        }
        mse = state;
        var media = new w.MediaSource();
        state.ms = media;
        state.blobUrl = w.URL.createObjectURL(media);
        bridgeDebugLog('mse_blob_created', {
            url: String(state.blobUrl).substring(0, 60),
            srcBefore: String(mv.currentSrc || mv.src || '').substring(0, 50),
            preload: mv.preload,
            display: mv.style.display
        });
        media.addEventListener('sourceopen', function onSourceOpen() {
            if (mse !== state || state.dead) return;
            try {
                media.removeEventListener('sourceopen', onSourceOpen);
                state.sb = media.addSourceBuffer(state.mime);
                state.onUpdateEnd = function () {
                    if (mse !== state || state.dead) return;
                    markMainProgressBaseline();
                    msePump(state);
                };
                state.sb.addEventListener('updateend', state.onUpdateEnd);
                bridgeDebugLog('mse_start', {
                    type: ms.type,
                    segs: state.segs.length,
                    mime: state.mime,
                    restarts: state.restarts,
                    startIdx: state.nextIdx
                });
                mseSchedulePoll(state);
                msePump(state);
            } catch (eSb) {
                bridgeDebugLog('mse_sourcebuffer_error', {error: String((eSb && eSb.message) || eSb)});
                mseFail(state);
            }
        });
        mv.src = state.blobUrl;
        applyMainLayout();
        show(mv);
        try { mv.load(); } catch (eL) {}
        tryPlay(mv);
    }

    // Schedules the next live playlist refresh (chained, never overlapping).
    function mseSchedulePoll(state) {
        if (state.dead || mse !== state || state.endList) return;
        if (state.pollTimer) w.clearTimeout(state.pollTimer);
        state.pollTimer = w.setTimeout(function () {
            state.pollTimer = 0;
            msePollOnce(state);
        }, MSE_POLL_INTERVAL_MS);
    }

    // Refreshes the live playlist: extends the segment list, or restarts the
    // pipeline when the playlist slid past everything already appended.
    function msePollOnce(state) {
        if (mse !== state || state.dead) return;
        fetchPlaylistText(state.playlistUrl, MSE_PROBE_TIMEOUT_MS, function (err, text) {
            if (mse !== state || state.dead) return;
            if (err || !text) {
                state.pollFails++;
                bridgeDebugLog('mse_poll_fail', {fails: state.pollFails, error: String(err || 'empty')});
                if (state.pollFails >= 3) {
                    mseFail(state);
                    return;
                }
                mseSchedulePoll(state);
                return;
            }
            state.pollFails = 0;
            var parsed = parseMsePlaylist(text, state.playlistUrl);
            if (parsed.byterange) {
                mseFail(state);
                return;
            }
            if (parsed.endList) state.endList = true;
            var newSegs = parsed.segs;
            if (!newSegs.length) {
                mseSchedulePoll(state);
                return;
            }
            var pos = -1;
            var k;
            if (state.lastUrl) {
                for (k = 0; k < newSegs.length; k++) {
                    if (newSegs[k].url === state.lastUrl) {
                        pos = k;
                        break;
                    }
                }
            }
            if (state.appendCount > 0 && state.lastUrl && pos === -1) {
                bridgeDebugLog('mse_playlist_jump', {mediaSeq: parsed.mediaSeq, segs: newSegs.length});
                if (state.restarts >= 3) {
                    mseFail(state);
                    return;
                }
                var restarts = state.restarts + 1;
                var url = state.playlistUrl;
                stopMse();
                startMse(parsed, url, restarts);
                return;
            }
            state.segs = newSegs;
            if (pos >= 0) state.nextIdx = pos + 1;
            else if (state.appendCount === 0) state.nextIdx = Math.min(state.nextIdx, newSegs.length);
            msePump(state);
            mseSchedulePoll(state);
        });
    }

    // Appends the next segment when the buffer needs data. Driven by
    // updateend, timeupdate, seeks and the live playlist poll.
    function msePump(state) {
        if (!state || state.dead || mse !== state) return;
        var sb = state.sb;
        if (!sb || sb.updating || state.fetching) return;
        var ct = 0;
        try {
            if (mv && !isNaN(mv.currentTime) && isFinite(mv.currentTime)) ct = mv.currentTime;
        } catch (eCt) {}
        var bStart = -1;
        var bEnd = -1;
        try {
            if (sb.buffered.length) {
                bStart = sb.buffered.start(0);
                bEnd = sb.buffered.end(sb.buffered.length - 1);
            }
        } catch (eBuf) {}
        if (state.pending) {
            var buf = state.pending;
            state.pending = null;
            if (state.pendingIsMedia && !state.offsetApplied && state.initBytes) {
                // Shift the timeline to 0-based before the first media append:
                // resume seeks, EXTINF duration and the progress UI are all
                // 0-based, while Twitch tfdt often starts at an absolute value.
                state.offsetApplied = true;
                var mediaStart = computeMediaStart(state.initBytes, buf);
                if (mediaStart > 0.001) {
                    try {
                        sb.timestampOffset = -mediaStart;
                        bridgeDebugLog('mse_timestamp_offset', {seconds: mediaStart});
                    } catch (eOff) {}
                }
            }
            try {
                sb.appendBuffer(buf);
                state.appendCount++;
                state.fetchFails = 0;
                markMainProgressBaseline();
            } catch (eAppend) {
                if (eAppend && eAppend.name === 'QuotaExceededError' && bStart >= 0) {
                    var keepFrom = Math.max(0, ct - MSE_BUFFER_KEEP_SECONDS);
                    if (keepFrom > bStart + 2) {
                        state.pending = buf;
                        try {
                            sb.remove(bStart, keepFrom);
                            return; // updateend re-enters and retries the append
                        } catch (eRemove) {
                            state.pending = null;
                        }
                    }
                }
                bridgeDebugLog('mse_append_error', {name: String((eAppend && eAppend.name) || eAppend)});
                state.fetchFails++;
                if (state.fetchFails >= MSE_SEGMENT_MAX_FAILS) {
                    mseHandleHardFailure(state);
                    return;
                }
                msePump(state);
                return;
            }
            return;
        }
        var needMore = state.nextIdx < state.segs.length && (bEnd <= 0 || bEnd - ct < MSE_BUFFER_TARGET_SECONDS);
        if (!needMore) {
            if (state.endList && !state.eos && state.nextIdx >= state.segs.length && bEnd > 0 && bEnd - ct < 5) {
                state.eos = true;
                try {
                    state.ms.endOfStream();
                    bridgeDebugLog('mse_end_of_stream', {});
                } catch (eEos) {}
            }
            return;
        }
        var fetchIdx = state.nextIdx;
        var segUrl = '';
        var seg = null;
        if (state.initPending) {
            // The init segment (EXT-X-MAP) must be appended before any media.
            segUrl = state.initUri;
        } else {
            seg = state.segs[fetchIdx];
            if (!seg) return;
            segUrl = seg.url;
        }
        state.fetching = true;
        fetchMseSegment(state, segUrl, function (err, data) {
            state.fetching = false;
            if (mse !== state || state.dead) return;
            if (!state.initPending && state.nextIdx !== fetchIdx) return; // a seek or poll moved the cursor
            if (err || !data) {
                state.fetchFails++;
                bridgeDebugLog('mse_segment_fail', {idx: fetchIdx, init: state.initPending, fails: state.fetchFails, error: String(err || 'empty')});
                if (state.fetchFails >= MSE_SEGMENT_MAX_FAILS) {
                    mseHandleHardFailure(state);
                    return;
                }
                w.setTimeout(function () { msePump(state); }, 300 * state.fetchFails);
                return;
            }
            state.fetchFails = 0;
            if (state.initPending) {
                state.initPending = false;
                state.initBytes = data;
                state.pendingIsMedia = false;
                state.pending = sanitizeMseSegment(data);
                msePump(state);
                return;
            }
            state.lastUrl = seg.url;
            state.nextIdx = fetchIdx + 1;
            state.pendingIsMedia = true;
            state.pending = fixMseTrackOverlaps(sanitizeMseSegment(data));
            msePump(state);
        });
    }

    // Hard failure (segment fetches/appends exhausted): restart the pipeline
    // up to 3 times, then escalate to the upstream failure handler.
    function mseHandleHardFailure(state) {
        if (mse !== state) return;
        if ((state.restarts || 0) < 3) {
            var restarts = (state.restarts || 0) + 1;
            var url = state.playlistUrl;
            bridgeDebugLog('mse_restart', {restarts: restarts, reason: 'hard_failure'});
            restartMseForUrl(url, restarts);
            return;
        }
        mseFail(state);
    }

    // Re-fetches the media playlist and boots a fresh pipeline (used after
    // hard failures and playlist jumps).
    function restartMseForUrl(playlistUrl, restarts) {
        var gen = mainDetectGen;
        stopMse();
        fetchPlaylistText(playlistUrl, MSE_PROBE_TIMEOUT_MS, function (err, text) {
            if (gen !== mainDetectGen) return; // a newer stream started meanwhile
            if (err || !text) {
                bridgeDebugLog('mse_restart_fetch_fail', {error: String(err || 'empty')});
                handleMainPlaybackFailure(1, 0);
                return;
            }
            var parsed = parseMsePlaylist(text, playlistUrl);
            if (!parsed.initUri || !parsed.segs.length) {
                mainStreamFormat = 'ts';
                attachNativeMain();
                return;
            }
            startMse(parsed, playlistUrl, restarts);
        });
    }

    // Keeps the pump aligned after seeks: VOD jumps move the segment cursor;
    // live seeks behind the buffered start are clamped forward.
    function mseHandleSeek(state) {
        if (!state || state.dead || mse !== state || !state.sb) return;
        var ct = 0;
        try { ct = mv.currentTime; } catch (eCt) {}
        var bStart = -1;
        var bEnd = -1;
        try {
            if (state.sb.buffered.length) {
                bStart = state.sb.buffered.start(0);
                bEnd = state.sb.buffered.end(state.sb.buffered.length - 1);
            }
        } catch (eBuf) {}
        if (state.endList) {
            if (bEnd >= 0 && ct > bEnd + 1) {
                var idx = mseIndexForTime(state, ct);
                if (idx >= state.nextIdx) {
                    state.nextIdx = idx;
                    state.pending = null;
                }
            } else if (bStart >= 0 && ct < bStart - 0.5) {
                var idxBack = mseIndexForTime(state, ct);
                if (idxBack >= 0 && idxBack < state.nextIdx) {
                    state.nextIdx = idxBack;
                    state.pending = null;
                }
            }
        } else if (bStart >= 0 && ct < bStart) {
            try { mv.currentTime = bStart + 0.5; } catch (eSeek) {}
        }
        msePump(state);
    }

    // Segment index whose cumulative duration contains time t (VOD timelines
    // start at 0; falls back to the playlist target duration).
    function mseIndexForTime(state, t) {
        var acc = 0;
        var i;
        for (i = 0; i < state.segs.length; i++) {
            var d = state.segs[i].dur || state.targetDur;
            if (acc + d > t) return i;
            acc += d;
        }
        return state.segs.length - 1;
    }

    // Escalates an unrecoverable MSE failure to the upstream failure handler.
    function mseFail(state) {
        if (mse !== state) return;
        bridgeDebugLog('mse_failed', {restarts: state.restarts || 0});
        stopMse();
        handleMainPlaybackFailure(1, 0);
    }

    // =========================================================================
    // Network Layer
    // =========================================================================
    // Android: OkHttp handles networking with connection pooling, retries, caching.
    // webOS:   XHR-based with manual circuit-breaker per host, response caching,
    //          RTT tracking, request deduplication, and DNS filter detection.
    //
    // IMPORTANT: Synchronous XHR (sync=true in xhrReq) is required for
    // mMethodUrlHeaders compatibility. The upstream app calls this synchronously
    // for token/playlist fetches. Cannot be converted to async without upstream
    // changes, which are forbidden by architecture rules. This blocks the main
    // thread during the HTTP round-trip — an accepted trade-off for compatibility.

    // Resolves HTTP method and body from post-message and method params.
    function resolveRequestMethodAndBody(pm, m) {
        var method = m ? String(m).toUpperCase() : null;
        var body = pm;
        if (!method && typeof body === 'string') {
            var maybe = body.toUpperCase();
            if (maybe === 'GET' || maybe === 'POST' || maybe === 'PUT' || maybe === 'DELETE') {
                method = maybe;
                body = null;
            }
        }
        if (!method) method = body ? 'POST' : 'GET';
        return {method: method, body: body};
    }
    function normalizeHeadersInput(headers) {
        if (!headers) return [];
        if (Array.isArray(headers)) return headers;
        if (typeof headers === 'string') return safeParse(headers, []);
        if (typeof headers === 'object') {
            var out = [];
            var key;
            for (key in headers) {
                if (Object.prototype.hasOwnProperty.call(headers, key)) {
                    out.push([key, headers[key]]);
                }
            }
            return out;
        }
        return [];
    }
    function setRequestHeaders(xhr, headers) {
        var hs = normalizeHeadersInput(headers);
        var i;
        if (Array.isArray(hs)) for (i = 0; i < hs.length; i++) if (hs[i] && hs[i].length > 1) try { xhr.setRequestHeader(hs[i][0], hs[i][1]); } catch (e) {}
    }
    function safeParseRequestMeta(rawUrl) {
        var source = rawUrl ? String(rawUrl) : '';
        var host = '';
        var path = '';
        try {
            if (typeof w.URL === 'function') {
                var parsed = new w.URL(source, w.location && w.location.href ? w.location.href : undefined);
                host = parsed.host || '';
                path = parsed.pathname || '/';
            }
        } catch (e) {}
        if (!host) {
            var lower = source.toLowerCase();
            var stripped = lower.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
            var slashIndex = stripped.indexOf('/');
            if (slashIndex >= 0) {
                host = stripped.slice(0, slashIndex);
                path = stripped.slice(slashIndex) || '/';
            } else {
                host = stripped;
                path = '/';
            }
            var atIndex = host.lastIndexOf('@');
            if (atIndex >= 0) host = host.slice(atIndex + 1);
            var portIndex = host.indexOf(':');
            if (portIndex >= 0) host = host.slice(0, portIndex);
        }
        host = (host || '').toLowerCase();
        path = path || '/';
        return {
            url: source,
            host: host,
            path: path,
            pathLower: path.toLowerCase()
        };
    }
    function isHighRiskHost(host) {
        if (!host) return false;
        return (
            host.indexOf('ttvnw.net') !== -1 ||
            host.indexOf('twitch.tv') !== -1 ||
            host.indexOf('ttv.lol') !== -1 ||
            host.indexOf('kwabang.net') !== -1 ||
            host.indexOf('ontdb.com') !== -1
        );
    }
    function isCoreTwitchHost(host) {
        if (!host) return false;
        var h = String(host).toLowerCase();
        return h.indexOf('ttvnw.net') !== -1 || h.indexOf('twitch.tv') !== -1;
    }
    function isCircuitExcludedHost(host, pathLower) {
        var h = (host || '').toLowerCase();
        var p = pathLower || '';
        if (!h) return false;
        // Keep playback/auth hosts out of breaker to avoid false "offline" states.
        if (isCoreTwitchHost(h)) return true;
        if (h === 'api.twitch.tv' || h === 'gql.twitch.tv') return true;
        if (h.indexOf('twitch.tv') !== -1 && p === '/gql') return true;
        return false;
    }
    function extractHlsId(pathLower) {
        if (!pathLower) return '';
        var match = pathLower.match(/\/(?:hls|playlist|hls-raw|vod)\/([^\/\?]+)\.m3u8/);
        if (match && match[1]) return match[1];
        match = pathLower.match(/\/api\/channel\/hls\/([^\/\?]+)\.m3u8/);
        if (match && match[1]) return match[1];
        return '';
    }
    function extractGqlKey(body) {
        if (!body || typeof body !== 'string') return '';
        var loginMatch = body.match(/"login"\s*:\s*"([^"]+)"/i);
        if (loginMatch && loginMatch[1]) return loginMatch[1].toLowerCase();
        var vodMatch = body.match(/"vodid"\s*:\s*"([^"]+)"/i);
        if (vodMatch && vodMatch[1]) return vodMatch[1].toLowerCase();
        return '';
    }
    // Builds metadata for a network request (host, request key, circuit/dedupe flags).
    function buildNetworkRequestMeta(rawUrl, method, body) {
        var meta = safeParseRequestMeta(rawUrl);
        var host = meta.host;
        var pathLower = meta.pathLower;
        var normalizedMethod = String(method || 'GET').toUpperCase();
        var key = '';
        var gqlHost = host.indexOf('gql.twitch.tv') !== -1 || pathLower === '/gql';
        var hlsId = extractHlsId(pathLower);
        if (gqlHost) {
            var gqlKey = extractGqlKey(body);
            key = 'gql-token:' + (gqlKey || 'global');
        } else if (pathLower.indexOf('.m3u8') !== -1 || pathLower.indexOf('/api/channel/hls/') !== -1) {
            if (host.indexOf('usher.ttvnw.net') !== -1) {
                key = 'hls-playlist:' + (hlsId || 'unknown');
            } else {
                key = 'hls-proxy-playlist:' + (hlsId || 'unknown');
            }
        } else {
            var shortPath = pathLower.split('?')[0] || '/';
            if (shortPath.length > 56) shortPath = shortPath.slice(0, 56);
            key = 'req:' + String(method || 'GET').toUpperCase() + ':' + (host || 'unknown') + ':' + shortPath;
        }
        return {
            host: host,
            url: meta.url || '',
            pathLower: pathLower,
            method: normalizedMethod,
            highRisk: isHighRiskHost(host),
            requestKey: key,
            circuitEnabled: !isCircuitExcludedHost(host, pathLower),
            dedupeEnabled: !isCoreTwitchHost(host)
        };
    }
    function hasUsablePlaylistBody(text) {
        return typeof text === 'string' && text.indexOf('#EXTM3U') !== -1;
    }
    function isUsherPlaylistPath(pathLower) {
        if (!pathLower) return false;
        var normalizedPath = String(pathLower).toLowerCase().split('?')[0];
        if (!/\.m3u8$/.test(normalizedPath)) return false;
        if (normalizedPath.indexOf('/api/channel/hls/') === 0) return true;
        if (normalizedPath.indexOf('/vod/') === 0) return true;
        return false;
    }
    function isUsherPlaylistRequest(meta) {
        if (!meta) return false;
        if (meta.host !== 'usher.ttvnw.net') return false;
        if (!isUsherPlaylistPath(meta.pathLower || '')) return false;
        return String(meta.method || 'GET').toUpperCase() === 'GET';
    }
    // Chrome 38 / webOS 3.4 can only decode H.264 (canPlayType av01 = "" and
    // HEVC variants are unreliable in native HLS). The upstream app requests
    // supported_codecs=av1,h265,h264 based on the synthetic getcodecCapabilities
    // payload, and native ABR may then select an AV1/HEVC variant that never
    // decodes (black video with a growing buffer). Force h264-only on usher
    // playlist URLs so Twitch only advertises variants this browser can play.
    function limitUsherCodecs(rawUrl) {
        if (typeof rawUrl !== 'string' || rawUrl.indexOf('usher.ttvnw.net') === -1) return rawUrl;
        if (rawUrl.indexOf('supported_codecs=') === -1) return rawUrl;
        return rawUrl.replace(/([?&]supported_codecs=)[^&]*/, '$1h264');
    }
    function shouldUseUsherPlaylistCorsFallback(meta, status, text, reason) {
        if (!isUsherPlaylistRequest(meta)) return false;
        var st = parseInt(status, 10) || 0;
        if (st > 0) return false;
        if (hasUsablePlaylistBody(text)) return false;
        if (reason === 'timeout' || reason === 'abort' || reason === 'dedupe_abort' || reason === 'circuit_open') return false;
        return true;
    }
    function buildUsherPlaylistCorsFallbackResult(meta, checkResult, reason) {
        var fallbackUrl = meta && typeof meta.url === 'string' ? meta.url : '';
        bridgeDebugLog('usher_hls_cors_fallback', {
            reason: reason || 'unknown',
            host: meta && meta.host ? meta.host : '',
            url: fallbackUrl
        });
        return {
            status: 200,
            responseText: '',
            checkResult: checkResult || 0,
            url: fallbackUrl,
            synthetic: true
        };
    }
    function getWebOsAppId() {
        try {
            if (w.PalmSystem && w.PalmSystem.identifier) {
                return String(w.PalmSystem.identifier).split(' ')[0] || '';
            }
        } catch (e) {}
        return '';
    }
    function getUsherPlaylistServiceName() {
        var appId = getWebOsAppId();
        if (!appId) return '';
        return appId + USHER_PLAYLIST_SERVICE_ID_SUFFIX;
    }
    function getUsherPlaylistServiceTimeoutMs(timeoutHint) {
        var parsed = parseInt(timeoutHint, 10);
        if (!isFinite(parsed) || parsed <= 0) parsed = USHER_PLAYLIST_SERVICE_TIMEOUT_MS;
        return clamp(parsed, USHER_PLAYLIST_SERVICE_TIMEOUT_MIN_MS, USHER_PLAYLIST_SERVICE_TIMEOUT_MAX_MS);
    }
    function getUsherPlaylistCacheEntry(requestKey) {
        if (!requestKey) return null;
        var entry = usherPlaylistCacheByKey[requestKey];
        if (!entry) return null;
        var savedAt = parseInt(entry.savedAt, 10) || 0;
        if (!savedAt || Date.now() - savedAt > USHER_PLAYLIST_CACHE_TTL_MS) {
            delete usherPlaylistCacheByKey[requestKey];
            return null;
        }
        return entry;
    }
    function cacheUsherPlaylistResult(requestKey, responseText, responseUrl) {
        if (!requestKey || !hasUsablePlaylistBody(responseText)) return;
        usherPlaylistCacheByKey[requestKey] = {
            status: 200,
            responseText: responseText,
            responseUrl: responseUrl || '',
            savedAt: Date.now()
        };
        pruneOldestMapEntries(usherPlaylistCacheByKey, USHER_PLAYLIST_CACHE_MAX);
    }
    function normalizeServicePlaylistResult(rawResult, meta) {
        var payload = rawResult && typeof rawResult === 'object' ? rawResult : {};
        var st = parseInt(payload.status, 10) || 0;
        var text = typeof payload.responseText === 'string' ? payload.responseText : '';
        if (st !== 200 || !hasUsablePlaylistBody(text)) return null;
        var url = typeof payload.url === 'string' && payload.url ? payload.url : meta && meta.url ? meta.url : '';
        return {
            status: 200,
            responseText: text,
            url: url
        };
    }
    function callUsherPlaylistService(meta, timeoutMs, done) {
        var finish = typeof done === 'function' ? done : function () {};
        var serviceName = getUsherPlaylistServiceName();
        if (!serviceName || typeof w.PalmServiceBridge !== 'function') {
            finish(null, 'service_unavailable');
            return;
        }
        var requestUrl = meta && meta.url ? String(meta.url) : '';
        if (!requestUrl) {
            finish(null, 'missing_url');
            return;
        }
        var bridge = null;
        var timerId = 0;
        var settled = false;
        var requestOrigin = '';
        var requestReferer = '';
        var requestUserAgent = '';
        var requestAcceptLanguage = '';
        try {
            if (w.location && typeof w.location.origin === 'string' && /^https?:\/\//i.test(w.location.origin)) {
                requestOrigin = w.location.origin;
                requestReferer = requestOrigin + '/';
            } else if (w.location && typeof w.location.href === 'string' && /^https?:\/\//i.test(w.location.href)) {
                requestReferer = w.location.href;
            }
            if (w.navigator && typeof w.navigator.userAgent === 'string') requestUserAgent = w.navigator.userAgent;
            if (w.navigator) {
                if (Array.isArray(w.navigator.languages) && w.navigator.languages.length) {
                    requestAcceptLanguage = w.navigator.languages.join(',');
                } else if (typeof w.navigator.language === 'string' && w.navigator.language) {
                    requestAcceptLanguage = w.navigator.language;
                }
            }
        } catch (eLoc) {}
        var safeFinish = function (result, reason) {
            if (settled) return;
            settled = true;
            if (timerId) {
                try { w.clearTimeout(timerId); } catch (eClear) {}
                timerId = 0;
            }
            if (bridge) {
                try { bridge.onservicecallback = null; } catch (eCb) {}
                try { bridge.onserviceerror = null; } catch (eCbErr) {}
                try { bridge.cancel(); } catch (eCancel) {}
            }
            bridge = null;
            finish(result, reason || '');
        };
        try {
            bridge = new w.PalmServiceBridge();
        } catch (eBridge) {
            safeFinish(null, 'service_bridge_create_fail');
            return;
        }
        bridge.onservicecallback = function (msg) {
            usherServiceWarm = true;
            var parsed = safeParse(msg, null);
            var normalized = normalizeServicePlaylistResult(parsed, meta);
            if (normalized) {
                safeFinish(normalized, 'service_ok');
                return;
            }
            var reason = 'service_bad_payload';
            if (parsed && typeof parsed === 'object') {
                if (parsed.errorCode) reason = 'service_error_' + String(parsed.errorCode).toLowerCase();
                else if (parsed.status) reason = 'service_status_' + String(parsed.status);
            }
            safeFinish(null, reason);
        };
        bridge.onserviceerror = function (err) {
            // Any bus reply (even an error) proves the service process is up.
            usherServiceWarm = true;
            safeFinish(null, 'service_bus_error_' + String((err && err.errorCode) || 'unknown').toLowerCase());
        };
        timerId = w.setTimeout(function () {
            safeFinish(null, 'service_timeout');
        }, getUsherPlaylistServiceTimeoutMs(timeoutMs) + (usherServiceWarm ? USHER_PLAYLIST_SERVICE_WARM_MARGIN_MS : USHER_PLAYLIST_SERVICE_COLD_GRACE_MS));
        try {
            bridge.call('luna://' + serviceName + '/fetchPlaylist', JSON.stringify({
                url: requestUrl,
                timeoutMs: getUsherPlaylistServiceTimeoutMs(timeoutMs),
                origin: requestOrigin || '',
                referer: requestReferer || '',
                userAgent: requestUserAgent || '',
                acceptLanguage: requestAcceptLanguage || ''
            }));
        } catch (eCall) {
            safeFinish(null, 'service_call_exception');
        }
    }
    // Spawns the local HLS service process at startup. The first service call
    // after boot otherwise pays the node cold-start inside the playback
    // watchdog, which used to surface as a synthetic empty playlist (black
    // screen). The invalid URL is rejected by the service before any network
    // I/O, so this is cheap — it only forces ls2 to launch the process.
    function warmUsherPlaylistService() {
        try {
            if (usherServiceWarm) return;
            if (typeof w.PalmServiceBridge !== 'function') return;
            var serviceName = getUsherPlaylistServiceName();
            if (!serviceName) return;
            var warmBridge = new w.PalmServiceBridge();
            var warmSettled = false;
            var warmFinish = function () {
                if (warmSettled) return;
                warmSettled = true;
                try { warmBridge.onservicecallback = null; } catch (eCb) {}
                try { warmBridge.onserviceerror = null; } catch (eCbErr) {}
                try { warmBridge.cancel(); } catch (eCancel) {}
                warmBridge = null;
            };
            warmBridge.onservicecallback = function () {
                usherServiceWarm = true;
                warmFinish();
            };
            warmBridge.onserviceerror = function () {
                usherServiceWarm = true;
                warmFinish();
            };
            warmBridge.call(
                'luna://' + serviceName + '/fetchPlaylist',
                // Real usher host (rejected quickly upstream without a token):
                // spawns the node process AND warms DNS/TLS to usher.ttvnw.net.
                JSON.stringify({url: 'https://usher.ttvnw.net/vod/1.m3u8', timeoutMs: 4000})
            );
            w.setTimeout(warmFinish, 15000);
        } catch (eWarm) {}
    }
    function flushUsherPlaylistInFlight(requestKey, result, reason) {
        var inFlight = usherPlaylistInFlightByKey[requestKey];
        if (!inFlight) return;
        delete usherPlaylistInFlightByKey[requestKey];
        var callbacks = inFlight.callbacks || [];
        var i;
        for (i = 0; i < callbacks.length; i++) {
            try {
                callbacks[i](result, reason || '');
            } catch (eCb) {}
        }
    }
    function requestUsherPlaylistViaService(meta, timeoutMs, done) {
        var callback = typeof done === 'function' ? done : function () {};
        if (!isUsherPlaylistRequest(meta) || !meta.requestKey) {
            callback(null, 'not_usher_playlist');
            return;
        }
        var cached = getUsherPlaylistCacheEntry(meta.requestKey);
        if (cached) {
            callback({
                status: cached.status || 200,
                responseText: cached.responseText || '',
                url: cached.responseUrl || meta.url || ''
            }, 'cache_hit');
            return;
        }
        if (usherPlaylistInFlightByKey[meta.requestKey]) {
            usherPlaylistInFlightByKey[meta.requestKey].callbacks.push(callback);
            return;
        }
        usherPlaylistInFlightByKey[meta.requestKey] = {
            callbacks: [callback],
            startedAt: Date.now()
        };
        callUsherPlaylistService(meta, timeoutMs, function (result, reason) {
            bridgeDebugLog('usher_hls_service_result', {
                reason: reason || '',
                status: result && result.status ? result.status : 0,
                hasPlaylist: !!(result && hasUsablePlaylistBody(result.responseText || '')),
                url: meta && meta.url ? meta.url : ''
            });
            if (result && result.status === 200 && hasUsablePlaylistBody(result.responseText)) {
                cacheUsherPlaylistResult(meta.requestKey, result.responseText, result.url || meta.url || '');
                cacheNetworkResponse(meta.requestKey, result.status, result.responseText);
            }
            flushUsherPlaylistInFlight(meta.requestKey, result, reason);
        });
    }
    function getEffectiveTimeoutMs(timeout, meta, sync) {
        var defaultCap = sync ? NETWORK_SYNC_MAX_TIMEOUT_MS : NETWORK_MAX_TIMEOUT_MS;
        var parsed = parseInt(timeout, 10);
        if (!isFinite(parsed) || parsed <= 0) parsed = defaultCap;
        var riskCap = sync ? NETWORK_SYNC_HIGH_RISK_TIMEOUT_MS : NETWORK_HIGH_RISK_TIMEOUT_MS;
        var cap = meta && meta.highRisk ? riskCap : defaultCap;
        var effective = parsed > cap ? cap : parsed;
        if (effective < 500) effective = 500;
        return effective;
    }
    function countMapEntries(map) {
        var count = 0;
        var key;
        for (key in map) {
            if (Object.prototype.hasOwnProperty.call(map, key)) count += 1;
        }
        return count;
    }
    function pruneOldestMapEntries(map, maxEntries) {
        if (!map || maxEntries <= 0) return;
        var size = countMapEntries(map);
        if (size <= maxEntries) return;
        var removeCount = size - maxEntries;
        var removed = 0;
        var key;
        for (key in map) {
            if (removed >= removeCount) break;
            if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
            delete map[key];
            removed++;
        }
    }
    function maybePruneNetworkState() {
        var now = Date.now();
        if (networkPruneLastAt > 0 && now - networkPruneLastAt < NETWORK_STATE_PRUNE_INTERVAL_MS) return;
        networkPruneLastAt = now;
        var key;
        for (key in networkInFlightByKey) {
            if (!Object.prototype.hasOwnProperty.call(networkInFlightByKey, key)) continue;
            var inFlight = networkInFlightByKey[key];
            var startedAt = inFlight && inFlight.t ? parseInt(inFlight.t, 10) || 0 : 0;
            if (!startedAt || now - startedAt > NETWORK_MAX_TIMEOUT_MS * 4) delete networkInFlightByKey[key];
        }
        for (key in networkResponseCacheByKey) {
            if (!Object.prototype.hasOwnProperty.call(networkResponseCacheByKey, key)) continue;
            var entry = networkResponseCacheByKey[key];
            var savedAt = entry && entry.savedAt ? parseInt(entry.savedAt, 10) || 0 : 0;
            if (!savedAt || now - savedAt > NETWORK_SYNC_CACHE_STALE_MAX_MS) delete networkResponseCacheByKey[key];
        }
        for (key in usherPlaylistInFlightByKey) {
            if (!Object.prototype.hasOwnProperty.call(usherPlaylistInFlightByKey, key)) continue;
            var playlistInFlight = usherPlaylistInFlightByKey[key];
            var playlistStartedAt = playlistInFlight && playlistInFlight.startedAt ? parseInt(playlistInFlight.startedAt, 10) || 0 : 0;
            if (!playlistStartedAt || now - playlistStartedAt > USHER_PLAYLIST_INFLIGHT_MAX_AGE_MS) {
                flushUsherPlaylistInFlight(key, null, 'pruned');
            }
        }
        for (key in usherPlaylistCacheByKey) {
            if (!Object.prototype.hasOwnProperty.call(usherPlaylistCacheByKey, key)) continue;
            var playlistEntry = usherPlaylistCacheByKey[key];
            var playlistSavedAt = playlistEntry && playlistEntry.savedAt ? parseInt(playlistEntry.savedAt, 10) || 0 : 0;
            if (!playlistSavedAt || now - playlistSavedAt > USHER_PLAYLIST_CACHE_TTL_MS) delete usherPlaylistCacheByKey[key];
        }
        pruneOldestMapEntries(networkResponseCacheByKey, NETWORK_RESPONSE_CACHE_MAX);
        pruneOldestMapEntries(usherPlaylistCacheByKey, USHER_PLAYLIST_CACHE_MAX);
        pruneOldestMapEntries(networkRttByHost, NETWORK_RTT_HOST_MAX);
        pruneOldestMapEntries(networkMediaProbeByHost, NETWORK_PROBE_HOST_MAX);
        pruneOldestMapEntries(networkCircuitByHost, NETWORK_CIRCUIT_HOST_MAX);
    }
    function clearInFlightRequestByKey(key, xhrRef) {
        if (!key) return;
        var current = networkInFlightByKey[key];
        if (!current) return;
        if (xhrRef && current.xhr !== xhrRef) return;
        delete networkInFlightByKey[key];
    }
    function abortInFlightRequestByKey(key) {
        if (!key) return;
        var current = networkInFlightByKey[key];
        if (!current || !current.xhr) return;
        try {
            current.xhr.__sttvAbortReason = 'dedupe';
            if (current.xhr.readyState !== 4) current.xhr.abort();
        } catch (e) {}
        delete networkInFlightByKey[key];
    }
    function registerInFlightRequest(key, xhrRef) {
        if (!key || !xhrRef) return;
        networkInFlightByKey[key] = {
            xhr: xhrRef,
            t: Date.now()
        };
    }
    function getOrCreateCircuitState(host) {
        if (!host) return null;
        var state = networkCircuitByHost[host];
        if (!state) {
            state = {
                failures: [],
                openUntil: 0,
                updatedAt: Date.now()
            };
            networkCircuitByHost[host] = state;
        }
        state.updatedAt = Date.now();
        return state;
    }
    function pruneCircuitFailures(state, now) {
        if (!state || !state.failures) return;
        var cutoff = now - NETWORK_CIRCUIT_FAIL_WINDOW_MS;
        var next = [];
        var i;
        for (i = 0; i < state.failures.length; i++) {
            if (state.failures[i] >= cutoff) next.push(state.failures[i]);
        }
        state.failures = next;
    }
    function isCircuitOpenForHost(host) {
        if (isCircuitExcludedHost(host, '')) return false;
        var now = Date.now();
        var state = getOrCreateCircuitState(host);
        if (!state) return false;
        if (state.openUntil && state.openUntil > now) return true;
        if (state.openUntil && state.openUntil <= now) {
            state.openUntil = 0;
            state.failures = [];
        }
        return false;
    }
    function showNetworkFilteringWarningOnce() {
        if (networkFilterWarningShown) return;
        networkFilterWarningShown = true;
        var message = 'Network filtering detected. Some playback requests may fail.';
        if (!call('Main_showWarningMiddleDialog', [message, 5000])) {
            if (w.Android && typeof w.Android.showToast === 'function') {
                w.Android.showToast(message);
            }
        }
    }
    function recordHostCircuitSuccess(host) {
        if (!host) return;
        var state = getOrCreateCircuitState(host);
        if (!state) return;
        state.failures.length = 0;
        state.openUntil = 0;
        state.updatedAt = Date.now();
    }
    function recordHostCircuitFailure(host) {
        if (!host) return;
        var now = Date.now();
        var state = getOrCreateCircuitState(host);
        if (!state) return;
        pruneCircuitFailures(state, now);
        state.failures.push(now);
        state.updatedAt = now;
        if (state.failures.length >= NETWORK_CIRCUIT_FAIL_LIMIT) {
            if (!state.openUntil || state.openUntil <= now) {
                state.openUntil = now + NETWORK_CIRCUIT_OPEN_MS;
                showNetworkFilteringWarningOnce();
            }
        }
    }
    function getRttFamilyKey(host) {
        if (!host) return '';
        var h = String(host).toLowerCase();
        if (h.indexOf('ttvnw.net') !== -1) return 'ttvnw.net';
        if (h.indexOf('twitch.tv') !== -1) return 'twitch.tv';
        if (h.indexOf('frankerfacez.com') !== -1) return 'frankerfacez.com';
        if (h.indexOf('7tv.io') !== -1) return '7tv.io';
        return '';
    }
    function cacheNetworkResponse(requestKey, status, responseText) {
        if (!requestKey || !status || status <= 0) return;
        var text = responseText || '';
        if (text.length > NETWORK_RESPONSE_CACHE_MAX_TEXT) text = text.slice(0, NETWORK_RESPONSE_CACHE_MAX_TEXT);
        networkResponseCacheByKey[requestKey] = {
            status: status,
            responseText: text,
            savedAt: Date.now()
        };
    }
    function getCachedNetworkResponse(requestKey) {
        if (!requestKey) return null;
        var entry = networkResponseCacheByKey[requestKey];
        if (!entry) return null;
        var age = Date.now() - (entry.savedAt || 0);
        if (age > NETWORK_SYNC_CACHE_STALE_MAX_MS) {
            delete networkResponseCacheByKey[requestKey];
            return null;
        }
        entry.isStale = age > NETWORK_SYNC_CACHE_MAX_AGE_MS;
        return entry;
    }
    function buildHostProbeUrl(rawUrl, host) {
        if (!host) return '';
        try {
            if (typeof w.URL === 'function') {
                var parsed = new w.URL(rawUrl, w.location && w.location.href ? w.location.href : undefined);
                var proto = parsed.protocol === 'http:' ? 'http:' : 'https:';
                return proto + '//' + parsed.host + '/';
            }
        } catch (e) {}
        return 'https://' + host + '/';
    }
    function maybeProbeMediaHostRtt(video, host) {
        if (!video || !host) return;
        if (networkRttByHost[host] && networkRttByHost[host].avgMs > 0) return;
        var now = Date.now();
        var state = networkMediaProbeByHost[host];
        if (!state) {
            state = {
                lastAt: 0,
                inFlight: false
            };
            networkMediaProbeByHost[host] = state;
        }
        if (state.inFlight) return;
        if (state.lastAt > 0 && now - state.lastAt < NETWORK_MEDIA_PROBE_MIN_INTERVAL_MS) return;
        var sourceUrl = video.currentSrc || video.src || '';
        var probeUrl = buildHostProbeUrl(sourceUrl, host);
        if (!probeUrl) return;
        state.inFlight = true;
        state.lastAt = now;
        var startedAt = now;
        var finished = false;
        var xhr = null;
        var finish = function (ok) {
            if (finished) return;
            finished = true;
            state.inFlight = false;
            state.lastAt = Date.now();
            if (xhr) {
                try {
                    xhr.onreadystatechange = null;
                    xhr.ontimeout = null;
                    xhr.onerror = null;
                    xhr.onabort = null;
                } catch (eHandlers) {}
            }
            xhr = null;
            if (ok) recordNetworkRtt(host, Date.now() - startedAt);
        };
        try {
            xhr = new XMLHttpRequest();
            xhr.open('GET', probeUrl, true);
            try {
                xhr.timeout = NETWORK_MEDIA_PROBE_TIMEOUT_MS;
            } catch (eTimeout) {}
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) finish(true);
            };
            xhr.ontimeout = function () { finish(false); };
            xhr.onerror = function () { finish(false); };
            xhr.onabort = function () { finish(false); };
            xhr.send(null);
        } catch (eOpen) {
            finish(false);
        }
    }
    function recordNetworkRtt(host, elapsedMs) {
        var sample = parseInt(elapsedMs, 10);
        if (!isFinite(sample) || sample <= 0) return;
        if (sample > 120000) sample = 120000;
        if (!networkRttGlobalAvgMs) networkRttGlobalAvgMs = sample;
        else networkRttGlobalAvgMs = networkRttGlobalAvgMs * 0.75 + sample * 0.25;
        if (!host) return;
        if (!networkRttByHost[host]) {
            networkRttByHost[host] = {
                avgMs: sample,
                lastMs: sample,
                count: 1,
                updatedAt: Date.now()
            };
            return;
        }
        var entry = networkRttByHost[host];
        entry.lastMs = sample;
        entry.count = (entry.count || 0) + 1;
        entry.avgMs = entry.avgMs ? entry.avgMs * 0.75 + sample * 0.25 : sample;
        entry.updatedAt = Date.now();
        var family = getRttFamilyKey(host);
        if (!family) return;
        if (!networkRttByFamily[family]) {
            networkRttByFamily[family] = {
                avgMs: sample,
                lastMs: sample,
                count: 1
            };
            return;
        }
        var fam = networkRttByFamily[family];
        fam.lastMs = sample;
        fam.count = (fam.count || 0) + 1;
        fam.avgMs = fam.avgMs ? fam.avgMs * 0.75 + sample * 0.25 : sample;
    }
    function getNetworkRttMsForHost(host) {
        if (!host) return 0;
        if (networkRttByHost[host] && networkRttByHost[host].avgMs > 0) return networkRttByHost[host].avgMs;
        var family = getRttFamilyKey(host);
        if (family && networkRttByFamily[family] && networkRttByFamily[family].avgMs > 0) return networkRttByFamily[family].avgMs;
        if (family && networkRttGlobalAvgMs > 0) return networkRttGlobalAvgMs;
        return 0;
    }
    // Sends an async XHR request and invokes callback with (status, responseText, responseUrl).
    // Android: Android.XmlHttpGetFull() / Android.BasexmlHttpGet() via OkHttp.
    // webOS:   XHR with timeout, circuit-breaker, dedupe, and response caching.
    function sendAsyncRequest(u, to, pm, m, h, cb) {
        u = limitUsherCodecs(u);
        var req = resolveRequestMethodAndBody(pm, m);
        var method = req.method;
        var body = req.body;
        var callback = typeof cb === 'function' ? cb : function () {};
        var meta = buildNetworkRequestMeta(u, method, body);
        var forceServiceFetch = isForceHlsServiceFetchEnabled();
        maybePruneNetworkState();
        var effectiveTimeout = getEffectiveTimeoutMs(to, meta);
        var requestStartedAt = Date.now();
        var x;
        var done = false;
        var serviceAttempted = false;
        var serviceRetried = false;
        // Attempts the local HLS service, retrying once on failure (the first
        // attempt after boot may only get as far as spawning the node process).
        var attemptUsherService = function (failReason) {
            requestUsherPlaylistViaService(meta, effectiveTimeout, function (serviceResult, serviceReason) {
                if (serviceResult && serviceResult.status === 200 && hasUsablePlaylistBody(serviceResult.responseText)) {
                    finish(serviceResult.status, serviceResult.responseText, 'service_success', serviceResult.url || meta.url || '', true, true);
                    return;
                }
                var reasonText = String(serviceReason || failReason || '');
                if (!serviceRetried && (reasonText.indexOf('timeout') !== -1 || reasonText.indexOf('unavailable') !== -1)) {
                    serviceRetried = true;
                    // Attempt 1 already paid the node spawn budget; mark warm so
                    // the retry uses the normal (short) watchdog instead of
                    // doubling the worst-case wait.
                    usherServiceWarm = true;
                    bridgeDebugLog('usher_hls_service_retry', {
                        reason: reasonText,
                        url: meta && meta.url ? meta.url : ''
                    });
                    attemptUsherService(reasonText);
                    return;
                }
                var fallback = buildUsherPlaylistCorsFallbackResult(meta, 0, reasonText || 'service_unavailable');
                finish(fallback.status, fallback.responseText, 'cors_fallback_synthetic', fallback.url, true, true);
            });
        };
        var finish = function (status, text, reason, responseUrl, synthetic, skipServiceAttempt) {
            if (done) return;
            // The XHR fires several terminal events (readystatechange, error,
            // abort) for one failure. Once the service fallback is in flight,
            // only its synthetic result may complete this request — otherwise a
            // stale status-0 event reaches the app first, the app treats it as
            // a playback failure and shuts down before the playlist arrives.
            if (serviceAttempted && !synthetic) return;
            if (!skipServiceAttempt && !serviceAttempted && shouldUseUsherPlaylistCorsFallback(meta, status, text, reason)) {
                serviceAttempted = true;
                usherPlaylistCorsFailureSeen = true;
                bridgeDebugLog('usher_hls_cors_session_detected', {
                    reason: reason || 'unknown',
                    url: meta && meta.url ? meta.url : ''
                });
                attemptUsherService(reason);
                return;
            }
            done = true;
            if (meta.dedupeEnabled && meta.requestKey) clearInFlightRequestByKey(meta.requestKey, x);
            var finalStatus = status || 0;
            var finalText = text || '';
            var finalUrl = responseUrl || '';
            if (!synthetic) {
                if (finalStatus > 0) {
                    cacheNetworkResponse(meta.requestKey, finalStatus, finalText);
                    recordNetworkRtt(meta.host, Date.now() - requestStartedAt);
                    if (meta.circuitEnabled) recordHostCircuitSuccess(meta.host);
                } else if (meta.circuitEnabled && reason !== 'dedupe_abort' && reason !== 'circuit_open') {
                    recordHostCircuitFailure(meta.host);
                }
            }
            var callbackRef = callback;
            // Break XHR event handler retain cycles.
            if (x) {
                try {
                    x.onreadystatechange = null;
                    x.onerror = null;
                    x.ontimeout = null;
                    x.onabort = null;
                } catch (eCleanup) {}
            }
            callback = null;
            x = null;
            if (callbackRef) callbackRef(finalStatus, finalText, finalUrl);
        };
        if (isUsherPlaylistRequest(meta) && (usherPlaylistCorsFailureSeen || forceServiceFetch)) {
            if (forceServiceFetch) {
                bridgeDebugLog('usher_hls_service_forced', {
                    url: meta && meta.url ? meta.url : ''
                });
            }
            serviceAttempted = true;
            attemptUsherService('service_fail');
            return;
        }
        if (meta.circuitEnabled && isCircuitOpenForHost(meta.host)) {
            finish(0, '', 'circuit_open');
            return;
        }
        if (meta.dedupeEnabled) abortInFlightRequestByKey(meta.requestKey);
        try {
            x = new XMLHttpRequest();
            x.open(method, u, true);
            try {
                x.timeout = effectiveTimeout;
            } catch (e0) {}
            setRequestHeaders(x, h);
            if (meta.dedupeEnabled) registerInFlightRequest(meta.requestKey, x);
            x.onreadystatechange = function () {
                if (x.readyState === 4) finish(x.status || 0, x.responseText || '', (x.status || 0) > 0 ? 'success' : 'status0');
            };
            x.onerror = function () { finish(0, '', 'network_error'); };
            x.ontimeout = function () { finish(0, '', 'timeout'); };
            x.onabort = function () { finish(0, '', x && x.__sttvAbortReason === 'dedupe' ? 'dedupe_abort' : 'abort'); };
            x.send(body ? body : null);
        } catch (e1) {
            finish(0, '', 'request_exception');
        }
    }
    // Core XHR function. Supports both sync (mMethodUrlHeaders) and async modes.
    // Sync mode blocks the main thread — see network layer comment above for rationale.
    function xhrReq(u, to, pm, m, ck, h, sync) {
        u = limitUsherCodecs(u);
        var req = resolveRequestMethodAndBody(pm, m);
        var method = req.method;
        var body = req.body;
        var meta = buildNetworkRequestMeta(u, method, body);
        var forceServiceFetch = isForceHlsServiceFetchEnabled();
        maybePruneNetworkState();
        var effectiveTimeout = getEffectiveTimeoutMs(to, meta, sync);
        // Stale-while-revalidate: for sync requests, serve cached data immediately
        // to avoid blocking the main thread. Fresh = return as-is. Stale = return
        // immediately but fire an async refresh in the background.
        if (sync && meta.requestKey) {
            var cached = getCachedNetworkResponse(meta.requestKey);
            if (cached) {
                if (cached.isStale) sendAsyncRequest(u, to, pm, m, h, function () {});
                return {status: cached.status, responseText: cached.responseText, checkResult: ck || 0};
            }
        }
        if (sync && isUsherPlaylistRequest(meta) && (usherPlaylistCorsFailureSeen || forceServiceFetch)) {
            if (forceServiceFetch) {
                bridgeDebugLog('usher_hls_service_forced_sync', {
                    url: meta && meta.url ? meta.url : ''
                });
            }
            var cachedUsherPlaylist = getUsherPlaylistCacheEntry(meta.requestKey);
            if (cachedUsherPlaylist && hasUsablePlaylistBody(cachedUsherPlaylist.responseText || '')) {
                return {
                    status: 200,
                    responseText: cachedUsherPlaylist.responseText,
                    checkResult: ck || 0,
                    url: cachedUsherPlaylist.responseUrl || meta.url || ''
                };
            }
            requestUsherPlaylistViaService(meta, effectiveTimeout, function () {});
            return buildUsherPlaylistCorsFallbackResult(meta, ck, 'service_deferred_sync');
        }
        if (meta.circuitEnabled && isCircuitOpenForHost(meta.host)) {
            if (sync) {
                var cachedCircuit = getCachedNetworkResponse(meta.requestKey);
                if (cachedCircuit) return {status: cachedCircuit.status, responseText: cachedCircuit.responseText, checkResult: ck || 0};
            }
            return {status: 0, responseText: '', checkResult: ck || 0};
        }
        if (meta.dedupeEnabled) abortInFlightRequestByKey(meta.requestKey);
        var doRequest = function (targetUrl) {
            var x = new XMLHttpRequest();
            var requestStartedAt = Date.now();
            x.open(method, targetUrl, !sync);
            try {
                x.timeout = effectiveTimeout;
            } catch (e0) {}
            if (!sync) {
                if (meta.dedupeEnabled) registerInFlightRequest(meta.requestKey, x);
                try {
                    x.onloadend = function () {
                        if (meta.dedupeEnabled) clearInFlightRequestByKey(meta.requestKey, x);
                        if ((x.status || 0) > 0) {
                            cacheNetworkResponse(meta.requestKey, x.status || 0, x.responseText || '');
                            recordNetworkRtt(meta.host, Date.now() - requestStartedAt);
                            if (meta.circuitEnabled) recordHostCircuitSuccess(meta.host);
                        } else if (meta.circuitEnabled && x.__sttvAbortReason !== 'dedupe') recordHostCircuitFailure(meta.host);
                        // Break XHR event handler retain cycle.
                        try { x.onloadend = null; } catch (eCleanup) {}
                        x = null;
                    };
                } catch (eLoad) {}
            }
            setRequestHeaders(x, h);
            try {
                x.send(body ? body : null);
            } catch (e2) {
                if (sync) {
                    if (shouldUseUsherPlaylistCorsFallback(meta, 0, '', 'request_exception')) {
                        usherPlaylistCorsFailureSeen = true;
                        requestUsherPlaylistViaService(meta, effectiveTimeout, function () {});
                        return buildUsherPlaylistCorsFallbackResult(meta, ck, 'request_exception');
                    }
                    if (meta.circuitEnabled) recordHostCircuitFailure(meta.host);
                    return {status: 0, responseText: '', checkResult: ck || 0};
                } else if (meta.dedupeEnabled) {
                    clearInFlightRequestByKey(meta.requestKey, x);
                }
            }
            if (sync) {
                var syncStatus = x.status || 0;
                var syncText = x.responseText || '';
                if (shouldUseUsherPlaylistCorsFallback(meta, syncStatus, syncText, syncStatus > 0 ? 'success' : 'status0')) {
                    usherPlaylistCorsFailureSeen = true;
                    requestUsherPlaylistViaService(meta, effectiveTimeout, function () {});
                    return buildUsherPlaylistCorsFallbackResult(meta, ck, 'status0_sync');
                }
                if (syncStatus > 0) {
                    cacheNetworkResponse(meta.requestKey, syncStatus, syncText);
                    recordNetworkRtt(meta.host, Date.now() - requestStartedAt);
                    if (meta.circuitEnabled) recordHostCircuitSuccess(meta.host);
                } else if (meta.circuitEnabled) recordHostCircuitFailure(meta.host);
                return {status: syncStatus, responseText: syncText, checkResult: ck || 0};
            }
            return x;
        };
        return doRequest(u);
    }
    // Opens a URL in the webOS system browser.
    // Android: startActivity(Intent.ACTION_VIEW). webOS: webOS.launch(BROWSER, target).
    function launchExternal(url) {
        if (!url) return;
        if (w.webOS && w.webOS.launch && w.webOS.APP) { w.webOS.launch({id: w.webOS.APP.BROWSER, params: {target: url}}); return; }
        try { w.open(url, '_blank'); } catch (e) { w.location.href = url; }
    }
    function showMultiLimitNotice() {
        var now = Date.now();
        if (multiWarnShown && now - secondaryWarnAt < MULTISTREAM_NOTICE_COOLDOWN_MS) return;
        multiWarnShown = true;
        secondaryWarnAt = now;
        if (!call('Play_showWarningMiddleDialog', [MULTISTREAM_NOTICE_MESSAGE, 5500])) {
            if (typeof w.Main_PlayMainShowWarning === 'function') {
                w.Main_PlayMainShowWarning(MULTISTREAM_NOTICE_MESSAGE, 5500);
            } else if (w.Android && typeof w.Android.showToast === 'function') {
                w.Android.showToast(MULTISTREAM_NOTICE_MESSAGE);
            }
        }
    }
    function rejectMultiStream(position) {
        var handled = false;
        if (typeof position === 'number') {
            handled = !!call('Play_MultiStartFail', [position, '', MULTISTREAM_FAIL_MESSAGE]);
            if (!handled) {
                call('Play_MultiEnd', [position, 1, 0]);
            }
        }
        if (!handled) showMultiLimitNotice();
    }
    function clearCookiesForCurrentDomain() {
        if (!w.document || !w.document.cookie) return;
        var cookies = w.document.cookie.split(';');
        var i;
        for (i = 0; i < cookies.length; i++) {
            var eqPos = cookies[i].indexOf('=');
            var name = eqPos > -1 ? cookies[i].substr(0, eqPos) : cookies[i];
            name = name.trim();
            if (!name) continue;
            w.document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:01 GMT;path=/';
        }
    }
    function clearRuntimeCaches() {
        var PromiseCtor = w.Promise;
        if (typeof PromiseCtor !== 'function') {
            return {
                then: function (resolve) {
                    if (typeof resolve === 'function') resolve();
                    return this;
                },
                catch: function () {
                    return this;
                }
            };
        }
        var tasks = [];
        try {
            clearCookiesForCurrentDomain();
        } catch (e) {}
        if (w.caches && typeof w.caches.keys === 'function') {
            tasks.push(
                w.caches
                    .keys()
                    .then(function (keys) {
                        return PromiseCtor.all(
                            keys.map(function (key) {
                                return w.caches.delete(key);
                            })
                        );
                    })
                    .catch(function () {})
            );
        }
        if (w.navigator && w.navigator.serviceWorker && typeof w.navigator.serviceWorker.getRegistrations === 'function') {
            tasks.push(
                w.navigator.serviceWorker
                    .getRegistrations()
                    .then(function (regs) {
                        return PromiseCtor.all(
                            regs.map(function (reg) {
                                return reg.unregister();
                            })
                        );
                    })
                    .catch(function () {})
            );
        }
        return PromiseCtor.all(tasks);
    }
    function withCacheBuster(url) {
        if (!url || typeof url !== 'string') return FORK_RELEASE_URL;
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        return url + sep + 'sttv_update=' + Date.now();
    }
    function normalizeReloadUrl(url) {
        var target = typeof url === 'string' && url.length > 0 ? url : FORK_RELEASE_URL;
        if (target.indexOf(FORK_BASE_URL) !== 0 && target.indexOf('https://fgl27.github.io/SmartTwitchTV') !== 0) {
            return withCacheBuster(FORK_RELEASE_URL);
        }
        return withCacheBuster(target);
    }
    function patchMainUpdateFlow() {
        if (w.__sttvWebOSUpdatePatched) return true;
        if (
            typeof w.Main_CheckUpdate !== 'function' ||
            typeof w.BaseXmlHttpGet !== 'function' ||
            typeof w.Main_CheckUpdateResult !== 'function' ||
            typeof w.Main_CheckUpdateFail !== 'function'
        ) {
            return false;
        }
        var original = w.Main_CheckUpdate;
        w.Main_CheckUpdate = function (forceUpdate) {
            if (typeof w.checkUpdates !== 'undefined' && w.checkUpdates) {
                if (
                    w.Main_HasUpdate &&
                    typeof w.Main_isUpdateDialogVisible === 'function' &&
                    w.Main_isUpdateDialogVisible() &&
                    w.Settings_value &&
                    w.Settings_value.update_background &&
                    w.Settings_value.update_background.defaultValue &&
                    !forceUpdate
                ) {
                    return;
                }
                var href = w.location && w.location.href ? w.location.href : '';
                var knownHost =
                    href.indexOf('https://fgl27.github.io') !== -1 ||
                    href.indexOf(FORK_BASE_URL) !== -1;
                if (knownHost) {
                    w.BaseXmlHttpGet(FORK_VERSION_URL, w.Main_CheckUpdateResult, w.Main_CheckUpdateFail);
                    return;
                }
            }
            return original.apply(this, arguments);
        };
        w.__sttvWebOSUpdatePatched = true;
        return true;
    }
    function patchUpdateResultFlow() {
        if (w.__sttvWebOSUpdateResultPatched) return true;
        if (typeof w.Main_CheckUpdateResult !== 'function') return false;
        var original = w.Main_CheckUpdateResult;
        w.Main_CheckUpdateResult = function (responseText) {
            try {
                var response = JSON.parse(responseText);
                if (response && typeof response === 'object' && w.version) {
                    response.publishVersionCode = typeof w.version.publishVersionCode === 'number' ? w.version.publishVersionCode : 0;
                    response.ApkUrl = '';
                    return original.call(this, JSON.stringify(response));
                }
            } catch (e) {}
            return original.apply(this, arguments);
        };
        w.__sttvWebOSUpdateResultPatched = true;
        return true;
    }
    function forceHideBrowserFallbackUi() {
        var ids = ['player_embed_clicks', 'twitch-embed', 'clip_embed', 'scene2_click'];
        var i;
        for (i = 0; i < ids.length; i++) {
            if (typeof w.Main_HideElement === 'function') {
                w.Main_HideElement(ids[i]);
            } else if (w.document) {
                var el = w.document.getElementById(ids[i]);
                if (el && el.classList) el.classList.add('hide');
            }
        }
        if (typeof w.Main_RemoveClass === 'function') w.Main_RemoveClass('scenefeed', 'feed_screen_input');
        setMainLoading(false);
        setFeedLoading(false);
    }
    // Checks if Twitch browser/embed fallback elements are visible (cached for 2s).
    // Used to prevent loader hide when fallback is playing instead of native video.
    function isBrowserFallbackVisible() {
        var now = Date.now();
        if (browserFallbackCacheAt > 0 && now - browserFallbackCacheAt < BROWSER_FALLBACK_CACHE_TTL_MS) {
            return browserFallbackVisibleCached;
        }
        browserFallbackCacheAt = now;
        if (!w.document) { browserFallbackVisibleCached = false; return false; }
        var ids = ['player_embed_clicks', 'twitch-embed', 'clip_embed', 'scene2_click'];
        var i;
        for (i = 0; i < ids.length; i++) {
            var el = w.document.getElementById(ids[i]);
            if (!el) continue;
            if (el.classList && el.classList.contains('hide')) continue;
            if (el.style && el.style.display === 'none') continue;
            browserFallbackVisibleCached = true;
            return true;
        }
        browserFallbackVisibleCached = false;
        return false;
    }
    // Stops main playback if user navigated away from the player scene.
    function stopMainIfLeavingPlayerScene(delay) {
        if (sceneSafetyStopTimerId) w.clearTimeout(sceneSafetyStopTimerId);
        sceneSafetyStopTimerId = w.setTimeout(function () {
            sceneSafetyStopTimerId = 0;
            var isScene2Visible = typeof w.Main_isScene2DocVisible === 'function' ? w.Main_isScene2DocVisible() : false;
            if (isScene2Visible) return;
            if (w.Play_isOn || w.PlayVod_isOn || w.PlayClip_isOn) return;
            if (isMainActive()) {
                clear(mv);
                resetMainState();
            }
            if (isPreviewActive()) {
                clear(pv);
                resetPreviewState();
            }
        }, delay > 0 ? delay : 120);
    }
    function installSceneSafetyPatches() {
        var install = function (name, delay) {
            if (typeof w[name] !== 'function') return false;
            if (w[name].__sttvSceneSafetyPatched) return true;
            var original = w[name];
            var wrapped = function () {
                var result = original.apply(this, arguments);
                stopMainIfLeavingPlayerScene(delay);
                updatePlayerSceneOptimizerState('scene_safety_patch');
                return result;
            };
            wrapped.__sttvSceneSafetyPatched = true;
            w[name] = wrapped;
            return true;
        };
        var a = install('Main_showScene1Doc', 160);
        var b = install('Main_hideScene2Doc', 120);
        return a || b;
    }
    function patchNoBrowserFallbackFlow() {
        // Safety net: if upstream browser-test hooks are called on webOS, redirect back to bridge playback path.
        var patched = 0;
        var install = function (name, handler) {
            if (typeof w[name] !== 'function') return;
            if (w[name].__sttvNoFallbackPatched) {
                patched += 1;
                return;
            }
            var original = w[name];
            var wrapped = function () {
                return handler(original, arguments);
            };
            wrapped.__sttvNoFallbackPatched = true;
            w[name] = wrapped;
            patched += 1;
        };
        install('BrowserTestFun', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        install('BrowserTestLoadScript', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        install('BrowserTestStartLive', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            if (w.Main_IsOn_OSInterface && w.Play_isOn && !w.enable_embed && typeof w.Play_loadData === 'function') {
                w.Play_loadData();
            }
            return null;
        });
        install('BrowserTestStartVod', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            if (w.Main_IsOn_OSInterface && w.PlayVod_isOn && !w.enable_embed && typeof w.PlayVod_loadData === 'function') {
                w.PlayVod_loadData();
            }
            return null;
        });
        install('BrowserTestStartClip', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            if (w.Main_IsOn_OSInterface && w.PlayClip_isOn && !w.enable_embed && typeof w.PlayClip_onPlayer === 'function') {
                w.PlayClip_onPlayer();
            }
            return null;
        });
        install('BrowserTestSetPlayer', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        install('BrowserTestStartPlaying', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        install('BrowserTestSetListners', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            return null;
        });
        install('BrowserTestShowEmbedClicks', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        install('BrowserTestStartPlayerShutDown', function (original, args) {
            if (!isBridgePolyfillActive()) return original.apply(w, args);
            forceHideBrowserFallbackUi();
            return null;
        });
        if (patched >= 10) {
            w.__sttvNoBrowserFallbackPatched = true;
            return true;
        }
        return false;
    }
    function forceStopStaleLiveForVodTransition() {
        if (!isMainActive() || ms.type !== 1) return false;
        clear(mv);
        resetMainState();
        setMainLoading(false);
        clearPreviewTracking();
        resetVideoStatusCounters();
        return true;
    }
    function patchVodSafetyFlow() {
        if (w.__sttvVodSafetyFlowPatched) return true;
        var marker = '__sttvVodSafetyPatched';
        var patchCount = 0;
        var wrap = function (name, factory) {
            var original = w[name];
            if (typeof original !== 'function') return;
            if (original[marker]) {
                patchCount += 1;
                return;
            }
            w[name] = factory(original);
            w[name][marker] = true;
            patchCount += 1;
        };
        wrap('PlayVod_Start', function (original) {
            return function () {
                if (w.Play_OpenRewind) forceStopStaleLiveForVodTransition();
                return original.apply(this, arguments);
            };
        });
        wrap('PlayVod_WarnEnd', function (original) {
            return function () {
                forceStopStaleLiveForVodTransition();
                return original.apply(this, arguments);
            };
        });
        wrap('PlayVod_loadDataErrorFinish', function (original) {
            return function () {
                forceStopStaleLiveForVodTransition();
                return original.apply(this, arguments);
            };
        });
        wrap('PlayVod_get_vod_infoResult', function (original) {
            return function (responseObj) {
                if (isBridgePolyfillActive() && w.PlayVod_isOn && responseObj && typeof responseObj.responseText === 'string') {
                    try {
                        var parsed = JSON.parse(responseObj.responseText);
                        var payloadVodId =
                            parsed && parsed.data && parsed.data.video && parsed.data.video.id ? String(parsed.data.video.id) : '';
                        var activeVodId = w.Main_values && w.Main_values.ChannelVod_vodId ? String(w.Main_values.ChannelVod_vodId) : '';
                        if (payloadVodId && activeVodId && payloadVodId !== activeVodId) return;
                    } catch (e) {}
                }
                return original.apply(this, arguments);
            };
        });
        if (patchCount >= 4) {
            w.__sttvVodSafetyFlowPatched = true;
            return true;
        }
        return false;
    }
    function ensureVodSafetyPatches() {
        if (patchVodSafetyFlow()) return;
        w.setTimeout(patchVodSafetyFlow, 1000);
        w.setTimeout(patchVodSafetyFlow, 2500);
    }
    // =========================================================================
    // Player Scene Optimizer (webOS-only)
    // =========================================================================
    function hasCssClass(element, className) {
        if (!element || !className) return false;
        try {
            if (element.classList && typeof element.classList.contains === 'function') return element.classList.contains(className);
        } catch (e) {}
        var cls = element.className;
        if (typeof cls !== 'string' || !cls) return false;
        return (' ' + cls + ' ').indexOf(' ' + className + ' ') >= 0;
    }
    function isOptimizerElementHidden(element) {
        if (!element) return true;
        if (hasCssClass(element, 'hide')) return true;
        if (!element.style) return false;
        if (element.style.display === 'none') return true;
        if (element.style.visibility === 'hidden') return true;
        if (element.style.opacity === '0') return true;
        return false;
    }
    function nodeContainsNode(parent, child) {
        if (!parent || !child) return false;
        try {
            if (typeof parent.contains === 'function') return parent.contains(child);
        } catch (e) {}
        var current = child;
        while (current) {
            if (current === parent) return true;
            current = current.parentNode;
        }
        return false;
    }
    function isPlayerSceneActiveForOptimizer() {
        var isVisible = false;
        try {
            if (typeof w.Main_isScene2DocVisible === 'function') isVisible = !!w.Main_isScene2DocVisible();
        } catch (e) {}
        if (!w.document) return isVisible;
        var scene = w.document.getElementById('scene2');
        if (!scene) return isVisible;
        if (isOptimizerElementHidden(scene)) return false;
        if (isVisible) return true;
        try {
            var opacityValue = parseFloat(scene.style && scene.style.opacity ? scene.style.opacity : '');
            if (isFinite(opacityValue)) return opacityValue > 0;
        } catch (e2) {}
        if (scene.style && scene.style.pointerEvents === 'none') return false;
        return true;
    }
    function ensurePlayerSceneOptimizerStyle() {
        if (!w.document) return;
        var scene = w.document.getElementById('scene2');
        if (!playerSceneOptimizer.styleNode) {
            var style = w.document.getElementById('sttv_webos_player_optimizer_style');
            if (!style) {
                style = w.document.createElement('style');
                style.id = 'sttv_webos_player_optimizer_style';
                var css =
                    '#scene2 #chat_container0 .emoticon,#scene2 #chat_container1 .emoticon{min-width:1.55em;height:1.55em;margin-bottom:-0.30em;}' +
                    '#scene2 #chat_container0 .emoji,#scene2 #chat_container1 .emoji{min-width:0.95em;height:0.95em;margin-right:0.08em;margin-left:0.08em;}' +
                    '#scene2 #chat_container0 .tag,#scene2 #chat_container1 .tag{min-width:1.2em;height:1.2em;margin-right:0.16em;}';
                if (style.styleSheet) style.styleSheet.cssText = css;
                else style.appendChild(w.document.createTextNode(css));
            }
            playerSceneOptimizer.styleNode = style;
        }
        if (!playerSceneOptimizer.styleNode) return;
        if (scene && playerSceneOptimizer.styleNode.parentNode !== scene) {
            try { scene.appendChild(playerSceneOptimizer.styleNode); } catch (e3) {}
            return;
        }
        if (!playerSceneOptimizer.styleNode.parentNode) {
            var parent = w.document.head || w.document.body;
            if (parent) {
                try { parent.appendChild(playerSceneOptimizer.styleNode); } catch (e4) {}
            }
        }
    }
    function refreshPlayerSceneOptimizerTargets() {
        if (!w.document) return;
        playerSceneOptimizer.scene = w.document.getElementById('scene2');
        playerSceneOptimizer.chatBoxes[0] = w.document.getElementById('chat_box0');
        playerSceneOptimizer.chatBoxes[1] = w.document.getElementById('chat_box1');
        playerSceneOptimizer.chatContainers[0] = w.document.getElementById('chat_container0');
        playerSceneOptimizer.chatContainers[1] = w.document.getElementById('chat_container1');
        playerSceneOptimizer.chatHolders[0] = w.document.getElementById('chat_box_holder0');
        playerSceneOptimizer.chatHolders[1] = w.document.getElementById('chat_box_holder1');
    }
    function clearPlayerSceneOptimizerRunTimer() {
        if (!playerSceneOptimizer.runTimerId) return;
        w.clearTimeout(playerSceneOptimizer.runTimerId);
        playerSceneOptimizer.runTimerId = 0;
    }
    function clearPlayerSceneOptimizerFallbackTimer() {
        if (!playerSceneOptimizer.fallbackTimerId) return;
        w.clearInterval(playerSceneOptimizer.fallbackTimerId);
        playerSceneOptimizer.fallbackTimerId = 0;
    }
    function disconnectPlayerSceneOptimizerObservers() {
        if (playerSceneOptimizer.mutationObserver) {
            try { playerSceneOptimizer.mutationObserver.disconnect(); } catch (e) {}
            playerSceneOptimizer.mutationObserver = null;
        }
        if (playerSceneOptimizer.attrObservers && playerSceneOptimizer.attrObservers.length) {
            var i;
            for (i = 0; i < playerSceneOptimizer.attrObservers.length; i++) {
                try { playerSceneOptimizer.attrObservers[i].disconnect(); } catch (e2) {}
            }
        }
        playerSceneOptimizer.attrObservers = [];
    }
    function schedulePlayerSceneOptimizerRun(reason, delayMs) {
        if (!playerSceneOptimizer.active) return;
        if (reason) playerSceneOptimizer.pendingReason = reason;
        if (playerSceneOptimizer.runTimerId) return;
        playerSceneOptimizer.runTimerId = w.setTimeout(function () {
            playerSceneOptimizer.runTimerId = 0;
            var runReason = playerSceneOptimizer.pendingReason || 'scheduled';
            playerSceneOptimizer.pendingReason = '';
            runPlayerSceneOptimizer(runReason);
        }, delayMs > 0 ? delayMs : PLAYER_SCENE_OPT_MUTATION_DEBOUNCE_MS);
    }
    function rowIsVisibleForOptimizer(row, boxRect, marginPx) {
        if (!row || !boxRect || typeof row.getBoundingClientRect !== 'function') return false;
        try {
            var rect = row.getBoundingClientRect();
            if (!rect) return false;
            var m = marginPx > 0 ? marginPx : 0;
            if (rect.bottom < boxRect.top - m) return false;
            if (rect.top > boxRect.bottom + m) return false;
            return true;
        } catch (e) {
            return false;
        }
    }
    function downgradeImageNodeForOptimizer(imageNode) {
        if (!imageNode) return false;
        if (imageNode.getAttribute('data-sttv-img-downgraded') === '1') return false;
        var srcValue = imageNode.getAttribute('src') || '';
        var srcsetValue = imageNode.getAttribute('srcset') || '';
        if (!srcValue && !srcsetValue) return false;
        imageNode.setAttribute('data-sttv-img-src', srcValue);
        imageNode.setAttribute('data-sttv-img-srcset', srcsetValue);
        imageNode.setAttribute('data-sttv-img-downgraded', '1');
        try { imageNode.removeAttribute('srcset'); } catch (e) {}
        try { imageNode.setAttribute('src', PLAYER_SCENE_OPT_PLACEHOLDER_IMAGE); } catch (e2) {}
        return true;
    }
    function restoreImageNodeForOptimizer(imageNode) {
        if (!imageNode) return false;
        if (imageNode.getAttribute('data-sttv-img-downgraded') !== '1') return false;
        var srcValue = imageNode.getAttribute('data-sttv-img-src') || '';
        var srcsetValue = imageNode.getAttribute('data-sttv-img-srcset') || '';
        if (srcsetValue) imageNode.setAttribute('srcset', srcsetValue);
        else imageNode.removeAttribute('srcset');
        if (srcValue) imageNode.setAttribute('src', srcValue);
        imageNode.removeAttribute('data-sttv-img-src');
        imageNode.removeAttribute('data-sttv-img-srcset');
        imageNode.removeAttribute('data-sttv-img-downgraded');
        return true;
    }
    function downgradeTagNodeForOptimizer(tagNode) {
        if (!tagNode || tagNode.getAttribute('data-sttv-tag-downgraded') === '1') return false;
        var backgroundImage = '';
        try {
            backgroundImage = tagNode.style && typeof tagNode.style.backgroundImage === 'string' ? tagNode.style.backgroundImage : '';
        } catch (e) {}
        tagNode.setAttribute('data-sttv-tag-bg', backgroundImage);
        tagNode.setAttribute('data-sttv-tag-downgraded', '1');
        try {
            if (tagNode.style) tagNode.style.backgroundImage = 'none';
        } catch (e2) {}
        return true;
    }
    function restoreTagNodeForOptimizer(tagNode) {
        if (!tagNode || tagNode.getAttribute('data-sttv-tag-downgraded') !== '1') return false;
        var backgroundImage = tagNode.getAttribute('data-sttv-tag-bg') || '';
        try {
            if (tagNode.style) tagNode.style.backgroundImage = backgroundImage;
        } catch (e) {}
        tagNode.removeAttribute('data-sttv-tag-bg');
        tagNode.removeAttribute('data-sttv-tag-downgraded');
        return true;
    }
    function downgradeRowMediaForOptimizer(row, budget, stats) {
        if (!row || !budget || budget.ops <= 0) return;
        var images = row.getElementsByTagName ? row.getElementsByTagName('img') : [];
        var i;
        for (i = 0; i < images.length && budget.ops > 0; i++) {
            if (downgradeImageNodeForOptimizer(images[i])) {
                budget.ops -= 1;
                stats.downgraded += 1;
            }
        }
        var tags = row.getElementsByClassName ? row.getElementsByClassName('tag') : [];
        for (i = 0; i < tags.length && budget.ops > 0; i++) {
            if (downgradeTagNodeForOptimizer(tags[i])) {
                budget.ops -= 1;
                stats.downgraded += 1;
            }
        }
    }
    function restoreRowMediaForOptimizer(row, budget, stats) {
        if (!row || !budget || budget.ops <= 0) return;
        var images = row.getElementsByTagName ? row.getElementsByTagName('img') : [];
        var i;
        for (i = 0; i < images.length && budget.ops > 0; i++) {
            if (restoreImageNodeForOptimizer(images[i])) {
                budget.ops -= 1;
                stats.restored += 1;
            }
        }
        var tags = row.getElementsByClassName ? row.getElementsByClassName('tag') : [];
        for (i = 0; i < tags.length && budget.ops > 0; i++) {
            if (restoreTagNodeForOptimizer(tags[i])) {
                budget.ops -= 1;
                stats.restored += 1;
            }
        }
    }
    function processChatBoxForOptimizer(chatBox, chatContainer, stats, budget) {
        if (!chatBox || !chatBox.getElementsByClassName) return;
        var holders = chatBox.getElementsByClassName('chat_line_holder');
        if (!holders || !holders.length) return;
        var overflow = holders.length - PLAYER_SCENE_OPT_CHAT_MAX;
        var prunedCount = 0;
        var activeElement = w.document && w.document.activeElement ? w.document.activeElement : null;
        while (overflow > 0 && holders.length > 0 && prunedCount < PLAYER_SCENE_OPT_MAX_PRUNE_PER_PASS) {
            var oldest = holders[0];
            if (!oldest || oldest.parentNode !== chatBox) break;
            if (activeElement && nodeContainsNode(oldest, activeElement)) break;
            chatBox.removeChild(oldest);
            prunedCount += 1;
            overflow -= 1;
        }
        if (prunedCount > 0) stats.pruned += prunedCount;
        if (!holders.length) return;
        var staleBoundary = holders.length - PLAYER_SCENE_OPT_RECENT_ACTIVE;
        if (staleBoundary < 0) staleBoundary = 0;
        var containerVisible = !isOptimizerElementHidden(chatContainer);
        var boxRect = null;
        if (containerVisible && typeof chatBox.getBoundingClientRect === 'function') {
            try { boxRect = chatBox.getBoundingClientRect(); } catch (e) { boxRect = null; }
        }
        var i;
        for (i = 0; i < holders.length && budget.ops > 0; i++) {
            var row = holders[i];
            if (!row || row.parentNode !== chatBox) continue;
            if (i >= staleBoundary) {
                restoreRowMediaForOptimizer(row, budget, stats);
                continue;
            }
            if (!containerVisible || !rowIsVisibleForOptimizer(row, boxRect, PLAYER_SCENE_OPT_VISIBILITY_MARGIN_PX)) {
                downgradeRowMediaForOptimizer(row, budget, stats);
            } else {
                restoreRowMediaForOptimizer(row, budget, stats);
            }
        }
    }
    function runPlayerSceneOptimizer(reason) {
        if (!playerSceneOptimizer.active) return;
        if (!isPlayerSceneActiveForOptimizer()) {
            deactivatePlayerSceneOptimizer('scene_hidden');
            return;
        }
        refreshPlayerSceneOptimizerTargets();
        ensurePlayerSceneOptimizerStyle();
        var stats = {pruned: 0, downgraded: 0, restored: 0};
        var budget = {ops: PLAYER_SCENE_OPT_MAX_MEDIA_OPS_PER_PASS};
        processChatBoxForOptimizer(playerSceneOptimizer.chatBoxes[0], playerSceneOptimizer.chatContainers[0], stats, budget);
        processChatBoxForOptimizer(playerSceneOptimizer.chatBoxes[1], playerSceneOptimizer.chatContainers[1], stats, budget);
        if (stats.pruned > 0 || stats.downgraded > 0 || stats.restored > 0) {
            bridgeDebugLog('player_scene_optimizer_run', {
                reason: reason || 'run',
                pruned: stats.pruned,
                downgraded: stats.downgraded,
                restored: stats.restored,
                budgetLeft: budget.ops
            });
        }
    }
    function installPlayerSceneOptimizerObservers() {
        disconnectPlayerSceneOptimizerObservers();
        clearPlayerSceneOptimizerFallbackTimer();
        refreshPlayerSceneOptimizerTargets();
        var MutationObserverCtor = w.MutationObserver || w.WebKitMutationObserver;
        var hasChildTargets = false;
        var hasAttrTargets = false;
        if (MutationObserverCtor) {
            var mutationObserver = new MutationObserverCtor(function () {
                schedulePlayerSceneOptimizerRun('chat_mutation', PLAYER_SCENE_OPT_MUTATION_DEBOUNCE_MS);
            });
            var i;
            for (i = 0; i < playerSceneOptimizer.chatBoxes.length; i++) {
                if (!playerSceneOptimizer.chatBoxes[i]) continue;
                try {
                    mutationObserver.observe(playerSceneOptimizer.chatBoxes[i], {childList: true});
                    hasChildTargets = true;
                } catch (e) {}
            }
            if (hasChildTargets) {
                playerSceneOptimizer.mutationObserver = mutationObserver;
            } else {
                try { mutationObserver.disconnect(); } catch (e2) {}
            }
            var attrTargets = [
                playerSceneOptimizer.scene,
                playerSceneOptimizer.chatContainers[0],
                playerSceneOptimizer.chatContainers[1],
                playerSceneOptimizer.chatHolders[0],
                playerSceneOptimizer.chatHolders[1]
            ];
            var attrObserver = new MutationObserverCtor(function () {
                schedulePlayerSceneOptimizerRun('chat_visibility', PLAYER_SCENE_OPT_MUTATION_DEBOUNCE_MS);
            });
            for (i = 0; i < attrTargets.length; i++) {
                if (!attrTargets[i]) continue;
                try {
                    attrObserver.observe(attrTargets[i], {attributes: true, attributeFilter: ['class', 'style']});
                    hasAttrTargets = true;
                } catch (e3) {}
            }
            if (hasAttrTargets) {
                playerSceneOptimizer.attrObservers.push(attrObserver);
            } else {
                try { attrObserver.disconnect(); } catch (e4) {}
            }
        }
        if (!MutationObserverCtor || (!hasChildTargets && !hasAttrTargets)) {
            playerSceneOptimizer.fallbackTimerId = w.setInterval(function () {
                runPlayerSceneOptimizer('fallback_poll');
            }, PLAYER_SCENE_OPT_FALLBACK_INTERVAL_MS);
        }
    }
    function activatePlayerSceneOptimizer(reason) {
        if (playerSceneOptimizer.active) {
            schedulePlayerSceneOptimizerRun(reason || 'scene_active', 30);
            return;
        }
        playerSceneOptimizer.active = true;
        ensurePlayerSceneOptimizerStyle();
        installPlayerSceneOptimizerObservers();
        schedulePlayerSceneOptimizerRun(reason || 'scene_enter', 40);
        bridgeDebugLog('player_scene_optimizer_active', {reason: reason || 'activate'});
    }
    function deactivatePlayerSceneOptimizer(reason) {
        if (!playerSceneOptimizer.active && !playerSceneOptimizer.runTimerId && !playerSceneOptimizer.fallbackTimerId) return;
        playerSceneOptimizer.active = false;
        playerSceneOptimizer.pendingReason = '';
        clearPlayerSceneOptimizerRunTimer();
        clearPlayerSceneOptimizerFallbackTimer();
        disconnectPlayerSceneOptimizerObservers();
        bridgeDebugLog('player_scene_optimizer_inactive', {reason: reason || 'deactivate'});
    }
    function updatePlayerSceneOptimizerState(reason) {
        if (isPlayerSceneActiveForOptimizer()) activatePlayerSceneOptimizer(reason || 'scene_visible');
        else deactivatePlayerSceneOptimizer(reason || 'scene_hidden');
    }
    function installPlayerSceneOptimizerMonitor() {
        if (playerSceneOptimizerMonitorId) return;
        updatePlayerSceneOptimizerState('bootstrap');
        playerSceneOptimizerMonitorId = w.setInterval(function () {
            updatePlayerSceneOptimizerState('scene_poll');
        }, PLAYER_SCENE_OPT_SCENE_POLL_MS);
    }
    function getStoredWebTag() {
        try {
            return parseInt(w.localStorage.getItem(WEBTAG_STORAGE_KEY) || '0', 10) || 0;
        } catch (e) {
            return 0;
        }
    }
    function setStoredWebTag(value) {
        try {
            w.localStorage.setItem(WEBTAG_STORAGE_KEY, String(value || 0));
        } catch (e) {}
    }
    function parseWebTagValue(payload) {
        if (!payload || typeof payload !== 'object') return 0;
        var raw = payload.WebTag;
        if (typeof raw === 'undefined' || raw === null || raw === '') raw = payload.webTag;
        if (typeof raw === 'undefined' || raw === null || raw === '') raw = payload.publishVersionCode;
        var value = parseInt(raw, 10);
        if (!isFinite(value) || value <= 0) return 0;
        return value;
    }
    // =========================================================================
    // Version Check & Auto-Refresh
    // =========================================================================
    // Periodically checks if a newer hosted release is available and reloads.
    // Android: APK update flow (Google Play / in-app update). Not applicable on webOS.
    // webOS:   fetches version.json, compares WebTag, reloads if newer build detected.
    function checkForkVersionAndRefresh() {
        if (!isBridgePolyfillActive()) return;
        if (versionRefreshInFlight) return;
        var now = Date.now();
        if (versionRefreshLastAt > 0 && now - versionRefreshLastAt < VERSION_REFRESH_MIN_INTERVAL_MS) return;
        if (typeof w.fetch !== 'function') return;
        versionRefreshInFlight = true;
        versionRefreshLastAt = now;
        var finish = function () {
            versionRefreshInFlight = false;
        };
        var url = FORK_VERSION_URL + (FORK_VERSION_URL.indexOf('?') === -1 ? '?' : '&') + 'sttv_bridge_vercheck=' + now;
        w.fetch(url, {cache: 'no-store'})
            .then(function (response) {
                if (!response || !response.ok) return null;
                return response.json();
            })
            .then(function (payload) {
                var nextTag = parseWebTagValue(payload);
                if (!nextTag) return;
                var currentTag = getStoredWebTag();
                if (!currentTag) {
                    setStoredWebTag(nextTag);
                    return;
                }
                if (nextTag === currentTag) return;
                setStoredWebTag(nextTag);
                call('Main_showWarningMiddleDialog', ['New web build detected. Reloading app.', 2500]);
                if (w.Android && typeof w.Android.CleanAndLoadUrl === 'function' && typeof w.Android.mPageUrl === 'function') {
                    w.Android.CleanAndLoadUrl(w.Android.mPageUrl());
                    return;
                }
                w.location.replace(normalizeReloadUrl((w.location && w.location.href) || FORK_RELEASE_URL));
            })
            .catch(function () {})
            .then(finish, finish);
    }
    function applyWebOSDefaultSettings() {
        try {
            if (!w.localStorage) return false;
            // Feed/screen/side preview players are no-ops on webOS (hardware
            // decoder cannot render into small CSS windows).  Force all small-
            // window preview settings to disabled ("1" = index 0 = 'no') so
            // the upstream UI skips preview-related work entirely.
            var changed = false;
            var keys = ['show_feed_player', 'show_side_player', 'show_live_player', 'show_vod_player', 'show_clip_player'];
            for (var i = 0; i < keys.length; i++) {
                if (w.localStorage.getItem(keys[i]) !== '1') {
                    w.localStorage.setItem(keys[i], '1');
                    changed = true;
                }
            }
            return changed;
        } catch (e) {}
        return false;
    }
    // =========================================================================
    // initAndroid() — Full Android Bridge API Surface (~111 methods)
    // =========================================================================
    // Replaces the early shim with the fully functional bridge implementation.
    // Each method is documented with its Android equivalent, implementation status,
    // and any webOS-specific behavioral differences.
    //
    // Status legend:
    //   IMPLEMENTED  — Fully functional on webOS.
    //   NO-OP        — Stub (Android-only feature, no webOS equivalent).
    //   HARDWARE-LTD — Rejected due to webOS single-decoder hardware constraint.
    //   ALIAS        — Redirect to another implemented method.
    function initAndroid() {
        var A = w.Android || {};
        A.__platform = 'webos';
        A.__isWebOSPolyfill = true;

        // --- HTTP / Network Methods ---

        // IMPLEMENTED: Synchronous HTTP request. Android: OkHttp sync call in WebView thread.
        // webOS: Sync XHR (blocks main thread). Required for upstream token fetch compatibility.
        A.mMethodUrlHeaders = function (u, to, pm, m, ck, h) { var r = xhrReq(u, to, pm, m, ck, h, true); return res(r.status, r.responseText, r.checkResult, r.url); };
        // IMPLEMENTED: Async HTTP request (basic). Android: OkHttp async call.
        A.BasexmlHttpGet = function (u, to, pm, m, h, cb, ck, key, ok, err) { sendAsyncRequest(u, to, pm, m, h, function (status, text) { call(cb, [res(status, text, ck), key, ok, err, ck]); }); };
        // IMPLEMENTED: Async HTTP request (full, with extended check parameters). Android: OkHttp async.
        A.XmlHttpGetFull = function (u, to, pm, m, h, cb, ck, c1, c2, c3, c4, c5, ok, err) {
            bridgeDebugLog('xmlhttpfull_request', {cb: cb || '', ck: ck || 0, url: String(u || '').substring(0, 120)});
            sendAsyncRequest(u, to, pm, m, h, function (status, text, responseUrl) {
                bridgeDebugLog('xmlhttpfull_response', {cb: cb || '', ck: ck || 0, status: status || 0, len: (text || '').length});
                call(cb, [res(status, text, ck, responseUrl), ck, c1, c2, c3, c4, c5, ok, err]);
            });
        };

        // --- Playback Start / Control ---

        // IMPLEMENTED: Start playback on main (player=0) or secondary (player>0) player.
        // Android: ExoPlayer.prepare() on primary or secondary instance.
        A.StartAuto = function (u, pl, t, rs, player) {
            bridgeDebugLog('start_auto', {type: t || 0, player: player || 0, hasPlaylist: !!(pl && pl.length), url: String(u || '').substring(0, 120)});
            if (player && player > 0) {
                if (!setPrev(u, pl, t, rs, 'extra', player, player)) return;
            } else setMain(u, pl, t, rs);
        };
        // IMPLEMENTED: Prepare preview player for quality switch (pause + set quality position).
        A.ReuseFeedPlayerPrepare = function (trackSelectorPos) {
            ps.qp = normalizeQualityPosition(trackSelectorPos, ps.q.length);
            if (pv) try { pv.pause(); } catch (e) {}
        };
        // IMPLEMENTED: Switch from feed/preview to main player, or restart secondary.
        A.ReuseFeedPlayer = function (u, pl, t, rs, player) {
            var targetPlayer = player && player > 0 ? player : 0;
            if (targetPlayer > 0) {
                A.StartAuto(u, pl, t, rs, targetPlayer);
                return;
            }
            // webOS has a single hardware video decoder.  The preview element must
            // be fully released before the main player can acquire it.  Always
            // clear preview here and let the normal StartAuto path (which runs
            // after an async API call) handle main playback — the network delay
            // gives the decoder time to release.
            if (reuseFeedSwitchTimerId) {
                w.clearTimeout(reuseFeedSwitchTimerId);
                reuseFeedSwitchTimerId = 0;
            }
            clear(pv);
            resetPreviewState();
        };
        // IMPLEMENTED: Recover video view state (e.g., after PiP toggle).
        A.FixViewPosition = function (position, type) {
            void position;
            if (!ms.uri && ps.uri) {
                setMain(ps.rawUri || ps.uri, ps.playlist, type || ps.type, ptime());
                clear(pv);
            } else {
                applyMainLayout();
                show(mv);
                if (mv) tryPlay(mv);
            }
            call('Play_UpdateDuration', [getMainDurationMs()]);
        };
        // IMPLEMENTED: Restart playback from cached state or trigger upstream reload.
        A.RestartPlayer = function (t, rs, player) {
            if (player && player > 0) {
                var prevSrc = ps.rawUri || ps.uri;
                if (prevSrc) {
                    setPrev(prevSrc, ps.playlist, t || ps.type, rs, ps.mode, ps.slot, ps.multi);
                } else if (w.Main_IsOn_OSInterface && w.Play_isOn && typeof w.Play_loadData === 'function') {
                    w.Play_loadData();
                }
                return;
            }
            var mainSrc = ms.rawUri || ms.uri;
            if (mainSrc) {
                setMain(mainSrc, ms.playlist, t || ms.type, rs);
                return;
            }
            if (!w.Main_IsOn_OSInterface) return;
            if (w.PlayVod_isOn && typeof w.PlayVod_loadData === 'function') {
                w.PlayVod_loadData();
            } else if (w.PlayClip_isOn && typeof w.PlayClip_onPlayer === 'function') {
                w.PlayClip_onPlayer();
            } else if (w.Play_isOn && typeof w.Play_loadData === 'function') {
                w.Play_loadData();
            }
        };
        // IMPLEMENTED: Switch stream quality by playlist position index.
        // Android: ExoPlayer TrackSelector. webOS: video.src swap from parsed playlist.
        A.SetQuality = function (pos) {
            if (!mv || ms.type === 3) return;
            var requestedPos = pos;
            ms.qp = normalizeQualityPosition(pos, ms.q.length);
            var tg = sourceFromQuality(ms, mainMaxRes);
            var currentSrc = (mv.currentSrc || mv.src || '');
            var sameTarget = !!(tg && (tg === currentSrc || tg === mv.src));
            bridgeDebugLog('set_quality_attempt', {
                rawPos: requestedPos,
                rawType: typeof requestedPos,
                pos: ms.qp,
                available: ms.q.length,
                hasTarget: !!tg,
                sameTarget: sameTarget
            });
            if (!tg) return;
            if (mseActive() || mainStreamFormat === 'fmp4') {
                // MSE mode: the blob src never equals a playlist URL, so the
                // target check compares against ms.uri (the active MSE variant).
                if (tg === ms.uri) return;
                ms.resume = ms.type === 2 ? mtime() : 0;
                if (!isFinite(ms.resume)) ms.resume = 0;
                ms.uri = tg;
                startMainPlayback(); // fetch the new playlist, restart MSE or native
                bridgeDebugLog('set_quality_applied', {pos: ms.qp, available: ms.q.length, mse: true, resume: ms.resume, type: ms.type});
                return;
            }
            if (mainStreamFormat === 'ts') {
                // Known MPEG-TS: direct native swap (the platform player handles
                // it, no probe needed).
                if (sameTarget) return;
                ms.resume = ms.type === 2 || ms.type === 3 ? mtime() : 0;
                if (!isFinite(ms.resume)) ms.resume = 0;
                ms.uri = tg;
                mv.src = tg;
                try { mv.load(); } catch (e) {}
                tryPlay(mv);
                bridgeDebugLog('set_quality_applied', {pos: ms.qp, available: ms.q.length, flow: 'native-ts'});
                return;
            }
            // Stream format unknown (e.g., after a session restore whose probe
            // failed): NEVER attach a raw URL directly - fMP4 would stall
            // forever on webOS 3.4. Run the full probe flow so fMP4 content is
            // routed to the local TS remux (or detected as TS and kept native).
            ms.resume = ms.type === 2 || ms.type === 3 ? mtime() : 0;
            if (!isFinite(ms.resume)) ms.resume = 0;
            ms.uri = tg;
            startMainPlayback();
            bridgeDebugLog('set_quality_applied', {pos: ms.qp, available: ms.q.length, flow: 'full-probe', resume: ms.resume, type: ms.type});
        };
        // IMPLEMENTED: Returns available quality options as JSON array.
        // Entries mirror Android's shape (id + band + codec) so the app's
        // quality OSD (id + band + codec concatenation) renders real strings
        // instead of "undefined".
        A.getQualities = function () {
            var arr = [{id: 'Auto', band: '', codec: ''}], i;
            for (i = 0; i < ms.q.length; i++) {
                var item = ms.q[i];
                var bw = item && item.bandwidth ? item.bandwidth : 0;
                var codecs = item && item.codecs ? String(item.codecs) : '';
                var codecLabel = '';
                if (codecs.indexOf('avc1') !== -1 || codecs.indexOf('avc3') !== -1) {
                    codecLabel = codecs.indexOf('mp4a') !== -1 ? ' | avc+mp4a' : ' | avc';
                } else if (codecs) {
                    codecLabel = ' | ' + codecs.split(',')[0];
                }
                arr.push({
                    id: item && item.id ? item.id : '',
                    band: bw ? ' | ' + (bw / 1000000).toFixed(2) + 'Mbps' : '',
                    codec: codecLabel
                });
            }
            bridgeDebugLog('get_qualities_called', {
                count: arr.length,
                ids: arr.map(function (entry) { return entry && entry.id ? entry.id : ''; }).slice(0, 8)
            });
            return JSON.stringify(arr);
        };
        // IMPLEMENTED: Sets max resolution cap for main player.
        A.SetMainPlayerBitrate = function (bitrate, resolution) {
            void bitrate;
            mainMaxRes = resolution && resolution > 0 ? parseInt(resolution, 10) + 10 : 0;
            if (ms.qp < 0 && ms.rawUri) A.SetQuality(-1);
        };
        // IMPLEMENTED: Sets max resolution cap for preview player.
        A.SetSmallPlayerBitrate = function (bitrate, resolution) {
            void bitrate;
            smallMaxRes = resolution && resolution > 0 ? parseInt(resolution, 10) + 10 : 0;
            if (ps.qp < 0 && ps.rawUri && pv && previewVideoShown) {
                ps.uri = sourceFromQuality(ps, smallMaxRes);
                pv.src = ps.uri;
                try { pv.load(); } catch (e) {}
            }
        };
        // IMPLEMENTED: Stops all playback and resets state. Android: ExoPlayer.stop()/release().
        A.stopVideo = function () {
            clear(mv);
            clear(pv);
            resetMainState();
            resetPreviewState();
            resetVideoStatusCounters();
            clearPreviewTracking();
            stopMainIfLeavingPlayerScene(40);
        };
        // IMPLEMENTED: Clears preview/small player.
        A.mClearSmallPlayer = function () {
            clear(pv);
            resetPreviewState();
            clearPreviewTracking();
            stopMainIfLeavingPlayerScene(120);
        };
        // IMPLEMENTED: Sets preview player size variant (1-3).
        A.SetPreviewSize = function (v) {
            previewSize = clamp(typeof v === 'number' ? v : parseInt(v, 10) || 1, 0, 3);
            if (ps.mode === 'feed') applyFeedLayout(ps.feedPos);
        };
        // IMPLEMENTED: Sets feed layout position.
        A.SetFeedPosition = function (position) {
            ps.feedPos = clamp(typeof position === 'number' ? position : parseInt(position, 10) || 2, 0, 4);
            if (ps.mode === 'feed') applyFeedLayout(ps.feedPos);
        };
        // HARDWARE-LTD: webOS hardware video pipeline cannot render into small CSS windows.
        // Android: secondary ExoPlayer renders feed thumbnails in small View.
        A.StartFeedPlayer = function (uri, playlist, position, resumePosition, isVod) {
            void uri;
            void playlist;
            void position;
            void resumePosition;
            void isVod;
        };
        // IMPLEMENTED: Sets feed bottom viewport position.
        A.SetPlayerViewFeedBottom = function (b, wh) {
            var vp = viewport();
            var sc = wh && wh > 0 ? vp.h / wh : 1;
            feedBottomPx = Math.max(0, Math.floor(vp.h - b * sc));
            if (ps.mode === 'feed') applyFeedLayout(ps.feedPos);
        };
        // IMPLEMENTED: Sets side panel viewport.
        A.SetPlayerViewSidePanel = function (b, r, l, wh) {
            sideRect = calcPreviewRect(b, r, l, wh, false);
            if (ps.mode === 'side') applyPreviewModeLayout();
        };
        // HARDWARE-LTD: Same as StartFeedPlayer — small video windows not supported.
        A.StartSidePanelPlayer = function (uri, playlist) {
            void uri;
            void playlist;
        };
        // HARDWARE-LTD: Multi-screen/PiP not available (single decoder).
        A.StartScreensPlayer = function (position, uri, playlist, bottom, right, left, webHeight, whoCalled, isBig) {
            void position;
            void uri;
            void playlist;
            void bottom;
            void right;
            void left;
            void webHeight;
            void whoCalled;
            void isBig;
        };
        // HARDWARE-LTD: Restore multi-screen — no-op on webOS.
        A.ScreenPlayerRestore = function (bottom, right, left, webHeight, whoCalled, isBig) {
            void bottom;
            void right;
            void left;
            void webHeight;
            void whoCalled;
            void isBig;
        };
        // NO-OP: Side panel restore.
        A.SidePanelPlayerRestore = function () {};
        // IMPLEMENTED: Clears feed player.
        A.ClearFeedPlayer = function () { clear(pv); clearPreviewTracking(); };
        // IMPLEMENTED: Clears side panel player.
        A.ClearSidePanelPlayer = function () { clear(pv); clearPreviewTracking(); };
        // HARDWARE-LTD: Multi-stream rejected with user notice (single decoder).
        A.StartMultiStream = function (position, uri, playlist, restart) {
            void uri;
            void playlist;
            void restart;
            rejectMultiStream(typeof position === 'number' ? position : 0);
        };
        // HARDWARE-LTD: Multi-stream enable rejected with notice.
        A.EnableMultiStream = function (mainBig, offset) {
            void mainBig;
            void offset;
            showMultiLimitNotice();
        };
        // IMPLEMENTED: Disables multi-stream mode.
        A.DisableMultiStream = function () { ps.mode = 'preview'; clear(pv); };

        // --- Layout / PiP Methods ---

        // IMPLEMENTED: Sets PiP position (0-7 = corners and edges).
        A.mSetPlayerPosition = function (v) { picPos = clamp(typeof v === 'number' ? v : parseInt(v, 10) || 4, 0, 7); if (ps.mode === 'extra' || ps.mode === 'preview') applyPreviewPiPLayout(); };
        // IMPLEMENTED: Sets PiP size variant (0-4).
        A.mSetPlayerSize = function (v) { picSize = clamp(typeof v === 'number' ? v : parseInt(v, 10) || 2, 0, 4); if (ps.mode === 'extra' || ps.mode === 'preview') applyPreviewPiPLayout(); };
        // ALIAS: Maps to mSetPlayerPosition.
        A.mSwitchPlayerPosition = A.mSetPlayerPosition;
        // ALIAS: Maps to mSetPlayerSize.
        A.mSwitchPlayerSize = A.mSetPlayerSize;
        // IMPLEMENTED: Swaps main and preview players (sources, positions, resume points).
        A.mSwitchPlayer = function () {
            if (!ms.uri || !ps.uri) return;
            if (ps.mode === 'multi' || ps.mode === 'extra' || ps.mode === 'feed' || ps.mode === 'side' || ps.mode === 'screens') {
                showMultiLimitNotice();
                return;
            }
            var m = {u: ms.uri, p: ms.playlist, t: ms.type}, p0 = {u: ps.uri, p: ps.playlist, t: ps.type}, mt = mtime(), pt = ptime();
            setMain(p0.u, p0.p, p0.t, pt);
            setPrev(m.u, m.p, m.t, mt, ps.mode, ps.slot, ps.multi);
        };
        // IMPLEMENTED: Toggles fullscreen main-player layout state and reapplies active layout mode.
        A.mupdatesize = function (f) { isFull = Boolean(f); applyMainLayout(); if (ps.mode === 'extra' || ps.mode === 'preview') applyPreviewPiPLayout(); };
        // ALIAS: Legacy Android name for mupdatesize().
        A.mupdatesizePP = A.mupdatesize;
        // IMPLEMENTED: Sets fullscreen position preset (left/right style variants from Android UI).
        A.SetFullScreenPosition = function (v) { fsPos = clamp(typeof v === 'number' ? v : parseInt(v, 10) || 0, 0, 1); applyMainLayout(); };
        // IMPLEMENTED: Sets fullscreen size preset and reapplies main layout.
        A.SetFullScreenSize = function (v) { fsSize = clamp(typeof v === 'number' ? v : parseInt(v, 10) || 3, 0, 6); applyMainLayout(); };
        // --- Settings / Configuration Methods ---

        // NO-OP: Android sets ExoPlayer latency mode (low-latency/speed). HTML5 video has no equivalent knob.
        A.mSetlatency = function (latency) {
            void latency;
        };
        // NO-OP: Android switches between SurfaceView/TextureView and fullscreen. webOS uses a single <video> element.
        A.msetPlayer = function (surfaceView, isFullScreen) {
            void surfaceView;
            void isFullScreen;
        };
        // IMPLEMENTED: Sets document language attribute for localization.
        // Android: SetLanguage() stores lang pref in SharedPreferences + updates resources.
        // webOS: Sets <html lang="..."> — sufficient for CSS :lang() selectors.
        A.SetLanguage = function (lang) {
            if (w.document && w.document.documentElement && typeof lang === 'string' && lang) {
                w.document.documentElement.lang = lang;
            }
        };
        // ALIAS: Maps to SetLanguage.
        A.upDateLang = A.SetLanguage;
        // NO-OP: Android stores Twitch API credentials in SharedPreferences. webOS uses upstream JS-side storage.
        A.setAppIds = function (clientId, clientSecret, redirectUri) {
            void clientId;
            void clientSecret;
            void redirectUri;
        };
        // NO-OP: Android adjusts ExoPlayer speed correction. HTML5 video handles clock sync internally.
        A.setSpeedAdjustment = function (speedAdjustment) {
            void speedAdjustment;
        };
        // NO-OP: Android configures source-check interval for stream health monitoring. Not applicable to HTML5 video.
        A.SetCheckSource = function (checkSource) {
            void checkSource;
        };
        // NO-OP: Android configures ExoPlayer buffer sizes (minBuffer, maxBuffer, playbackBuffer). HTML5 video manages buffering internally.
        A.SetBuffer = function () {};
        // NO-OP: Android sets position polling timeout for seek-bar updates. webOS uses timeupdate event (~4Hz).
        A.SetCurrentPositionTimeout = function () {};
        // NO-OP: Android calls PowerManager WakeLock. webOS keeps screen on via app lifecycle (foreground = always on).
        A.mKeepScreenOn = function (keepOn) {
            void keepOn;
        };
        // IMPLEMENTED: Sets opacity on the key-overlay UI element.
        // Android: SetKeysOpacity() sets alpha on KeysView. webOS: Sets CSS opacity on #scene_keys.
        A.SetKeysOpacity = function (value) { keyUiOpacity = clamp((parseFloat(value) || 100) / 100, 0, 1); var el = w.document.getElementById('scene_keys'); if (el) el.style.opacity = String(keyUiOpacity); };
        // NO-OP: Android positions the keys overlay via LayoutParams. webOS key overlay is CSS-positioned.
        A.SetKeysPosition = function (position) {
            void position;
        };
        // --- Notification Service Methods (all NO-OP) ---
        // Android runs a background NotificationService polling Twitch for live/title/game changes.
        // webOS has no background service runtime — all notification methods are no-ops.

        // NO-OP: Android positions notification popup via WindowManager LayoutParams.
        A.SetNotificationPosition = function (position) {
            void position;
        };
        // NO-OP: Android sets notification polling repeat interval (AlarmManager).
        A.SetNotificationRepeat = function (repeat) {
            void repeat;
        };
        // NO-OP: Android sets the "since" timestamp to filter only new notifications.
        A.SetNotificationSinceTime = function (sinceTime) {
            void sinceTime;
        };
        // NO-OP: Android starts the background notification polling service.
        A.RunNotificationService = function () {};
        // NO-OP: Android stops the background notification polling service.
        A.StopNotificationService = function () {};
        // NO-OP: Android enables/disables the notification system globally.
        A.upNotificationState = function (notify) {
            void notify;
        };
        // NO-OP: Android toggles notifications for live-status changes.
        A.SetNotificationLive = function (notify) {
            void notify;
        };
        // NO-OP: Android toggles notifications for stream title changes.
        A.SetNotificationTitle = function (notify) {
            void notify;
        };
        // NO-OP: Android toggles notifications for game/category changes.
        A.SetNotificationGame = function (notify) {
            void notify;
        };
        // NO-OP: Android configures ping/latency warning thresholds.
        A.Settings_SetPingWarning = function (warning) {
            void warning;
        };
        // --- Block-List / Codec / Player Reuse Methods (all NO-OP) ---
        // Android stores block-lists in SharedPreferences and filters content in-app.
        // webOS: Upstream JS handles filtering; bridge does not need native storage.

        // NO-OP: Android persists blocked channels list to SharedPreferences.
        A.UpdateBlockedChannels = function (channelsJson) {
            void channelsJson;
        };
        // NO-OP: Android persists blocked games list to SharedPreferences.
        A.UpdateBlockedGames = function (gamesJson) {
            void gamesJson;
        };
        // NO-OP: Android stores Twitch user credentials in SharedPreferences for API calls.
        A.UpdateUserId = function (id, name, token) {
            void id;
            void name;
            void token;
        };
        // NO-OP: Android blacklists specific media codecs in ExoPlayer. HTML5 video codec selection is browser-controlled.
        A.setBlackListMediaCodec = function (codecList) {
            void codecList;
        };
        // NO-OP: Android blacklists specific quality levels. webOS quality selection handled by bridge quality picker.
        A.setBlackListQualities = function (qualitiesList) {
            void qualitiesList;
        };
        // NO-OP: Android checks if ExoPlayer instance can be reused for next stream. webOS always reuses <video> elements.
        A.CheckReUsePlayer = function () {};

        // --- Android System UI / Keyboard Methods (all NO-OP) ---
        // These control Android-specific system chrome and soft keyboard — not applicable to webOS TV.

        // NO-OP: Android hides system navigation/status bars (immersive mode). webOS apps are always fullscreen.
        A.mhideSystemUI = function () {};
        // NO-OP: Android dismisses soft keyboard via InputMethodManager.
        A.KeyboardCheckAndHIde = function () {};
        // NO-OP: Android hides soft keyboard from a specific view.
        A.hideKeyboardFrom = function () {};
        // NO-OP: Android shows soft keyboard for a specific view.
        A.showKeyboardFrom = function () {};
        // NO-OP: Android checks if a hardware keyboard is connected. webOS TV always uses remote control.
        A.isKeyboardConnected = function () { return false; };
        // NO-OP: Android sets body click listeners for focus management. webOS uses remote-control key events.
        A.initbodyClickSet = function () {};
        // IMPLEMENTED: Clears cookies for current domain to support logout/session reset flows.
        A.clearCookie = clearCookiesForCurrentDomain;
        // IMPLEMENTED: Returns current main playback position in milliseconds.
        A.gettime = function () { return getMainCurrentTimeMs(); };
        // ALIAS: Android compatibility alias for gettime().
        A.getsavedtime = A.gettime;
        // IMPLEMENTED: Returns current preview playback position in milliseconds.
        A.gettimepreview = function () { return getPreviewCurrentTimeMs(); };
        // IMPLEMENTED: Seeks main player to position in milliseconds and persists resume for VOD/clip types.
        A.mseekTo = function (pos) {
            var positionMs = Math.max(0, parseInt(pos, 10) || 0);
            seekMainToMs(positionMs);
            if (ms.type === 2 || ms.type === 3) ms.resume = positionMs;
        };
        // IMPLEMENTED: Explicit play/pause control for both main and preview players.
        A.PlayPause = function (st) {
            var shouldPlay = !!st;
            var targets = [mv, pv];
            var i;
            for (i = 0; i < targets.length; i++) {
                var video = targets[i];
                if (!video) continue;
                if (shouldPlay) tryPlay(video);
                else try { video.pause(); } catch (e) {}
            }
        };
        // IMPLEMENTED: Toggles playback state based on main player pause flag and notifies upstream callback.
        A.PlayPauseChange = function () {
            if (!mv) return;
            var nextPlaying = mv.paused;
            A.PlayPause(nextPlaying);
            call('Play_PlayPauseChange', [nextPlaying, ms.type || 1]);
        };
        // IMPLEMENTED: Returns current main playback state (true=playing, false=paused/stopped).
        A.getPlaybackState = function () { return mv ? !mv.paused : false; };
        // IMPLEMENTED: Applies playback rate to main and preview players (Android parity with ExoPlayer speed).
        A.setPlaybackSpeed = function (sp) {
            var speed = parseFloat(sp);
            if (!isFinite(speed) || speed <= 0) speed = 1;
            if (mv) try { mv.playbackRate = speed; } catch (e) {}
            if (pv) try { pv.playbackRate = speed; } catch (e2) {}
        };
        // IMPLEMENTED: Returns main duration in milliseconds through callback (Android async callback style).
        A.getDuration = function (cb) {
            var d = getMainDurationMs();
            call(cb, [d]);
        };
        // IMPLEMENTED: Emits screen-duration update payload used by upstream progress UI.
        A.updateScreenDuration = function (cb, key, objId) {
            var d = getMainDurationMs();
            call(cb, [objId, key, d]);
        };
        // IMPLEMENTED: Builds and forwards telemetry payload with bitrate, fps, dropped frames, and optional latency.
        A.getVideoStatus = function (sl, wc) {
            var showLatency = Boolean(sl);
            var whoCalled = parseInt(wc, 10) || 0;
            var payload = buildVideoStatusPayload(showLatency, mv, false);
            call('Play_ShowVideoStatus', [showLatency, whoCalled, JSON.stringify(payload)]);
        };
        // IMPLEMENTED: Returns currently selected quality label (or Auto).
        A.getVideoQuality = function (wc) { var v = ms.qp >= 0 && ms.q[ms.qp] ? ms.q[ms.qp].id : 'Auto'; call('Play_ShowVideoQuality', [wc, v]); };
        // IMPLEMENTED: Calculates live latency offset and forwards it to chat bridge API.
        A.getLatency = function (n) {
            var chatNumber = parseInt(n, 10);
            if (!isFinite(chatNumber) || chatNumber < 0) chatNumber = 0;
            var video = chatNumber === 1 && pv ? pv : mv;
            var duration = video === pv ? getPreviewDurationMs() : getMainDurationMs();
            var position = video === pv ? getPreviewCurrentTimeMs() : getMainCurrentTimeMs();
            var liveOffset = getCurrentLiveOffsetMs(video, duration, position, video === pv);
            call('ChatLive_SetLatency', [chatNumber, liveOffset]);
        };
        // IMPLEMENTED: Applies per-channel enabled flags for audio mixer logic.
        A.SetAudioEnabled = function (a0, a1, a2, a3) {
            audioEnabled = [Boolean(a0), Boolean(a1), Boolean(a2), Boolean(a3)];
            applyAudio();
        };
        // IMPLEMENTED: Sets normalized per-channel volume scalars and reapplies audio state.
        A.SetVolumes = function (v0, v1, v2, v3) {
            audioVolumes = [clamp(v0, 0, 1), clamp(v1, 0, 1), clamp(v2, 0, 1), clamp(v3, 0, 1)];
            applyAudio();
        };
        // ALIAS: Explicit Android method name for applyAudio().
        A.ApplyAudio = applyAudio;
        // IMPLEMENTED: Sets preview channel relative volume percentage.
        A.SetPreviewAudio = function (v) { previewScale = clamp(v / 100, 0, 1); applyAudio(); };
        // IMPLEMENTED: Sets cap for non-focused preview channel volume percentage.
        A.SetPreviewOthersAudio = function (v) { previewCap = clamp(v / 100, 0, 1); applyAudio(); };
        // IMPLEMENTED: Converts Android key index to DOM keycode and dispatches keydown/keyup.
        A.keyEvent = function (k, a) { var map = [38, 40, 37, 39, 13, BACK_DISPATCH_KEY, 33, 34, 51], code = map[k]; dispatchBodyKey(code, a === 1); };
        // ALIAS: Android external URL launch methods mapped to shared launcher.
        A.OpenExternal = launchExternal; A.OpenURL = launchExternal;
        // IMPLEMENTED: Navigates current page to provided URL.
        A.mloadUrl = function (u) {
            if (!u) return;
            w.location.href = u;
        };
        // IMPLEMENTED: Stops players, clears caches/cookies, then reloads normalized target URL.
        A.CleanAndLoadUrl = function (u) {
            clear(mv);
            clear(pv);
            var done = function () {
                w.location.replace(normalizeReloadUrl(u));
            };
            try {
                var cachePromise = clearRuntimeCaches();
                if (cachePromise && typeof cachePromise.then === 'function') {
                    cachePromise.then(done, done);
                } else {
                    done();
                }
            } catch (e) {
                done();
            }
        };
        // IMPLEMENTED: Returns current page URL string.
        A.mPageUrl = function () { return w.location.href || ''; };
        // IMPLEMENTED: Routes close/back through webOS platform APIs, with window close fallback.
        A.mclose = function (c) {
            if (w.webOS && typeof w.webOS.platformBack === 'function') {
                w.webOS.platformBack();
                return;
            }
            if (w.PalmSystem && w.PalmSystem.platformBack) {
                w.PalmSystem.platformBack();
                return;
            }
            if (c) try { w.close(); } catch (e) {}
        };
        // IMPLEMENTED: Explicit upstream API to force main loading spinner visibility.
        A.mshowLoading = function (s) { if (Boolean(s)) requestMainLoadingShow(); else setMainLoading(false); };
        // IMPLEMENTED: Explicit upstream API to force feed loading spinner visibility.
        A.mshowLoadingBottom = function (s) { setFeedLoading(Boolean(s)); };
        // IMPLEMENTED: Adds/removes click-avoidance CSS class for key overlay.
        A.AvoidClicks = function (a) { var e = w.document.getElementById('scene_keys'); if (e) e.classList[a ? 'add' : 'remove']('avoidclicks'); };
        // IMPLEMENTED: Returns bridge compatibility version string.
        A.getversion = getCompatibleVersion;
        // IMPLEMENTED: Debug flag parity method; webOS bridge debug remains off by default.
        A.getdebug = function () { return false; };
        // IMPLEMENTED: Returns device model from webOS `deviceInfo` API (fallback: "webOS TV").
        A.getDevice = function () { return cachedDeviceInfo.modelName || 'webOS TV'; };
        // IMPLEMENTED: Returns TV manufacturer constant for Android parity.
        A.getManufacturer = function () { return 'LG'; };
        // IMPLEMENTED: Returns parsed webOS platform major version as SDK surrogate.
        A.getSDK = function () { return parseInt(cachedDeviceInfo.platformVersionMajor || 0, 10) || 0; };
        // IMPLEMENTED: Android compatibility check, always true for this target runtime.
        A.deviceIsTV = function () { return true; };
        // IMPLEMENTED: Returns User-Agent string as webview version surrogate.
        A.getWebviewVersion = function () { return ua || ''; };
        // IMPLEMENTED: Returns synthetic codec capability payload for upstream codec/settings UI.
        // Probes canPlayType so the app only requests codecs this browser can
        // actually decode (Chrome 38/webOS 3.4 has no AV1; claiming it made the
        // app request supported_codecs=av1 and native ABR could pick a variant
        // that never decodes).
        A.getcodecCapabilities = function (ct) {
            var type = ct === 'hevc' ? 'hevc' : ct === 'av01' ? 'av01' : 'avc';
            var mime = type === 'hevc' ? 'video/hevc' : type === 'av01' ? 'video/av01' : 'video/avc';
            var probe = type === 'hevc' ? 'video/mp4; codecs="hvc1.1.6.L93.B0"' : type === 'av01' ? 'video/mp4; codecs="av01.0.04M.08"' : 'video/mp4; codecs="avc1.64002A"';
            var supported = type === 'avc';
            try {
                if (!supported && w.document && w.document.createElement) {
                    supported = !!w.document.createElement('video').canPlayType(probe);
                }
            } catch (eProbe) {
                supported = type === 'avc';
            }
            if (!supported) return '[]';
            var n = 'webos.' + type + '.decoder';
            return JSON.stringify([{CanonicalName: n, instances: 2, isHardwareAccelerated: true, isSoftwareOnly: false, name: n, nameType: n + mime, type: mime, supportsIsHw: true, resolutions: 'Unknown', maxresolution: 'Unknown', maxbitrate: 'Unknown', maxlevel: 'Unknown'}]);
        };
        // NO-OP: Android reads accessibility service state; webOS bridge does not expose that signal.
        A.isAccessibilitySettingsOn = function () { return false; };
        // IMPLEMENTED (compat): Notification permission considered granted to avoid upstream gating.
        A.hasNotificationPermission = function () { return true; };
        // IMPLEMENTED (compat): Install source check returns true to satisfy Android guard paths.
        A.getInstallFromPLay = function () { return true; };
        // NO-OP: Android shows native Toast message; webOS bridge leaves UI messaging to upstream JS.
        A.showToast = function (toast) {
            void toast;
        };
        // NO-OP: Android writes extended logs to Logcat; webOS build intentionally suppresses bridge chatter.
        A.LongLog = function (log) {
            void log;
        };
        // IMPLEMENTED: Returns persisted app token used by some API auth flows.
        A.getAppToken = function () { return appToken; };
        // IMPLEMENTED: Persists app token in localStorage for session restore.
        A.setAppToken = function (t) { appToken = t || null; try { if (appToken) w.localStorage.setItem(STORAGE_PREFIX + 'app_token', appToken); else w.localStorage.removeItem(STORAGE_PREFIX + 'app_token'); } catch (e) {} };
        // NO-OP: Android can return last launch intent extras; webOS does not provide an equivalent object here.
        A.GetLastIntentObj = function () { return null; };
        // IMPLEMENTED: Triggers upstream channel-refresh event callback.
        A.mCheckRefresh = function (t) { call('Main_EventChannelRefresh', [t]); };
        // NO-OP: Android may show refresh toast UI; not needed in webOS bridge layer.
        A.mCheckRefreshToast = function (type) {
            void type;
        };
        // IMPLEMENTED (compat): Android APK update flow is not available; fallback performs hard reload.
        A.UpdateAPK = function (apkUrl, failAll, failDownload) {
            void apkUrl;
            void failAll;
            void failDownload;
            A.CleanAndLoadUrl(A.mPageUrl());
        };
        // Ensure queued calls made before bridge readiness are replayed onto the final Android shim.
        drainEarlyAndroidShimQueue(A);
        // Remove temporary early-shim markers to leave a clean final API surface.
        clearEarlyAndroidShimFlags(A);
        // Publish final compatibility object.
        w.Android = A;
    }

    // Purpose: Normalizes webOS launch/relaunch events and applies launch-target navigation once.
    // Android: Comparable behavior comes from Intent handling in activity lifecycle callbacks.
    // webOS: Uses custom DOM events (`webOSLaunch`/`webOSRelaunch`) emitted by wrapper shell.
    function handleLaunchEvent(eventName, eventDetail) {
        var isRelaunch = eventName === 'webOSRelaunch';
        var isSystemLaunchEvent = eventName === 'webOSLaunch' || eventName === 'webOSRelaunch';
        if (isSystemLaunchEvent) {
            launchSystemEventSeen = true;
        }
        if (isRelaunch) {
            clearScheduledLifecycleStop();
            recoverOSInterfaceState();
            tryLifecycleResume();
        }
        var params = resolveLaunchParams(eventDetail);
        var targetUrl = pickLaunchTarget(params);
        if (targetUrl) {
            var currentComparable = comparableLaunchTarget((w.location && w.location.href) || '');
            var targetComparable = comparableLaunchTarget(targetUrl);
            if (targetComparable && targetComparable !== currentComparable && targetComparable !== launchLastComparableTarget) {
                launchLastComparableTarget = targetComparable;
                var launchUrl = withLaunchNavigationToken(targetUrl);
                if (launchUrl) {
                    w.location.replace(launchUrl);
                }
            }
        }
        if (isRelaunch) activateAppWindow();
    }
    // Purpose: Clears pending bootstrap launch fallback timer to avoid duplicate launch handling.
    function clearLaunchBootstrapTimer() {
        if (!launchBootstrapTimerId) return;
        w.clearTimeout(launchBootstrapTimerId);
        launchBootstrapTimerId = 0;
    }
    // Purpose: Installs webOS launch/relaunch listeners and a bootstrap fallback when wrapper events are absent.
    // Android: Equivalent to activity onCreate/onNewIntent bootstrap path.
    function initLaunch() {
        if (launchEventHandlersInstalled || !w.document || typeof w.document.addEventListener !== 'function') return;
        launchEventHandlersInstalled = true;
        launchSystemEventSeen = false;
        clearLaunchBootstrapTimer();
        var onLaunch = function (event) {
            launchSystemEventSeen = true;
            clearLaunchBootstrapTimer();
            handleLaunchEvent(event && event.type ? event.type : 'webOSLaunch', event && event.detail ? event.detail : null);
        };
        w.document.addEventListener('webOSLaunch', onLaunch, true);
        w.document.addEventListener('webOSRelaunch', onLaunch, true);
        launchBootstrapTimerId = w.setTimeout(function () {
            launchBootstrapTimerId = 0;
            if (launchSystemEventSeen) return;
            handleLaunchEvent('bootstrap', null);
        }, 450);
    }

    // Purpose: Re-seeds OSInterface globals after relaunch and reapplies browser-fallback suppression.
    // Android: Activity recreation restores static globals/services automatically; webOS needs explicit repair.
    function recoverOSInterfaceState() {
        if (!w.Android || !w.Android.__isWebOSPolyfill) return false;
        seedOsInterfaceGlobalsEarly();
        var hasGlobalState = typeof w.Main_IsOn_OSInterface !== 'undefined';
        if (!hasGlobalState || !w.Main_IsOn_OSInterface) {
            try {
                w.Main_IsOn_OSInterfaceVersion = w.Android.getversion();
                w.Main_isDebug = !!w.Android.getdebug();
                w.Main_IsOn_OSInterface = true;
                if (typeof w.KEY_RETURN !== 'undefined') w.KEY_RETURN = BACK_DISPATCH_KEY;
                if (w.document && w.document.body && w.document.body.style) {
                    w.document.body.style.backgroundColor = 'rgba(0,0,0,0)';
                }
                if (typeof w.Main_RemoveClass === 'function') w.Main_RemoveClass('scenefeed', 'feed_screen_input');
                if (typeof w.Main_ShowElement === 'function') w.Main_ShowElement('scene_keys');
                if (typeof w.OSInterface_setAppIds === 'function' && typeof w.AddCode_backup_client_id !== 'undefined') {
                    w.OSInterface_setAppIds(w.AddCode_backup_client_id, null, null);
                }
                if (typeof w.Main_HideElement === 'function') {
                    w.Main_HideElement('player_embed_clicks');
                    w.Main_HideElement('twitch-embed');
                    w.Main_HideElement('clip_embed');
                }
                browserFallbackCacheAt = 0;
                if (typeof w.BrowserTestPlayerEnded === 'function') {
                    w.BrowserTestPlayerEnded(true);
                }
                if (typeof w.BrowserTestStopClip === 'function') {
                    w.BrowserTestStopClip();
                }
                setMainLoading(false);
                setFeedLoading(false);
            } catch (e) {
                return false;
            }
        }

        if (typeof w.enable_embed !== 'undefined') {
            w.enable_embed = false;
        }
        if (w.Settings_value && w.Settings_value.enable_embed) {
            w.Settings_value.enable_embed.defaultValue = 1;
        }
        browserFallbackCacheAt = 0;
        if (mv) {
            var mainDisplay = mv.style && typeof mv.style.display === 'string' ? mv.style.display : '';
            mainVideoShown = mainDisplay !== 'none';
        } else {
            mainVideoShown = false;
        }
        if (pv) {
            var previewDisplay = pv.style && typeof pv.style.display === 'string' ? pv.style.display : '';
            previewVideoShown = previewDisplay !== 'none';
        } else {
            previewVideoShown = false;
        }
        patchNoBrowserFallbackFlow();
        return true;
    }

    // --- Bridge bootstrap sequence ---
    // 1) Publish Android compatibility API surface.
    initAndroid();
    // 2) Attach webOS lifecycle listeners (visibility/pageshow/back handling).
    installLifecycleHooks();
    // 3) Force webOS-safe defaults in shared Settings_value tree.
    applyWebOSDefaultSettings();
    // 4) Keep legacy KEY_RETURN/back aliases consistent.
    enforceBackKeyConstant();
    // 5) Patch upstream back-key bridge callsites.
    installBackAliasBridge();
    w.__sttvWebOSBridgeReady = true;
    // 6) Restore OSInterface globals once bridge is available.
    recoverOSInterfaceState();
    // 7) Resume any playback/lifecycle work deferred during hidden state.
    tryLifecycleResume();
    // 8) Patch selected upstream update flows with webOS-safe variants.
    patchMainUpdateFlow();
    patchUpdateResultFlow();
    ensureVodSafetyPatches();
    // Keep upstream proxy selection behavior. Bridge does not force provider defaults.
    // 9) Install launch/relaunch event bridge.
    initLaunch();
    // 10) Harden scene transitions and start player-scene optimizer.
    installSceneSafetyPatches();
    installPlayerSceneOptimizerMonitor();
    // 11) Start periodic version checks.
    checkForkVersionAndRefresh();
    versionRefreshIntervalId = w.setInterval(checkForkVersionAndRefresh, VERSION_REFRESH_MIN_INTERVAL_MS);
    // 12) Restore app token from persisted storage (legacy key fallback included).
    try { appToken = w.localStorage ? (w.localStorage.getItem(STORAGE_PREFIX + 'app_token') || w.localStorage.getItem('sttv_webos_app_token')) : null; } catch (e) { appToken = null; }
    // 13) Pre-spawn the local HLS service so the first live/VOD playlist fetch
    // does not include the node cold-start inside its playback watchdog.
    w.setTimeout(warmUsherPlaylistService, 1000);
    // 14) sttv_serve lifecycle: ensure the local remux server while this app
    //     page lives, and stop it on page teardown (app close) so it does not
    //     keep running in the background after SmartTwitch is closed.
    //     - heartbeat ping every 10s (see sttvServeHeartbeat) lets the server
    //       self-stop when the app is closed/killed even if unload hooks
    //       never fire, and restarts it if it died while we were suspended;
    //     - pagehide/beforeunload give the immediate stop when they do fire;
    //     - becoming visible again re-ensures it (it may have self-stopped
    //       while the page was hidden/suspended).
    ensureSttvServe();
    var stopSttvServeOnClose = function () {
        if (sttvHeartbeatTimerId > 0) {
            w.clearInterval(sttvHeartbeatTimerId);
        }
        sttvHeartbeatTimerId = -1; // block heartbeat restarts during teardown
        stopSttvServe();
    };
    w.addEventListener('pagehide', stopSttvServeOnClose);
    w.addEventListener('beforeunload', stopSttvServeOnClose);
    w.document.addEventListener(
        'visibilitychange',
        function () {
            if (!w.document.hidden && !w.document.webkitHidden) ensureSttvServe();
        },
        true
    );
})(window);
