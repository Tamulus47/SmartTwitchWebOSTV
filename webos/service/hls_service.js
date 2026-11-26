/*
 * AncientTwitchWebOSTV local webOS JS service for HLS playlist fetches.
 * Keeps Twitch playlist fetches inside the app package service process so
 * browser CORS restrictions do not block quality parsing in the hosted app.
 */

'use strict';

var pkgInfo = require('./package.json');
var Service = require('webos-service');
var https = require('https');
var urlLib = require('url');
var childProcess = require('child_process');
var httpMod = require('http');
var pathMod = require('path');

var service = new Service(pkgInfo.name);

var MAX_RESPONSE_BYTES = 1024 * 1024;
var DEFAULT_TIMEOUT_MS = 4500;
var MIN_TIMEOUT_MS = 1200;
// Fix A (docs/Live_Playback_and_Adblock_Fixes.md): ad-free proxy fetches must
// survive TV WiFi jitter - allow up to 8s before giving up (plus one retry).
var MAX_TIMEOUT_MS = 8000;
var DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
// Clean browser identity for ad-free proxy hosts (they 403 on foreign
// Origin/Referer headers and expect a normal browser User-Agent).
var CLEAN_PROXY_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function clampTimeout(value) {
    var parsed = parseInt(value, 10);
    if (!isFinite(parsed) || parsed <= 0) parsed = DEFAULT_TIMEOUT_MS;
    if (parsed < MIN_TIMEOUT_MS) parsed = MIN_TIMEOUT_MS;
    if (parsed > MAX_TIMEOUT_MS) parsed = MAX_TIMEOUT_MS;
    return parsed;
}

function isAllowedPlaylistUrl(parsedUrl) {
    if (!parsedUrl) return false;
    if (parsedUrl.protocol !== 'https:') return false;
    var hostname = String(parsedUrl.hostname || '').toLowerCase();
    var path = String(parsedUrl.pathname || '').toLowerCase();
    // Variant media playlists (playlist.ttvnw.net, no .m3u8 extension).
    // Needed so the bridge can detect fMP4 channels (EXT-X-MAP) and drive
    // MSE playback; Chrome's native HLS cannot decode fMP4 segments.
    if (/\.playlist\.ttvnw\.net$/.test(hostname)) {
        return path.indexOf('/v1/playlist/') === 0;
    }
    // Ad-free proxy tier hosts (Fix A): Tier 1 serves /live/<channel> with no
    // .m3u8 extension, so allow these by host - rejecting them here made the
    // chain fall back to the direct ad-laden master.
    if (hostname === 'as.luminous.dev' ||
        /\.luminous\.dev$/.test(hostname) ||
        /\.rte\.net\.ru$/.test(hostname) ||
        /\.r\.tedd\.dev$/.test(hostname) ||
        hostname.indexOf('perfprod.com') !== -1) {
        return true;
    }
    // Master playlists (usher.ttvnw.net) and media playlists (cloudfront VOD
    // hosts such as d1m7jfoe9zdc1j.cloudfront.net/.../index-dvr.m3u8).
    return /\.m3u8$/.test(path);
}

function respondError(message, statusCode, errorCode, errorText) {
    message.respond({
        returnValue: false,
        status: statusCode || 500,
        errorCode: errorCode || 'UNKNOWN',
        errorText: errorText || 'Service error'
    });
}
function normalizeHeaderValue(value, maxLength) {
    if (typeof value !== 'string') return '';
    var cleaned = value.replace(/[\r\n]/g, ' ').trim();
    if (!cleaned) return '';
    if (maxLength > 0 && cleaned.length > maxLength) return cleaned.slice(0, maxLength);
    return cleaned;
}

