/* Static HTTP server for SmartTwitchWebOSTV testing on webOS (node 0.12, ES5).
 * Document root: /media/developer/sttv_stage
 * Every request is mapped under /SmartTwitchWebOSTV so paths mirror production.
 * Usage: node sttv_serve.js [port]
 *
 * fMP4 -> MPEG-TS remux endpoints (/hls/...): webOS 3.4 (Chrome 38) cannot
 * decode fMP4 in any path (MSE dies at init or emits zero samples; native
 * HLS demuxes but never decodes a frame), while MPEG-TS native HLS plays
 * flawlessly. Twitch custom-stack content is fMP4, so playlists are rewritten
 * to a local HLS whose segments are transmuxed to TS for the platform player.
 */
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = '/media/developer/sttv_stage';
var MOUNT = '/SmartTwitchWebOSTV';
var PORT = parseInt(process.argv[2], 10) || 8099;

var UA =
    'Mozilla/5.0 (Web0S; Linux armv7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36';

var MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.md': 'text/plain; charset=utf-8'
};

function logLine(msg) {
    try {
        fs.appendFileSync('/tmp/httpd.log', new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) {}
}

// Same-origin media proxy for the bridge's MSE fMP4 player: VOD segment
// hosts (cloudfront) send no ACAO header, so the page cannot XHR them
// cross-origin. Streams the upstream bytes back unmodified (ES5/node 0.12).
function proxyPass(target, res, redirects) {
    var hops = redirects || 0;
    if (!/^https:\/\//.test(target)) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('bad url');
        return;
    }
    var u;
    try {
        u = url.parse(target);
    } catch (e) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('bad url');
        return;
    }
    var pr = https.request(
        {
            hostname: u.hostname,
            path: u.path,
            method: 'GET',
            headers: {
                'User-Agent': UA,
                Accept: '*/*'
            }
        },
        function (up) {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 3) {
                up.resume();
                var next = url.resolve(target, up.headers.location);
                if (/^https:\/\//.test(next)) {
                    proxyPass(next, res, hops + 1);
                    return;
                }
            }
            if (up.statusCode !== 200) {
                res.writeHead(up.statusCode || 502, {'Content-Type': 'text/plain'});
                up.resume();
                res.end('upstream ' + up.statusCode);
                logLine('proxy ' + up.statusCode + ' ' + String(target).substring(0, 100));
                return;
            }
            res.writeHead(200, {
                'Content-Type': up.headers['content-type'] || 'application/octet-stream',
                'Cache-Control': 'no-store'
            });
            up.pipe(res);
            logLine('proxy 200 ' + String(target).substring(0, 100));
        }
    );
    pr.on('error', function (err) {
        try {
            res.writeHead(502);
            res.end('proxy error');
        } catch (x) {}
        logLine('proxy err ' + (err && err.message ? err.message : 'unknown'));
    });
    pr.setTimeout(30000, function () {
        pr.abort();
    });
    pr.end();
}

// =========================================================================
// fMP4 -> MPEG-TS transmux (ES5 / node 0.12)
// =========================================================================

var INIT_CACHE_MAX = 8;
var TS_CACHE_MAX_ITEMS = 48;
var TS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// The server lives only while SmartTwitch is open (started by the wrapper /
// bridge on app open, stopped on app close). The app page pings /health every
// 10s while it is alive, so no request for STTV_SERVE_HEARTBEAT_EXIT_MS means
// the app was closed or killed (webOS process kills do not reliably fire
// unload hooks) - exit so nothing keeps running in the background. Active
// playback refreshes lastReqMs through its normal requests as well.
var STTV_SERVE_HEARTBEAT_EXIT_MS = 90 * 1000;
var lastReqMs = Date.now();

var initInfoCache = {}; // map url -> parsed init info
var initInfoOrder = [];
var tsCache = {}; // seg url -> TS Buffer
var tsCacheOrder = [];
var tsCacheBytes = 0;

var VIDEO_PID = 0x100;
var AUDIO_PID = 0x101;
var PMT_PID = 0x1000;

// Continuity counters persist across segments (one continuous TS program).
var tsCC = {0: 0, 4096: 0, 256: 0, 257: 0};

function fetchBuf(target, redirects, cb) {
    if (typeof redirects === 'function') {
        cb = redirects;
        redirects = 0;
    }
    doFetch(target, redirects, 0, cb);
}

// One automatic retry for network blips (this TV's WiFi drops briefly and
// ENETUNREACH/timeouts are common); HTTP 4xx is not retried.
function doFetch(target, redirects, attempt, cb) {
    fetchBufOnce(target, redirects, function (err, buf) {
        if (err && attempt < 1 && String(err.message || '').indexOf('http 4') !== 0) {
            setTimeout(function () {
                doFetch(target, redirects, attempt + 1, cb);
            }, 300);
            return;
        }
        cb(err, buf);
    });
}

