const fs = require('fs');
const path = require('path');
const jshint = require('jshint').JSHINT;

const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'webos', 'bridge', 'webosCompatBridge.js');

const options = {
    eqeqeq: true,
    laxbreak: true,
    undef: true,
    unused: 'strict',
    browser: true,
    node: true
};

const predef = {
    Android: true,
    punycode: true,
    smartTwitchTV: true,
    firebase: true,
    dataLayer: true,
    ActiveXObject: true,
    Twitch: true,
    global: true
};

if (!fs.existsSync(bridgePath)) {
    console.error('Missing bridge source: ' + bridgePath);
    process.exit(1);
}

const source = fs.readFileSync(bridgePath, 'utf8');
jshint(source, options, predef);
const errors = (jshint.data() && jshint.data().errors) || [];

if (errors.length) {
    console.error('\nwebos bridge jshint fail: ' + bridgePath + '\n');
    errors.forEach((error) => {
        if (!error) return;
        console.error('Line ' + error.line + ' reason ' + error.reason + ' code ' + error.code + ' evidence ' + (error.evidence || ''));
    });
    console.error('\nTotal errors = ' + errors.length + '\n');
    process.exit(1);
}

console.log('\nwebos bridge jshint ok: ' + bridgePath + '\n');

// The remux server ships inside the service package so it can be spawned
// without a rooted TV. Keep it byte-identical to the standalone copy used for
// manual deploys, otherwise the two paths silently diverge.
const serverDeployPath = path.join(root, 'tools', 'tv-serve.js');
const serverBundledPath = path.join(root, 'webos', 'service', 'sttv_serve.js');

if (!fs.existsSync(serverBundledPath)) {
    console.error('\nMissing bundled remux server: ' + serverBundledPath + '\n');
    process.exit(1);
}

const deploySource = fs.readFileSync(serverDeployPath, 'utf8');
const bundledSource = fs.readFileSync(serverBundledPath, 'utf8');

if (deploySource !== bundledSource) {
    console.error('\nwebos bundled remux server is out of sync with tools/tv-serve.js\n');
    console.error('  tools/tv-serve.js            sha256 differs from');
    console.error('  webos/service/sttv_serve.js\n');
    console.error('Re-copy it: Copy-Item tools/tv-serve.js webos/service/sttv_serve.js\n');
    process.exit(1);
}

console.log('webos bundled remux server ok (byte-identical to tools/tv-serve.js)\n');
