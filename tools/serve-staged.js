/* Minimal static file server for local Chrome 38 testing.
 * Serves .tmp/hosted-release-artifact under /SmartTwitchWebOSTV/ so the bridge's
 * detectRepoBasePath() resolves exactly like production github.io URLs.
 * Usage: node tools/serve-staged.js [port]
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '.tmp', 'hosted-release-artifact');
const prefix = '/SmartTwitchWebOSTV';
const port = parseInt(process.argv[2], 10) || 8090;

// Same-origin media proxy used by the bridge's MSE fMP4 player: VOD segment
// hosts (cloudfront) send no ACAO header, so the page cannot XHR them
// cross-origin. Streams the upstream bytes back unmodified.
function proxyPass(target, res, redirects) {
    const hops = redirects || 0;
    if (!/^https:\/\//.test(target)) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('bad url');
        return;
    }
    let u;
    try {
        u = new URL(target);
    } catch (e) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('bad url');
        return;
    }
    const pr = https.get(
        {
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Web0S; Linux armv7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.122 Safari/537.36'
            }
        },
        function (up) {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 3) {
                up.resume();
                const next = new URL(up.headers.location, u).toString();
                if (/^https:\/\//.test(next)) {
                    proxyPass(next, res, hops + 1);
                    return;
                }
            }
            if (up.statusCode !== 200) {
                res.writeHead(up.statusCode || 502, {'Content-Type': 'text/plain'});
                up.resume();
                res.end('upstream ' + up.statusCode);
                return;
            }
            res.writeHead(200, {
                'Content-Type': up.headers['content-type'] || 'application/octet-stream',
                'Cache-Control': 'no-store'
            });
            up.pipe(res);
        }
    );
    pr.on('error', function (e) {
        try {
            res.writeHead(502);
            res.end('proxy error');
        } catch (x) {}
        console.log('proxy error ' + e.message);
    });
    pr.setTimeout(30000, function () {
        pr.destroy();
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
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

const server = http.createServer(function (req, res) {
    var urlPath = req.url.split('?')[0];
    try {
        urlPath = decodeURIComponent(urlPath);
    } catch (e) {}
    if (urlPath === '/sttv_proxy') {
        var target = '';
        var qi = req.url.indexOf('?');
        if (qi !== -1) {
            var pairs = req.url.slice(qi + 1).split('&');
            for (var pi = 0; pi < pairs.length; pi++) {
                var kv = pairs[pi].split('=');
                if (kv[0] === 'url') target = decodeURIComponent(kv.slice(1).join('=') || '');
            }
        }
        proxyPass(target, res);
        return;
    }
    if (urlPath.indexOf(prefix + '/') === 0) {
        urlPath = urlPath.slice(prefix.length);
    }
    if (urlPath.indexOf('/release/') === 0) {
        // allow plain /release/... too
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/release/index.html';
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    var file = path.normalize(path.join(root, urlPath));
    if (file.indexOf(root) !== 0) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }
    fs.readFile(file, function (err, data) {
        if (err) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('404 ' + urlPath);
            return;
        }
        var ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        });
        res.end(data);
        console.log(req.method + ' ' + urlPath + ' -> ' + (err ? 404 : 200) + ' (' + data.length + 'B)');
    });
});

server.listen(port, '0.0.0.0', function () {
    console.log('serving ' + root);
    console.log('  http://192.168.1.108:' + port + prefix + '/release/index.html');
    console.log('  http://192.168.1.108:' + port + '/release/index.html');
});