function fetchBufOnce(target, redirects, cb) {
    if (!/^https:\/\//.test(target)) {
        cb(new Error('bad scheme'));
        return;
    }
    var u;
    try {
        u = url.parse(target);
    } catch (e) {
        cb(new Error('bad url'));
        return;
    }
    var done = false;
    var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try {
            rq.abort();
        } catch (e) {}
        cb(new Error('timeout'));
    }, 15000);
    var rq = https.request(
        {
            hostname: u.hostname,
            path: u.path,
            method: 'GET',
            headers: {'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity'}
        },
        function (up) {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects < 3) {
                up.resume();
                clearTimeout(timer);
                if (done) return;
                fetchBuf(url.resolve(target, up.headers.location), redirects + 1, cb);
                return;
            }
            if (up.statusCode !== 200) {
                up.resume();
                if (done) return;
                done = true;
                clearTimeout(timer);
                cb(new Error('http ' + up.statusCode));
                return;
            }
            var chunks = [];
            up.on('data', function (d) {
                chunks.push(d);
            });
            up.on('end', function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cb(null, Buffer.concat(chunks));
            });
            up.on('error', function (e) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cb(e);
            });
        }
    );
    rq.on('error', function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cb(e);
    });
    rq.end();
}

// --- ISO BMFF box walking -------------------------------------------------

function forEachBox(buf, start, end, cb) {
    var off = start;
    while (off + 8 <= end) {
        var size = buf.readUInt32BE(off);
        var type = buf.toString('binary', off + 4, off + 8);
        var hdr = 8;
        if (size === 1) {
            if (off + 16 > end) break;
            size = buf.readUInt32BE(off + 8) * 4294967296 + buf.readUInt32BE(off + 12);
            hdr = 16;
        } else if (size === 0) {
            size = end - off;
        }
        if (size < hdr || off + size > end) break;
        cb(type, off + hdr, off + size, off);
        off += size;
    }
}

function readDesc(buf, off) {
    var tag = buf[off];
    var i = off + 1;
    var size = 0;
    var b;
    do {
        if (i >= buf.length) return null;
        b = buf[i++];
        size = (size << 7) | (b & 0x7f);
    } while (b & 0x80);
    return {tag: tag, start: i, end: i + size, next: i + size};
}

function findAsc(esds) {
    // fullbox(4) then ES_Descriptor tree -> DecoderSpecificInfo (tag 5).
    var d1 = readDesc(esds, 4);
    if (!d1 || d1.tag !== 3) return null;
    var p = d1.start + 2; // ES_ID
    var flags = esds[p++];
    if (flags & 0x80) p += 2; // streamDependence
    if (flags & 0x40) p += 2; // OCR
    if (flags & 0x20) p += 1 + esds[p]; // URL
    var d2 = readDesc(esds, p);
    if (!d2 || d2.tag !== 4) return null;
    // objectTypeIndication(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4) = 13
    var d3 = readDesc(esds, d2.start + 13);
    if (!d3 || d3.tag !== 5) return null;
    return esds.slice(d3.start, d3.end);
}

function parseTrak(buf, s, e) {
    var out = {handler: '', timescale: 0, id: 0, avcC: null, asc: null, width: 0, height: 0, lengthSize: 4};
    forEachBox(buf, s, e, function (type, ts, te) {
        if (type === 'tkhd') {
            out.id = buf[ts] === 1 ? buf.readUInt32BE(ts + 20) : buf.readUInt32BE(ts + 12);
        } else if (type === 'mdia') {
            forEachBox(buf, ts, te, function (t2, s2, e2) {
                if (t2 === 'mdhd') {
                    out.timescale = buf[s2] === 1 ? buf.readUInt32BE(s2 + 20) : buf.readUInt32BE(s2 + 12);
                } else if (t2 === 'hdlr') {
                    out.handler = buf.toString('binary', s2 + 8, s2 + 12);
                } else if (t2 === 'minf') {
                    forEachBox(buf, s2, e2, function (t3, s3, e3) {
                        if (t3 !== 'stbl') return;
                        forEachBox(buf, s3, e3, function (t4, s4, e4) {
                            if (t4 !== 'stsd') return;
                            forEachBox(buf, s4 + 8, e4, function (t5, s5, e5) {
                                if (t5 === 'avc1' || t5 === 'avc3') {
                                    out.width = buf.readUInt16BE(s5 + 24);
                                    out.height = buf.readUInt16BE(s5 + 26);
                                    forEachBox(buf, s5 + 78, e5, function (t6, s6, e6) {
                                        if (t6 === 'avcC' && e6 - s6 > 5) {
                                            out.avcC = buf.slice(s6, e6);
                                            out.lengthSize = (buf[s6 + 4] & 3) + 1;
                                        }
                                    });
                                } else if (t5 === 'mp4a') {
                                    forEachBox(buf, s5 + 28, e5, function (t6, s6, e6) {
                                        if (t6 === 'esds') out.asc = findAsc(buf.slice(s6, e6));
                                    });
                                }
                            });
                        });
                    });
                }
            });
        }
    });
    return out;
}