service.register('fetchPlaylist', function (message) {
    var payload = message && message.payload && typeof message.payload === 'object' ? message.payload : {};
    var targetUrl = typeof payload.url === 'string' ? payload.url : '';
    if (!targetUrl) {
        respondError(message, 400, 'INVALID_URL', 'payload.url is required');
        return;
    }

    var parsedUrl = null;
    try {
        parsedUrl = urlLib.parse(targetUrl);
    } catch (eUrl) {
        respondError(message, 400, 'INVALID_URL', 'payload.url is not a valid URL');
        return;
    }
    if (!parsedUrl || !parsedUrl.hostname) {
        respondError(message, 400, 'INVALID_URL', 'payload.url is not a valid URL');
        return;
    }

    if (!isAllowedPlaylistUrl(parsedUrl)) {
        respondError(message, 403, 'URL_NOT_ALLOWED', 'Only usher Twitch playlist URLs are allowed');
        return;
    }

    var timeoutMs = clampTimeout(payload.timeoutMs);
    var requestOrigin = normalizeHeaderValue(payload.origin, 256);
    var requestReferer = normalizeHeaderValue(payload.referer, 1024);
    var requestUserAgent = normalizeHeaderValue(payload.userAgent, 512);
    var requestAcceptLanguage = normalizeHeaderValue(payload.acceptLanguage, 256) || DEFAULT_ACCEPT_LANGUAGE;
    var finished = false;

    var finalize = function (result) {
        if (finished) return;
        finished = true;
        message.respond(result);
    };
    var requestHeaders = {
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        'Accept-Language': requestAcceptLanguage
    };
    // playlist.ttvnw.net (variant playlists) rejects unknown Origin headers
    // with 403; only forward browser identity headers to usher.
    var hostnameLower = String(parsedUrl.hostname || '').toLowerCase();
    var isVariantHost = /\.playlist\.ttvnw\.net$/.test(hostnameLower);
    // Ad-free proxy hosts (Fix A): send a clean browser User-Agent and drop
    // Origin/Referer entirely - a foreign Origin makes them answer 403.
    var isProxyHost = hostnameLower === 'as.luminous.dev' ||
        /\.luminous\.dev$/.test(hostnameLower) ||
        /\.rte\.net\.ru$/.test(hostnameLower) ||
        /\.r\.tedd\.dev$/.test(hostnameLower) ||
        hostnameLower.indexOf('perfprod.com') !== -1;
    if (isProxyHost) {
        requestHeaders['User-Agent'] = CLEAN_PROXY_USER_AGENT;
    } else if (!isVariantHost) {
        if (requestOrigin) requestHeaders.Origin = requestOrigin;
        if (requestReferer) requestHeaders.Referer = requestReferer;
        if (requestUserAgent) requestHeaders['User-Agent'] = requestUserAgent;
    }
    requestHeaders['Sec-Fetch-Mode'] = 'cors';
    requestHeaders['Sec-Fetch-Site'] = 'cross-site';

    var attempt = 0;
    var startRequest = function () {
        attempt++;
        var req = https.request(
        {
            protocol: 'https:',
            hostname: parsedUrl.hostname,
            port: parsedUrl.port ? parsedUrl.port : 443,
            method: 'GET',
            path: parsedUrl.pathname + (parsedUrl.search || ''),
            headers: requestHeaders
        },
        function (res) {
            var status = parseInt(res.statusCode, 10) || 0;
            if (status !== 200) {
                try { res.resume(); } catch (eResume) {}
                finalize({
                    returnValue: false,
                    status: status > 0 ? status : 502,
                    errorCode: 'UPSTREAM_STATUS',
                    errorText: 'Upstream returned status ' + status
                });
                return;
            }

            var chunks = [];
            var totalBytes = 0;

            res.on('data', function (chunk) {
                if (finished) return;
                totalBytes += chunk.length;
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    req.destroy(new Error('RESPONSE_TOO_LARGE'));
                    return;
                }
                chunks.push(chunk);
            });

            res.on('end', function () {
                if (finished) return;
                var body = '';
                try {
                    body = Buffer.concat(chunks).toString('utf8');
                } catch (eConcat) {
                    finalize({
                        returnValue: false,
                        status: 500,
                        errorCode: 'DECODE_ERROR',
                        errorText: 'Failed to decode playlist body'
                    });
                    return;
                }

                if (body.indexOf('#EXTM3U') === -1) {
                    finalize({
                        returnValue: false,
                        status: 502,
                        errorCode: 'INVALID_PLAYLIST',
                        errorText: 'Playlist body does not contain EXTM3U header'
                    });
                    return;
                }

                finalize({
                    returnValue: true,
                    status: 200,
                    responseText: body,
                    url: targetUrl
                });
            });
        }
    );

    req.setTimeout(timeoutMs, function () {
        req.destroy(new Error('TIMEOUT'));
    });

    req.on('error', function (err) {
        if (finished) return;
        var messageText = err && err.message ? String(err.message) : 'Network request failed';
        var errorCode = messageText === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE' : messageText === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR';
        // Fix A: one retry on transient network errors (TV WiFi jitter) - a
        // dropped first attempt must not bounce the ad-free chain to direct.
        if (attempt < 2 && errorCode === 'NETWORK_ERROR') {
            setTimeout(startRequest, 400);
            return;
        }
        var statusCode = messageText === 'RESPONSE_TOO_LARGE' ? 413 : messageText === 'TIMEOUT' ? 504 : 502;
        finalize({
            returnValue: false,
            status: statusCode,
            errorCode: errorCode,
            errorText: messageText
        });
    });

    req.end();
    };
    startRequest();
});

