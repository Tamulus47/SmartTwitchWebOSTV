(function (global) {
    'use strict';

    var DEFAULT_TARGET_URL = 'https://tamulus47.github.io/SmartTwitchWebOSTV/release/index.html';
    var LAUNCH_TOKEN_PARAM = 'sttv_webos_launch';
    var launchHandlersInstalled = false;
    var launchBootstrapTimerId = 0;
    var launchSystemEventSeen = false;
    var launchNavigationCommitted = false;
    var BOOTSTRAP_FALLBACK_DELAY_MS = 450;
    function isDebugEnabled() {
        try {
            if (global.location && typeof global.location.search === 'string' && /(?:\?|&)sttv_debug=1(?:&|$)/.test(global.location.search)) return true;
        } catch (e) {}
        try {
            return !!(global.localStorage && global.localStorage.getItem('STTV_DEBUG') === '1');
        } catch (e2) {
            return false;
        }
    }
    var DEBUG = isDebugEnabled();
    function debugLog(event, extra) {
        if (!DEBUG) return;
        var payload = {
            event: event || 'event',
            t: Date.now()
        };
        if (extra && typeof extra === 'object') {
            var k;
            for (k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
            }
        }
        try {
            console.log('[STTV wrapper]', JSON.stringify(payload));
        } catch (e) {}
    }

    function safeJsonParse(value, fallback) {
        if (!value || typeof value !== 'string') return fallback;

        try {
            return JSON.parse(value);
        } catch (error) {
            return fallback;
        }
    }
    function normalizeParams(raw) {
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        return safeJsonParse(raw, {});
    }
    function readPalmLaunchParams() {
        if (!global.PalmSystem || typeof global.PalmSystem.launchParams === 'undefined' || global.PalmSystem.launchParams === null || global.PalmSystem.launchParams === '') {
            return {available: false, params: {}};
        }
        return {available: true, params: normalizeParams(global.PalmSystem.launchParams)};
    }
    function parseLaunchParams(eventDetail) {
        if (eventDetail && typeof eventDetail === 'object') return eventDetail;

        var palm = readPalmLaunchParams();
        if (palm.available) return palm.params;
        return normalizeParams(global.launchParams);
    }
    function isHttpUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function pickTarget(params) {
        if (params && isHttpUrl(params.target)) {
            return params.target;
        }

        if (params && isHttpUrl(params.contentTarget)) {
            return params.contentTarget;
        }

        return DEFAULT_TARGET_URL;
    }
    function withLaunchToken(url) {
        if (!url || typeof url !== 'string') return DEFAULT_TARGET_URL;
        try {
            var parsed = new URL(url);
            parsed.searchParams.set(LAUNCH_TOKEN_PARAM, String(Date.now()));
            return parsed.toString();
        } catch (error) {
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            return url + sep + LAUNCH_TOKEN_PARAM + '=' + Date.now();
        }
    }

    function comparableUrl(url) {
        if (!url || typeof url !== 'string') return '';
        try {
            var parsed = new URL(url, global.location && global.location.href ? global.location.href : undefined);
            parsed.searchParams.delete(LAUNCH_TOKEN_PARAM);
            parsed.searchParams.delete('sttv_update');
            return parsed.origin + parsed.pathname + parsed.search;
        } catch (error) {
            var idx = url.indexOf('?');
            return idx >= 0 ? url.slice(0, idx) : url;
        }
    }
    function shouldNavigate(target) {
        var currentUrl = global.location && global.location.href ? comparableUrl(global.location.href) : '';
        var nextUrl = comparableUrl(target);
        if (!nextUrl) return false;
        if (!currentUrl) return true;
        return currentUrl !== nextUrl;
    }
    function activateApp() {
        try {
            if (global.webOSSystem && typeof global.webOSSystem.activate === 'function') {
                global.webOSSystem.activate();
                return;
            }
        } catch (e) {}
        try {
            if (global.PalmSystem && typeof global.PalmSystem.activate === 'function') {
                global.PalmSystem.activate();
            }
        } catch (e2) {}
    }
    function clearBootstrapLaunchTimer() {
        if (!launchBootstrapTimerId) return;
        global.clearTimeout(launchBootstrapTimerId);
        launchBootstrapTimerId = 0;
    }
    function launch(eventName, eventDetail) {
        if (launchNavigationCommitted) {
            if (eventName === 'webOSRelaunch') activateApp();
            debugLog('launch_skip_committed', {launchEvent: eventName || 'launch'});
            return;
        }
        var params = parseLaunchParams(eventDetail);
        var target = pickTarget(params);
        debugLog('launch_received', {
            launchEvent: eventName || 'launch',
            hasEventDetail: !!(eventDetail && typeof eventDetail === 'object'),
            hasTarget: !!target
        });
        if (eventName === 'webOSRelaunch') activateApp();
        if (!shouldNavigate(target)) {
            debugLog('launch_skip_same_target', {launchEvent: eventName || 'launch'});
            return;
        }
        target = withLaunchToken(target);

        if (!target) return;
        launchNavigationCommitted = true;
        debugLog('launch_navigate', {launchEvent: eventName || 'launch', target: comparableUrl(target)});
        if (isHttpUrl(target)) {
            gatedNavigate(target);
        } else {
            global.location.replace(target);
        }
    }
    function installLaunchHandlers() {
        if (launchHandlersInstalled || !global.document || typeof global.document.addEventListener !== 'function') return;
        launchSystemEventSeen = false;
        clearBootstrapLaunchTimer();
        var onLaunch = function (event) {
            launchSystemEventSeen = true;
            clearBootstrapLaunchTimer();
            debugLog('launch_event', {launchEvent: event && event.type ? event.type : 'webOSLaunch'});
            launch(event && event.type ? event.type : 'webOSLaunch', event && event.detail ? event.detail : null);
        };
        global.document.addEventListener('webOSLaunch', onLaunch, true);
        global.document.addEventListener('webOSRelaunch', onLaunch, true);
        launchBootstrapTimerId = global.setTimeout(function () {
            launchBootstrapTimerId = 0;
            if (launchSystemEventSeen) return;
            debugLog('launch_bootstrap_fallback', {});
            launch('bootstrap', null);
        }, BOOTSTRAP_FALLBACK_DELAY_MS);
        launchHandlersInstalled = true;
    }

    installLaunchHandlers();

    // --- Boot-time network gate --------------------------------------------
    // The boot activity launches this wrapper at core-boot-done, which on this
    // TV can be BEFORE connman finishes bringing WiFi up. Symptom it fixes:
    // after a reboot the app starts while the network is "connected" but has
    // no internet (app shows the no-network error) and only opening
    // Settings > Network and returning recovers it - that page's luna calls to
    // com.webos.connectionmanager re-apply/spawn the connection stack. So:
    //   1) poke the same connectionmanager APIs (spawns/re-syncs it), and
    //   2) wait for REAL internet (XHR against the hosted app origin; GitHub
    //      Pages answers with Access-Control-Allow-Origin: *) before loading
    //      the app. A healthy TV passes the first probe in well under a second.
    var NET_GATE_MAX_WAIT_MS = 45000;
    var NET_GATE_INTERVAL_MS = 1500;
    var netGateKickBridges = [];

    function netGateKick() {
        try {
            if (typeof global.PalmServiceBridge !== 'function') return;
            var uris = ['luna://com.webos.connectionmanager/getStatus', 'luna://com.webos.connectionmanager/getNetworks'];
            for (var i = 0; i < uris.length; i++) {
                var b = new global.PalmServiceBridge();
                netGateKickBridges.push(b); // retain: no GC before the reply
                b.onservicecallback = function () {};
                b.call(uris[i], '{}');
            }
            debugLog('net_gate_kick', {});
        } catch (e) {
            debugLog('net_gate_kick_error', {error: String(e)});
        }
    }

    function netGateProbe(target, cb) {
        var done = false;
        var finish = function (ok) {
            if (done) return;
            done = true;
            try {
                global.clearTimeout(timer);
            } catch (e) {}
            cb(ok);
        };
        var timer = global.setTimeout(function () {
            finish(false);
        }, 5000);
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', target + (target.indexOf('?') === -1 ? '?' : '&') + 'netgate=' + Date.now(), true);
            xhr.timeout = 5000;
            xhr.onload = function () {
                finish(xhr.status >= 200 && xhr.status < 400);
            };
            xhr.onerror = function () {
                finish(false);
            };
            xhr.ontimeout = function () {
                finish(false);
            };
            xhr.send();
        } catch (e) {
            finish(false);
        }
    }

    function gatedNavigate(target) {
        var startedAt = Date.now();
        var attempt = 0;
        var run = function () {
            attempt++;
            if (attempt === 1 || attempt % 4 === 3) netGateKick(); // poke now and every ~6s
            netGateProbe(target, function (ok) {
                if (ok || Date.now() - startedAt >= NET_GATE_MAX_WAIT_MS) {
                    debugLog('net_gate_done', {attempt: attempt, ok: ok, waitedMs: Date.now() - startedAt});
                    global.location.replace(target);
                    return;
                }
                global.setTimeout(run, NET_GATE_INTERVAL_MS);
            });
        };
        debugLog('net_gate_start', {});
        run();
    }

    // Kick the Homebrew Channel startup script on every wrapper launch. The
    // boot-time launch is armed as a persistent webOS activity (callback =
    // applicationManager/launch of this app), and startup.sh runs as root:
    // it starts sshd (dropbear) and executes /var/lib/webosbrew/init.d hooks
    // (the local fMP4->TS remux server). Fire-and-forget; the service call is
    // delivered immediately and startup.sh is idempotent per boot (marker in
    // /tmp), so repeated launches are no-ops. On non-rooted TVs PalmServiceBridge
    // or the service is missing and this silently does nothing.
    var homebrewKickBridge = null;
    function kickHomebrewStartup() {
        try {
            if (typeof global.PalmServiceBridge !== 'function') return;
            homebrewKickBridge = new global.PalmServiceBridge();
            homebrewKickBridge.onservicecallback = function () {};
            homebrewKickBridge.call(
                'luna://org.webosbrew.hbchannel.service/autostart',
                '{"reason":"sttv-wrapper"}'
            );
            debugLog('homebrew_kick_sent', {});
        } catch (e) {
            debugLog('homebrew_kick_error', {error: String(e)});
        }
    }
    kickHomebrewStartup();
})(window);