function parseInit(buf) {
    var info = {video: null, audio: null};
    forEachBox(buf, 0, buf.length, function (type, s, e) {
        if (type !== 'moov') return;
        forEachBox(buf, s, e, function (t2, s2, e2) {
            if (t2 !== 'trak') return;
            var trak = parseTrak(buf, s2, e2);
            if (trak.handler === 'vide' && trak.avcC && !info.video) info.video = trak;
            else if (trak.handler === 'soun' && trak.asc && !info.audio) info.audio = trak;
        });
    });
    if (info.video) {
        var avcC = info.video.avcC;
        var numSps = avcC[5] & 0x1f;
        var p = 6;
        info.video.sps = [];
        var i;
        for (i = 0; i < numSps; i++) {
            var l1 = (avcC[p] << 8) | avcC[p + 1];
            p += 2;
            info.video.sps.push(avcC.slice(p, p + l1));
            p += l1;
        }
        var numPps = avcC[p++];
        info.video.pps = [];
        for (i = 0; i < numPps; i++) {
            var l2 = (avcC[p] << 8) | avcC[p + 1];
            p += 2;
            info.video.pps.push(avcC.slice(p, p + l2));
            p += l2;
        }
    }
    if (info.audio && info.audio.asc && info.audio.asc.length >= 2) {
        var b0 = info.audio.asc[0];
        var b1 = info.audio.asc[1];
        info.audio.aot = b0 >> 3;
        info.audio.freqIdx = ((b0 & 7) << 1) | (b1 >> 7);
        info.audio.chan = (b1 >> 3) & 0x0f;
    } else {
        info.audio = null;
    }
    return info.video || info.audio ? info : null;
}

function parseTraf(buf, s, e, moofAbs, segLen, out, stats) {
    var trackId = 0;
    var tfFlags = 0;
    var defDur = 0;
    var defSize = 0;
    var defFlags = 0;
    var baseDataOffset = -1;
    var baseDts = 0;
    var haveTfdt = false;
    var truns = [];
    forEachBox(buf, s, e, function (type, ts, te) {
        if (type === 'tfhd') {
            tfFlags = (buf[ts + 1] << 16) | (buf[ts + 2] << 8) | buf[ts + 3];
            var p = ts + 4;
            trackId = buf.readUInt32BE(p);
            p += 4;
            if (tfFlags & 0x000001) {
                baseDataOffset = buf.readUInt32BE(p) * 4294967296 + buf.readUInt32BE(p + 4);
                p += 8;
            }
            if (tfFlags & 0x000002) p += 4;
            if (tfFlags & 0x000008) {
                defDur = buf.readUInt32BE(p);
                p += 4;
            }
            if (tfFlags & 0x000010) {
                defSize = buf.readUInt32BE(p);
                p += 4;
            }
            if (tfFlags & 0x000020) {
                defFlags = buf.readUInt32BE(p);
                p += 4;
            }
        } else if (type === 'tfdt') {
            baseDts = buf[ts] === 1 ? buf.readUInt32BE(ts + 4) * 4294967296 + buf.readUInt32BE(ts + 8) : buf.readUInt32BE(ts + 4);
            haveTfdt = true;
        } else if (type === 'trun') {
            var flags = (buf[ts + 1] << 16) | (buf[ts + 2] << 8) | buf[ts + 3];
            var count = buf.readUInt32BE(ts + 4);
            var rowStart = ts + 8;
            var pre = (flags & 0x1 ? 4 : 0) + (flags & 0x2 ? 4 : 0);
            var rowSize =
                (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
            var dataOffset = 0;
            if (flags & 0x1) dataOffset = buf.readInt32BE(rowStart);
            truns.push({flags: flags, count: count, dataOffset: dataOffset, rowsOff: rowStart + pre, rowSize: rowSize});
        }
    });
    if (!truns.length || !haveTfdt) return;
    var base;
    if (baseDataOffset >= 0) base = baseDataOffset;
    else base = moofAbs; // default-base-is-moof (Twitch) / moof-relative data_offset
    var dts = baseDts;
    for (var t = 0; t < truns.length; t++) {
        var tr = truns[t];
        var off = base + tr.dataOffset;
        for (var i = 0; i < tr.count; i++) {
            var dur = defDur;
            var size = defSize;
            var flags = defFlags;
            var cts = 0;
            var row = tr.rowsOff + i * tr.rowSize;
            if (tr.flags & 0x100) {
                dur = buf.readUInt32BE(row);
                row += 4;
            }
            if (tr.flags & 0x200) {
                size = buf.readUInt32BE(row);
                row += 4;
            }
            if (tr.flags & 0x400) {
                flags = buf.readUInt32BE(row);
                row += 4;
            }
            if (tr.flags & 0x800) {
                cts = buf.readInt32BE(row);
                row += 4;
            }
            if (size > 0 && off >= 0 && off + size <= segLen) {
                out.push({track: trackId, dts: dts, cts: cts, size: size, flags: flags, off: off});
                if (stats) stats.total++;
            } else if (size > 0) {
                // Content mismatch (e.g. ad insertion with a foreign init): skip
                // the sample instead of failing the whole segment.
                if (stats) {
                    stats.dropped++;
                    stats.total++;
                    if (stats.dropped <= 3) {
                        stats.last =
                            't=' + trackId + ' off=' + off + ' size=' + size + ' len=' + segLen +
                            ' doff=' + tr.dataOffset + ' base=' + base + ' moof=' + moofAbs;
                    }
                } else {
                    throw new Error(
                        'sample oob t=' + trackId + ' off=' + off + ' size=' + size + ' len=' + segLen +
                        ' doff=' + tr.dataOffset + ' base=' + base + ' moof=' + moofAbs + ' idx=' + i + '/' + tr.count
                    );
                }
            }
            off += size;
            dts += dur;
        }
    }
}

function parseSeg(buf, stats) {
    var out = [];
    var boxes = [];
    forEachBox(buf, 0, buf.length, function (type, s, e, abs) {
        boxes.push({type: type, s: s, e: e, abs: abs});
    });
    for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].type !== 'moof') continue;
        var mdat = null;
        for (var j = i + 1; j < boxes.length && boxes[j].type !== 'moof'; j++) {
            if (boxes[j].type === 'mdat') {
                mdat = boxes[j];
                break;
            }
        }
        if (!mdat) continue;
        forEachBox(buf, boxes[i].s, boxes[i].e, function (type, ts, te) {
            if (type === 'traf') parseTraf(buf, ts, te, boxes[i].abs, buf.length, out, stats);
        });
    }
    return out;
}