// ---------------------------------------------------------------------------
// Local fMP4 -> MPEG-TS remux server (sttv_serve.js, port 8099).
//
// This used to be started through Homebrew Channel's root `exec`, which made
// the app depend on a rooted TV. The script now ships inside this package and
// is spawned here with child_process instead. The server itself needs no
// privileges at all: it binds an unprivileged port (8099 > 1024), only reads
// its own script, and logs to world-writable /tmp - verified on device
// running as uid 5570 with its old document root completely absent.
// ---------------------------------------------------------------------------
var REMUX_PORT = 8099;
var REMUX_SCRIPT = pathMod.join(__dirname, 'sttv_serve.js');
var REMUX_HEALTH_TIMEOUT_MS = 2000;
var REMUX_START_SETTLE_MS = 1500;

function probeRemux(callback) {
    var done = false;
    var finish = function (ok) {
        if (done) return;
        done = true;
        callback(!!ok);
    };
    var req;
    try {
        req = httpMod.get({host: '127.0.0.1', port: REMUX_PORT, path: '/health'}, function (res) {
            var body = '';
            res.on('data', function (chunk) { body += chunk; });
            res.on('end', function () {
                finish(res.statusCode === 200 && body.indexOf('ok') !== -1);
            });
            res.on('error', function () { finish(false); });
        });
    } catch (eProbe) {
        finish(false);
        return;
    }
    req.setTimeout(REMUX_HEALTH_TIMEOUT_MS, function () {
        try { req.abort(); } catch (eAbort) {}
        finish(false);
    });
    req.on('error', function () { finish(false); });
}

function spawnRemux() {
    var child = childProcess.spawn('node', [REMUX_SCRIPT, String(REMUX_PORT)], {
        cwd: pathMod.dirname(REMUX_SCRIPT),
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    return child.pid;
}

service.register('startRemux', function (message) {
    probeRemux(function (alreadyRunning) {
        if (alreadyRunning) {
            message.respond({
                returnValue: true,
                running: true,
                alreadyRunning: true,
                port: REMUX_PORT
            });
            return;
        }

        var pid = 0;
        var spawnError = '';
        try {
            pid = spawnRemux();
        } catch (eSpawn) {
            spawnError = String(eSpawn && eSpawn.message ? eSpawn.message : eSpawn);
        }

        if (!pid) {
            message.respond({
                returnValue: false,
                status: 500,
                errorCode: 'SPAWN_FAILED',
                errorText: spawnError || 'Could not spawn the remux server',
                script: REMUX_SCRIPT
            });
            return;
        }

        setTimeout(function () {
            probeRemux(function (ok) {
                var response = {
                    returnValue: !!ok,
                    status: ok ? 200 : 500,
                    running: !!ok,
                    pid: pid,
                    port: REMUX_PORT,
                    script: REMUX_SCRIPT
                };
                if (typeof process.getuid === 'function') response.serviceUid = process.getuid();
                if (!ok) {
                    response.errorCode = 'START_TIMEOUT';
                    response.errorText = 'Remux server did not answer /health after spawn';
                }
                message.respond(response);
            });
        }, REMUX_START_SETTLE_MS);
    });
});

service.register('stopRemux', function (message) {
    // Bracket trick keeps pkill from matching the shell it runs in.
    try {
        var killer = childProcess.spawn('pkill', ['-f', 'sttv[_]serve'], {stdio: 'ignore'});
        killer.on('error', function () {});
        killer.unref();
    } catch (eKill) {}

    setTimeout(function () {
        probeRemux(function (stillRunning) {
            message.respond({
                returnValue: true,
                running: !!stillRunning,
                port: REMUX_PORT
            });
        });
    }, 700);
});




