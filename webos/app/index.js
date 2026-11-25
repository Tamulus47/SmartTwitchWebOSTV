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
        // Defensive kick-only guard: the boot activity launches us with
        // sttv_boot_kick=1. Whether the params show up in PalmSystem at parse
        // time or later in the launch event detail, NEVER navigate in that
        // case - only kick startup.sh (ssh+telnet) and close this window.
        if (params && params.sttv_boot_kick) {
            debugLog('boot_kick_via_event', {launchEvent: eventName || 'launch'});
            bootKickWithRetry(); // kicks, then closes this window
            return;
        }
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
        // Real navigation to the hosted app = a manual open: start sttv_serve
        // now (it lives only while the app page is open; the bridge heartbeat
        // keeps it up and stops it after the app closes).
        ensureSttvServe();
        global.location.replace(target);
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

    // Kick the Homebrew Channel startup script on every wrapper launch.
    // startup.sh runs as root: it starts sshd (dropbear) + telnetd and runs
    // run-parts /var/lib/webosbrew/init.d. Fire-and-forget; the service call
    // is delivered immediately and startup.sh is idempotent per boot (marker
    // in /tmp), so repeated launches are no-ops. On non-rooted TVs
    // PalmServiceBridge or the service is missing and this silently does
    // nothing. Note: sttv_serve is NOT part of this chain - it starts only
    // with a manual app open (ensureSttvServe below) and stops on close.
    var homebrewKickBridge = null;
    function kickHomebrewStartup(onResult) {
        try {
            if (typeof global.PalmServiceBridge !== 'function') {
                if (onResult) onResult(false);
                return;
            }
            homebrewKickBridge = new global.PalmServiceBridge();
            var settled = false;
            var settle = function (ok) {
                if (settled) return;
                settled = true;
                if (onResult) onResult(ok);
            };
            homebrewKickBridge.onservicecallback = function () {
                settle(true);
            };
            homebrewKickBridge.onserviceerror = function () {
                settle(false);
            };
            homebrewKickBridge.call(
                'luna://org.webosbrew.hbchannel.service/autostart',
                '{"reason":"sttv-wrapper"}'
            );
            debugLog('homebrew_kick_sent', {});
        } catch (e) {
            debugLog('homebrew_kick_error', {error: String(e)});
            if (onResult) onResult(false);
        }
    }

    // Boot-time kick with retries: at core-boot-done the Homebrew service
    // may not be registered yet, and a single fire-and-forget call would be
    // lost (observed on TV: boot with no dropbear). Retry on error until the
    // service answers (startup.sh is idempotent), then self-close; hard
    // timeout so the placeholder window never lingers.
    var bootKickAttempts = 0;
    var bootKickSettled = false;
    function bootKickClose() {
        if (bootKickSettled) return;
        bootKickSettled = true;
        selfCloseApp();
    }
    function bootKickWithRetry() {
        if (bootKickSettled) return;
        bootKickAttempts++;
        kickHomebrewStartup(function (ok) {
            if (ok) {
                debugLog('boot_kick_ok', {attempt: bootKickAttempts});
                bootKickClose();
                return;
            }
            if (bootKickAttempts >= 4) {
                debugLog('boot_kick_give_up', {attempt: bootKickAttempts});
                bootKickClose();
                return;
            }
            debugLog('boot_kick_retry', {attempt: bootKickAttempts});
            global.setTimeout(bootKickWithRetry, 2000 * bootKickAttempts);
        });
        if (bootKickAttempts === 1) {
            global.setTimeout(bootKickClose, 12000); // absolute cap
        }
    }
    // sttv_serve (local fMP4->TS remux server) lifecycle: it must run ONLY
    // while SmartTwitch is open - started here on a manual app open, stopped
    // by the bridge's unload hook when the app closes, and never started by
    // the boot chain.
    var serveExecBridge = null;
    function ensureSttvServe() {
        try {
            if (typeof global.PalmServiceBridge !== 'function') return;
            serveExecBridge = new global.PalmServiceBridge();
            serveExecBridge.onservicecallback = function () {};
            // Port-based guard, NOT `pgrep -f sttv_serve.js`: hb exec runs
            // this as /bin/sh -c, whose own cmdline contains the script name
            // - pgrep would match the shell and skip the nohup branch.
            serveExecBridge.call(
                'luna://org.webosbrew.hbchannel.service/exec',
                JSON.stringify({
                    command:
                        "netstat -ltn 2>/dev/null | grep -q ':8099' || " +
                        '(cd /media/developer/sttv_stage && nohup node sttv_serve.js 8099 >/dev/null 2>&1 &)'
                })
            );
            debugLog('sttv_serve_ensure', {});
        } catch (e) {
            debugLog('sttv_serve_ensure_error', {error: String(e)});
        }
    }

    // Close this placeholder window (boot kick path): SmartTwitch must not
    // stay open at boot - it only exists to run the startup kick.
    var selfCloseBridge = null;
    function selfCloseApp() {
        var doClose = function () {
            try {
                if (typeof global.PalmServiceBridge !== 'function') return;
                selfCloseBridge = new global.PalmServiceBridge();
                selfCloseBridge.onservicecallback = function () {};
                selfCloseBridge.call(
                    'luna://com.webos.applicationManager/close',
                    JSON.stringify({id: 'com.tbsniller.smarttwitchwebostv'})
                );
            } catch (e) {}
        };
        doClose();
        global.setTimeout(doClose, 800); // retry once if the first call raced
        // Last-resort fallback in case the luna close method is unavailable:
        // window.close() on the app window (harmless no-op if blocked).
        global.setTimeout(function () {
            try {
                global.close();
            } catch (eClose) {}
        }, 1600);
        debugLog('boot_kick_self_close', {});
    }

    // Boot activity launch: only run the startup kick (ssh + telnet) and close
    // this window immediately - no navigation, no app left running, no
    // sttv_serve at boot.
    var bootKickParams = parseLaunchParams(null);
    if (bootKickParams && bootKickParams.sttv_boot_kick) {
        debugLog('boot_kick_only', {});
        // Kick with retries + self-close on acknowledgement (or after the
        //12s cap): at core-boot-done the Homebrew service may not be
        // registered yet, and a single fire-and-forget kick is lost.
        bootKickWithRetry();
    } else {
        // Manual open: handlers navigate to the hosted app (which starts
        // sttv_serve at the navigation commit point); the kick is idempotent.
        installLaunchHandlers();
        kickHomebrewStartup();
    }
})(window);