// --- TS building ----------------------------------------------------------

function mpegCrc(buf, start, end) {
    var crc = 0xffffffff;
    for (var i = start; i < end; i++) {
        crc = (crc ^ (buf[i] << 24)) >>> 0;
        for (var k = 0; k < 8; k++) {
            if (crc & 0x80000000) crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
            else crc = (crc << 1) >>> 0;
        }
    }
    return crc >>> 0;
}

function buildPat() {
    var body = new Buffer(9);
    body.writeUInt16BE(1, 0);
    body[2] = 0xc1;
    body[3] = 0x00;
    body[4] = 0x00;
    body.writeUInt16BE(1, 5); // program_number at 5..6
    body[7] = 0xe0 | ((PMT_PID >> 8) & 0x1f);
    body[8] = PMT_PID & 0xff;
    var secLen = 9 + 4;
    var sec = new Buffer(3 + secLen);
    sec[0] = 0x00;
    sec[1] = 0xb0 | ((secLen >> 8) & 0x0f);
    sec[2] = secLen & 0xff;
    body.copy(sec, 3);
    sec.writeUInt32BE(mpegCrc(sec, 0, 3 + 9), 3 + 9);
    return sec;
}

function buildPmt(info) {
    var streams = [];
    if (info.video) streams.push({type: 0x1b, pid: VIDEO_PID});
    if (info.audio) streams.push({type: 0x0f, pid: AUDIO_PID});
    var pcrPid = info.video ? VIDEO_PID : AUDIO_PID;
    var secLen = 9 + 5 * streams.length + 4;
    var sec = new Buffer(3 + secLen);
    sec[0] = 0x02;
    sec[1] = 0xb0 | ((secLen >> 8) & 0x0f);
    sec[2] = secLen & 0xff;
    sec.writeUInt16BE(1, 3); // program_number
    sec[5] = 0xc1;
    sec[6] = 0x00;
    sec[7] = 0x00;
    sec[8] = 0xe0 | ((pcrPid >> 8) & 0x1f);
    sec[9] = pcrPid & 0xff;
    sec[10] = 0xf0;
    sec[11] = 0x00;
    var p = 12;
    for (var i = 0; i < streams.length; i++) {
        sec[p++] = streams[i].type;
        sec[p++] = 0xe0 | ((streams[i].pid >> 8) & 0x1f);
        sec[p++] = streams[i].pid & 0xff;
        sec[p++] = 0xf0;
        sec[p++] = 0x00;
    }
    sec.writeUInt32BE(mpegCrc(sec, 0, 3 + 9 + 5 * streams.length), p);
    return sec;
}

function pushPsi(out, pid, section) {
    var payload = new Buffer(184);
    payload[0] = 0x00; // pointer_field
    section.copy(payload, 1);
    for (var i = 1 + section.length; i < 184; i++) payload[i] = 0xff;
    pushPacket(out, pid, payload, 0, payload.length, true, null);
}

function writePcr(buf, off, pcr27) {
    var base = Math.floor(pcr27 / 300);
    var ext = pcr27 - base * 300;
    buf[off] = (base >>> 25) & 0xff;
    buf[off + 1] = (base >>> 17) & 0xff;
    buf[off + 2] = (base >>> 9) & 0xff;
    buf[off + 3] = (base >>> 1) & 0xff;
    buf[off + 4] = ((base & 1) << 7) | 0x7e | ((ext >> 8) & 1);
    buf[off + 5] = ext & 0xff;
}

function pushPacket(out, pid, payload, pos, len, pusi, pcr) {
    var pkt = new Buffer(188);
    pkt[0] = 0x47;
    pkt[1] = ((pid >> 8) & 0x1f) | (pusi ? 0x40 : 0);
    pkt[2] = pid & 0xff;
    var cc = tsCC[pid] || 0;
    var useAdapt = false;
    var payloadLen;
    if (pcr !== null && pcr !== undefined) {
        useAdapt = true;
        payloadLen = Math.min(len, 176);
    } else if (len < 184) {
        useAdapt = true;
        payloadLen = len;
    } else {
        payloadLen = 184;
    }
    if (useAdapt) {
        var afLen = 183 - payloadLen;
        pkt[3] = 0x30 | (cc & 0x0f);
        pkt[4] = afLen;
        if (afLen > 0) {
            if (pcr !== null && pcr !== undefined) {
                pkt[5] = 0x10;
                writePcr(pkt, 6, pcr);
                for (var k = 12; k < 5 + afLen; k++) pkt[k] = 0xff;
            } else {
                pkt[5] = 0x00;
                for (var k2 = 6; k2 < 5 + afLen; k2++) pkt[k2] = 0xff;
            }
        }
    } else {
        pkt[3] = 0x10 | (cc & 0x0f);
    }
    var pOff = 4 + (useAdapt ? 1 + afLen : 0);
    payload.copy(pkt, pOff, pos, pos + payloadLen);
    tsCC[pid] = (cc + 1) & 0x0f;
    out.push(pkt);
    return payloadLen;
}

function pushPes(out, pid, pes, pcr) {
    var pos = 0;
    var first = true;
    while (pos < pes.length) {
        var n = pushPacket(out, pid, pes, pos, pes.length - pos, first, first ? pcr : null);
        pos += n;
        first = false;
    }
}

function ptsBytes(v, prefix) {
    v = v % 8589934592; // 33-bit wrap
    return [
        (prefix << 4) | (((v >>> 30) & 0x07) << 1) | 1,
        (v >>> 22) & 0xff,
        (((v >>> 15) & 0x7f) << 1) | 1,
        (v >>> 7) & 0xff,
        ((v & 0x7f) << 1) | 1
    ];
}

function buildPes(streamId, pts, dts, payload, withDts) {
    var hdrLen = withDts ? 10 : 5;
    var dataLen = 3 + hdrLen + payload.length;
    var pesLen = dataLen > 65535 ? 0 : dataLen;
    var p = new Buffer(9 + hdrLen + payload.length);
    p[0] = 0x00;
    p[1] = 0x00;
    p[2] = 0x01;
    p[3] = streamId;
    p.writeUInt16BE(pesLen, 4);
    p[6] = 0x80; // '10' + no scramble/priority/alignment/copyright/original
    p[7] = withDts ? 0xc0 : 0x80; // PTS+DTS / PTS only
    p[8] = hdrLen;
    var pb = ptsBytes(pts, withDts ? 3 : 2);
    var i;
    for (i = 0; i < 5; i++) p[9 + i] = pb[i];
    if (withDts) {
        var db = ptsBytes(dts, 1);
        for (i = 0; i < 5; i++) p[14 + i] = db[i];
    }
    payload.copy(p, 9 + hdrLen);
    return p;
}

var SO4 = new Buffer([0x00, 0x00, 0x00, 0x01]);

function annexb(vinfo, buf, sample) {
    var parts = [];
    var lenSize = vinfo.lengthSize;
    var off = sample.off;
    var end = sample.off + sample.size;
    var nals = [];
    while (off + lenSize <= end) {
        var nlen;
        if (lenSize === 4) nlen = buf.readUInt32BE(off);
        else if (lenSize === 2) nlen = buf.readUInt16BE(off);
        else nlen = buf[off];
        off += lenSize;
        if (nlen <= 0 || off + nlen > end) break;
        nals.push({off: off, len: nlen, type: buf[off] & 0x1f});
        off += nlen;
    }
    if (!nals.length) return null;
    var isIdr = false;
    var i;
    for (i = 0; i < nals.length; i++) {
        if (nals[i].type === 5) isIdr = true;
    }
    if (isIdr && nals[0].type !== 7) {
        for (i = 0; i < vinfo.sps.length; i++) {
            parts.push(SO4);
            parts.push(vinfo.sps[i]);
        }
        for (i = 0; i < vinfo.pps.length; i++) {
            parts.push(SO4);
            parts.push(vinfo.pps[i]);
        }
    }
    for (i = 0; i < nals.length; i++) {
        // Twitch's fMP4 carries END-OF-SEQUENCE(10) / END-OF-STREAM(11) NALs
        // at ad-break and serving-switch boundaries. Copying them into the TS
        // makes the platform decoder obey them and stop decoding right there:
        // observed as an audio+video freeze every ~5min (mid-roll ad cadence)
        // while the loader keeps downloading; VODs never hit it (single
        // continuous encode, no EOS markers). Drop them so playback continues
        // into the next segment.
        if (nals[i].type === 10 || nals[i].type === 11) continue;
        parts.push(SO4);
        parts.push(buf.slice(nals[i].off, nals[i].off + nals[i].len));
    }
    if (!parts.length) return null;
    return Buffer.concat(parts);
}

function adtsFrame(ainfo, buf, sample) {
    var payloadLen = sample.size;
    var len = 7 + payloadLen;
    var h = new Buffer(7);
    var profile = (ainfo.aot - 1) & 3;
    h[0] = 0xff;
    h[1] = 0xf1;
    h[2] = ((profile & 3) << 6) | ((ainfo.freqIdx & 0x0f) << 2) | ((ainfo.chan >> 2) & 1);
    h[3] = ((ainfo.chan & 3) << 6) | ((len >> 11) & 3);
    h[4] = (len >> 3) & 0xff;
    h[5] = ((len & 7) << 5) | 0x1f;
    h[6] = 0xfc;
    return Buffer.concat([h, buf.slice(sample.off, sample.off + payloadLen)]);
}

function muxSegment(info, segBuf, stats) {
    var samples = parseSeg(segBuf, stats);
    var v = [];
    var a = [];
    var i;
    for (i = 0; i < samples.length; i++) {
        var s = samples[i];
        if (info.video && s.track === info.video.id) v.push(s);
        else if (info.audio && s.track === info.audio.id) a.push(s);
    }
    if (!v.length && !a.length) return null;
    var events = [];
    for (i = 0; i < v.length; i++) {
        var sv = v[i];
        var dtsV = Math.round((sv.dts * 90000) / info.video.timescale);
        var ptsV = dtsV + Math.round((sv.cts * 90000) / info.video.timescale);
        var payloadV = annexb(info.video, segBuf, sv);
        if (!payloadV) continue;
        events.push({t: dtsV, kind: 'v', pts: ptsV, dts: dtsV, payload: payloadV});
    }
    for (i = 0; i < a.length; i++) {
        var sa = a[i];
        var dtsA = Math.round((sa.dts * 90000) / info.audio.timescale);
        var payloadA = adtsFrame(info.audio, segBuf, sa);
        events.push({t: dtsA, kind: 'a', pts: dtsA, dts: dtsA, payload: payloadA});
    }
    if (!events.length) return null;
    events.sort(function (x, y) {
        return x.t - y.t;
    });
    var out = [];
    var anyVideo = v.length > 0;
    var lastPsip = -1000000;
    pushPsi(out, 0, buildPat());
    pushPsi(out, PMT_PID, buildPmt(info));
    lastPsip = events[0].t;
    for (i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.t - lastPsip >= 9000) {
            pushPsi(out, 0, buildPat());
            pushPsi(out, PMT_PID, buildPmt(info));
            lastPsip = ev.t;
        }
        if (ev.kind === 'v') {
            var pesV = buildPes(0xe0, ev.pts, ev.dts, ev.payload, true);
            pushPes(out, VIDEO_PID, pesV, ev.dts * 300);
        } else {
            var pesA = buildPes(0xc0, ev.pts, ev.pts, ev.payload, false);
            pushPes(out, AUDIO_PID, pesA, anyVideo ? null : ev.dts * 300);
        }
    }
    if (stats && stats.total > 0 && stats.dropped * 2 >= stats.total) return null;
    return Buffer.concat(out);
}

// --- HLS endpoints --------------------------------------------------------

function sendText(res, text) {
    res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(text);
}

function sendErr(res, code, msg) {
    res.writeHead(code, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'});
    res.end(msg);
}

function segId(u) {
    var s = String(u);
    var m = s.match(/\/segment\/([A-Za-z0-9_-]{6,24})/);
    if (m) return m[1];
    var noq = s.split('?')[0];
    return noq.substring(noq.lastIndexOf('/') + 1).substring(0, 16);
}

function localVar(abs) {
    return '/hls/var.m3u8?u=' + encodeURIComponent(abs);
}

function localSeg(abs, mapAbs) {
    return '/hls/seg.ts?u=' + encodeURIComponent(abs) + (mapAbs ? '&m=' + encodeURIComponent(mapAbs) : '');
}

// Playlist fetch with a last-good cache: during WiFi blips the previous
// playlist (segment URLs stay valid for a while upstream) keeps live
// playback alive instead of a 502 killing the player. After the first
// fetch, responses are served instantly from cache while a background
// refresh keeps it current (the player's live-edge refresh loop must not
// wait on upstream latency).
var varCache = {};
var varCacheOrder = [];
var varInterest = {};
var varTimers = {};
var varBusy = {};
// Monotonic-accept guard: a playlist snapshot whose MEDIA-SEQUENCE moves
// BACKWARD (Twitch edge/session hiccups deliver older windows occasionally -
// observed serving seq2766 while upstream was at4413, and buffers walking
// backward21->17->13) makes the platform player rewind and wedge (frame ->
// spinner -> frame). Stale snapshots are rejected; only forward progress (or
// a clearly-forward PDT with a lower seq = upstream session reset) is cached.
var varMeta = {};

function playlistMeta(text) {
    var meta = { seq: null, pdt: null };
    var m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (m) meta.seq = parseInt(m[1], 10);
    m = text.match(/#EXT-X-PROGRAM-DATE-TIME:([0-9:\-\+.Z]+)/);
    if (m) {
        var t = Date.parse(m[1]);
        if (!isNaN(t)) meta.pdt = t;
    }
    return meta;
}

function acceptVariant(u, text) {
    var meta = playlistMeta(text);
    var prev = varMeta[u];
    if (!prev || meta.seq === null || prev.seq === null) {
        varMeta[u] = meta;
        return true;
    }
    if (meta.seq >= prev.seq) {
        varMeta[u] = meta;
        return true;
    }
    // Sequence went backward: accept only a legit timeline reset (first PDT
    // not older than the current window); otherwise it's a stale snapshot.
    if (meta.pdt !== null && prev.pdt !== null && meta.pdt >= prev.pdt - 2000) {
        varMeta[u] = meta;
        return true;
    }
    logLine('hls var REGRESSION rejected seq ' + meta.seq + ' < ' + prev.seq + ' ' + u.substring(0, 60));
    return false;
}

function rememberVariant(u, text) {
    if (!acceptVariant(u, text)) return; // keep last accepted (monotonic)
    varCache[u] = text;
    var idx = varCacheOrder.indexOf(u);
    if (idx >= 0) varCacheOrder.splice(idx, 1);
    varCacheOrder.push(u);
    while (varCacheOrder.length > 8) delete varCache[varCacheOrder.shift()];
}

function refreshVariantAsync(u) {
    if (varBusy[u]) return;
    varBusy[u] = true;
    fetchBuf(u, function (err, buf) {
        varBusy[u] = false;
        if (!err) rememberVariant(u, buf.toString('utf8'));
        else logLine('hls var bgerr ' + err.message + ' ' + u.substring(0, 60));
    });
}

function ensureVariantTimer(u) {
    varInterest[u] = Date.now();
    if (varTimers[u]) return;
    varTimers[u] = setInterval(function () {
        if (Date.now() - (varInterest[u] || 0) > 45000) {
            clearInterval(varTimers[u]);
            delete varTimers[u];
            return;
        }
        refreshVariantAsync(u);
    }, 1000);
}

function fetchVariantText(u, cb, staticMode) {
    var hit = varCache[u];
    if (!staticMode) ensureVariantTimer(u);
    if (hit) {
        if (!staticMode) refreshVariantAsync(u); // refresh in background, answer now
        cb(null, hit);
        return;
    }
    fetchBuf(u, function (err, buf) {
        if (!err) {
            rememberVariant(u, buf.toString('utf8'));
            logLine('hls var ok ' + u.substring(0, 70));
            cb(null, varCache[u]);
            return;
        }
        logLine('hls var err ' + err.message + ' ' + u.substring(0, 70));
        cb(err);
    });
}

function hlsMaster(qs, res) {
    var src = qs.u ? String(qs.u) : '';
    if (!/^https:\/\//.test(src)) {
        sendErr(res, 400, 'bad url');
        return;
    }
    var staticMode = qs.s === '1';
    fetchVariantText(
        src,
        function (err, text) {
            if (err) {
                sendErr(res, 502, 'fetch failed');
                return;
            }
            if (text.indexOf('#EXT-X-STREAM-INF') === -1 && text.indexOf('#EXT-X-MEDIA:') === -1) {
                hlsRewriteVariant(src, text, res);
                return;
            }
        var lines = text.split('\n');
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r$/, '');
            if (line.charAt(0) === '#') {
                out.push(
                    line.replace(/URI="([^"]+)"/g, function (m, u) {
                        var abs = url.resolve(src, u);
                        return /^https:\/\//.test(abs) ? 'URI="' + localVar(abs) + '"' : m;
                    })
                );
            } else if (line.length) {
                var abs2 = url.resolve(src, line);
                out.push(/^https:\/\//.test(abs2) ? localVar(abs2) : line);
            } else {
                out.push(line);
            }
        }
        logLine('hls master ok ' + src.substring(0, 80));
        sendText(res, out.join('\n'));
    }, staticMode);
}

function hlsRewriteVariant(base, text, res) {
    var lines = text.split('\n');
    var mapAbs = '';
    var i;
    var seq = '?';
    var firstSeg = '';
    var lastSeg = '';
    var segCount = 0;
    for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) seq = lines[i].substring(22);
        if (lines[i].indexOf('#EXT-X-MAP:') === 0) {
            var mm = lines[i].match(/URI="([^"]+)"/);
            if (mm) mapAbs = url.resolve(base, mm[1]);
        } else if (lines[i].indexOf('#EXT-X-KEY:') === 0 && lines[i].indexOf('METHOD=AES') !== -1) {
            sendErr(res, 502, 'encrypted playlist not supported');
            return;
        }
    }
    var out = [];
    var allIds = [];
    for (i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (line.indexOf('#EXT-X-MAP:') === 0) continue; // TS is self-contained
        if (line.charAt(0) === '#') {
            out.push(line);
            continue;
        }
        if (line.length) {
            var abs = url.resolve(base, line);
            if (!firstSeg) firstSeg = segId(abs);
            lastSeg = segId(abs);
            allIds.push(segId(abs));
            segCount++;
            out.push(/^https:\/\//.test(abs) ? localSeg(abs, mapAbs) : line);
        } else {
            out.push(line);
        }
    }
    logLine('varserve seq=' + seq + ' n=' + segCount + ' ids=' + allIds.join(','));
    sendText(res, out.join('\n'));
}

function getInitInfo(mapUrl, cb) {
    var hit = initInfoCache[mapUrl];
    if (hit) {
        var idx = initInfoOrder.indexOf(mapUrl);
        if (idx >= 0) initInfoOrder.splice(idx, 1);
        initInfoOrder.push(mapUrl);
        cb(null, hit);
        return;
    }
    fetchBuf(mapUrl, function (err, buf) {
        if (err) {
            cb(err);
            return;
        }
        var info = parseInit(buf);
        if (!info) {
            cb(new Error('bad init'));
            return;
        }
        initInfoCache[mapUrl] = info;
        initInfoOrder.push(mapUrl);
        while (initInfoOrder.length > INIT_CACHE_MAX) {
            delete initInfoCache[initInfoOrder.shift()];
        }
        cb(null, info);
    });
}

function tsCacheGet(k) {
    var v = tsCache[k];
    if (!v) return null;
    var idx = tsCacheOrder.indexOf(k);
    if (idx >= 0) tsCacheOrder.splice(idx, 1);
    tsCacheOrder.push(k);
    return v;
}

function tsCachePut(k, v) {
    if (tsCache[k]) tsCacheBytes -= tsCache[k].length;
    tsCache[k] = v;
    tsCacheBytes += v.length;
    tsCacheOrder.push(k);
    while (tsCacheOrder.length > TS_CACHE_MAX_ITEMS || tsCacheBytes > TS_CACHE_MAX_BYTES) {
        var old = tsCacheOrder.shift();
        if (tsCache[old]) {
            tsCacheBytes -= tsCache[old].length;
            delete tsCache[old];
        }
    }
}

function hlsSegment(qs, res) {
    var segUrl = qs.u ? String(qs.u) : '';
    var mapUrl = qs.m ? String(qs.m) : '';
    if (!/^https:\/\//.test(segUrl) || !/^https:\/\//.test(mapUrl)) {
        sendErr(res, 400, 'bad url');
        return;
    }
    logLine('segreq ' + segId(segUrl));
    var hit = tsCacheGet(segUrl);
    if (hit) {
        sendTs(res, hit);
        return;
    }
    getInitInfo(mapUrl, function (err, info) {
        if (err) {
            logLine('hls init err ' + err.message);
            sendErr(res, 502, 'init fetch failed');
            return;
        }
        fetchBuf(segUrl, function (err2, segBuf) {
            if (err2) {
                logLine('hls seg err ' + err2.message + ' ' + segUrl.substring(0, 80));
                sendErr(res, 502, 'segment fetch failed');
                return;
            }
            var ts = null;
            var stats = {dropped: 0, total: 0, last: ''};
            try {
                ts = muxSegment(info, segBuf, stats);
            } catch (e) {
                logLine('hls mux err ' + e.message);
            }
            if (stats.dropped) {
                logLine('hls mux dropped ' + stats.dropped + '/' + stats.total + ' ' + stats.last);
            }
            if (!ts) {
                sendErr(res, 502, 'transmux failed');
                return;
            }
            tsCachePut(segUrl, ts);
            logLine('hls seg ok ' + ts.length + 'B ' + segUrl.substring(segUrl.length - 40));
            sendTs(res, ts);
        });
    });
}

function sendTs(res, buf) {
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
}

// --- server ---------------------------------------------------------------

function startServer() {
    http
        .createServer(function (req, res) {
            lastReqMs = Date.now();
            // CORS on EVERY response: the hosted page (https origin) plays the
            // media and may read frames back (canvas.drawImage + toDataURL for
            // visual verification) - cross-origin media without ACAO taints the
            // canvas. Guarded so explicit headers are not duplicated.
            var origWriteHead = res.writeHead;
            res.writeHead = function () {
                try {
                    var headers = arguments[arguments.length - 1];
                    if (headers && typeof headers === 'object' && !headers['Access-Control-Allow-Origin']) {
                        headers['Access-Control-Allow-Origin'] = '*';
                    }
                } catch (eHdr) {}
                return origWriteHead.apply(res, arguments);
            };
            var parsedReq = url.parse(req.url);
            var p = parsedReq.pathname;
            try {
                p = decodeURIComponent(p);
            } catch (e) {}
            var qs = url.parse(req.url, true).query || {};
            if (p.indexOf('/hls/') === 0) {
                logLine('req ' + p);
                var sttvFinished = false;
                res.on('finish', function () {
                    sttvFinished = true;
                });
                res.on('close', function () {
                    if (!sttvFinished) logLine('abort ' + p);
                });
            }
            if (p === '/sttv_proxy') {
                proxyPass(qs.url ? String(qs.url) : '', res);
                return;
            }
            if (p === '/health') {
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'Cache-Control': 'no-store',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end('ok');
                return;
            }
            if (p === '/hls/master.m3u8') {
                hlsMaster(qs, res);
                return;
            }
            if (p === '/hls/var.m3u8') {
                var vu = qs.u ? String(qs.u) : '';
                if (!/^https:\/\//.test(vu)) {
                    sendErr(res, 400, 'bad url');
                    return;
                }
                fetchVariantText(vu, function (err, text) {
                    if (err) {
                        sendErr(res, 502, 'fetch failed');
                        return;
                    }
                    hlsRewriteVariant(vu, text, res);
                });
                return;
            }
            if (p === '/hls/seg.ts') {
                hlsSegment(qs, res);
                return;
            }
            if (p.indexOf(MOUNT) !== 0) {
                p = MOUNT + (p.charAt(0) === '/' ? p : '/' + p);
            }
            if (p.charAt(p.length - 1) === '/') p += 'index.html';
            var file = path.normalize(path.join(ROOT, p));
            if (file.indexOf(ROOT) !== 0) {
                res.writeHead(403);
                res.end('forbidden');
                return;
            }
            fs.readFile(file, function (err, data) {
                if (err) {
                    res.writeHead(404, {'Content-Type': 'text/plain'});
                    res.end('404 ' + p);
                    logLine(req.method + ' ' + p + ' -> 404');
                    return;
                }
                var ext = path.extname(file).toLowerCase();
                res.writeHead(200, {
                    'Content-Type': MIME[ext] || 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store'
                });
                res.end(data);
                logLine(req.method + ' ' + p + ' -> 200 ' + data.length);
            });
        })
        .listen(PORT, '0.0.0.0', function () {
            logLine('listening on ' + PORT);
            // Heartbeat self-stop (see STTV_SERVE_HEARTBEAT_EXIT_MS).
            setInterval(function () {
                if (Date.now() - lastReqMs > STTV_SERVE_HEARTBEAT_EXIT_MS) {
                    logLine(
                        'heartbeat-timeout: no request for ' +
                            STTV_SERVE_HEARTBEAT_EXIT_MS / 1000 +
                            's (app closed?), exiting'
                    );
                    process.exit(0);
                }
            }, 15000);
        });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    parseInit: parseInit,
    parseSeg: parseSeg,
    muxSegment: muxSegment,
    buildPat: buildPat,
    buildPmt: buildPmt,
    startServer: startServer
};
