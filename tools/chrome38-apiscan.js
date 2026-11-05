/* Scan shipped JS for runtime APIs missing in Chrome 38 (V8 3.28 / 2014).
 * Syntax issues are covered by chrome38-audit.js; this covers *runtime* calls.
 * Usage: node tools/chrome38-apiscan.js [files...]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// API -> Chrome version that introduced it ( > 38 = MISSING on the TV )
const API_CHROME_INTRODUCED = {
    // ES2015+ methods
    'String.prototype.startsWith': 41,
    'String.prototype.endsWith': 41,
    'String.prototype.includes': 41,
    'String.prototype.repeat': 41,
    'String.prototype.codePointAt': 41,
    'String.fromCodePoint': 41,
    'String.raw': 41,
    'String.prototype.padStart': 57,
    'String.prototype.padEnd': 57,
    'Array.prototype.includes': 47,
    'Array.prototype.find': 45,
    'Array.prototype.findIndex': 45,
    'Array.from': 45,
    'Array.of': 39,
    'Array.prototype.flat': 69,
    'Array.prototype.flatMap': 69,
    'Object.assign': 45,
    'Object.values': 54,
    'Object.entries': 54,
    'Object.setPrototypeOf': 31,
    'Object.getOwnPropertySymbols': 38,
    'Number.isInteger': 34,
    'Number.parseInt': 34,
    'Number.parseFloat': 34,
    'Math.trunc': 38,
    'Math.sign': 38,
    'Math.hypot': 38,
    'Promise.prototype.finally': 63,
    'Promise.allSettled': 76,
    'Promise.any': 85,
    'Promise.allSettled': 76,
    'String.prototype.normalize': 34,
    // DOM
    'Element.prototype.closest': 41,
    'Element.prototype.matches': 34,
    'Element.prototype.remove': 23,
    'Element.prototype.scrollIntoView': 4,
    'NodeList.prototype.forEach': 51,
    'HTMLFormElement.prototype.requestSubmit': 76,
    'URLSearchParams': 49,
    'URL.prototype.searchParams': 49,
    'TextEncoder': 38,
    'TextDecoder': 38,
    'IntersectionObserver': 51,
    'ResizeObserver': 64,
    'MutationObserver': 26,
    'requestIdleCallback': 47,
    'queueMicrotask': 71,
    'crypto.subtle': 37,
    'navigator.sendBeacon': 39,
    'window.fetch': 42,
    'CustomEvent': 6,
    'Intl.Collator': 24,
    'WeakMap': 36,
    'Map': 38,
    'Set': 38,
    'Symbol': 38,
    'Proxy': 49,
    'Reflect': 49,
    'for of': 38,
    'Object.getOwnPropertyNames': 5,
    'Object.freeze': 5,
    'defineProperty': 5,
    'getAttribute': 1,
    'dataset': 6,
    'classList': 8
};

// call/usage patterns -> canonical API key
const PATTERNS = [
    [/\bString\.prototype\.(\w+)/g, (m) => 'String.prototype.' + m[1]],
    [/\.(\w+)\s*\(/g, (m) => m[1]], // resolved below via MEMBER map
    [/\bObject\.(\w+)\s*\(/g, (m) => 'Object.' + m[1]],
    [/\bArray\.(\w+)\s*\(/g, (m) => 'Array.' + m[1]],
    [/\bNumber\.(\w+)\s*\(/g, (m) => 'Number.' + m[1]],
    [/\bMath\.(\w+)/g, (m) => 'Math.' + m[1]],
    [/\bURLSearchParams\b/g, () => 'URLSearchParams'],
    [/\bnew URL\b/g, () => 'URL'],
    [/\bfetch\s*\(/g, () => 'window.fetch'],
    [/\bnew TextEncoder\b/g, () => 'TextEncoder'],
    [/\bnew TextDecoder\b/g, () => 'TextDecoder'],
    [/\bIntersectionObserver\b/g, () => 'IntersectionObserver'],
    [/\bResizeObserver\b/g, () => 'ResizeObserver'],
    [/\brequestIdleCallback\s*\(/g, () => 'requestIdleCallback'],
    [/\bqueueMicrotask\s*\(/g, () => 'queueMicrotask'],
    [/\bsendBeacon\s*\(/g, () => 'navigator.sendBeacon'],
    [/\bPromise\.(allSettled|any|resolve|all|race)\s*\(/g, (m) => 'Promise.' + m[1]],
    [/\.finally\s*\(/g, () => 'Promise.prototype.finally'],
    [/\bnew Proxy\s*\(/g, () => 'Proxy'],
    [/\bReflect\.\w+/g, () => 'Reflect']
];

// method name -> owner API key (for `.method(` usage)
const METHOD_OWNER = {
    startsWith: 'String.prototype.startsWith',
    endsWith: 'String.prototype.endsWith',
    includes: 'String.prototype.includes', // also Array.includes; both >38 anyway
    repeat: 'String.prototype.repeat',
    padStart: 'String.prototype.padStart',
    padEnd: 'String.prototype.padEnd',
    codePointAt: 'String.prototype.codePointAt',
    normalize: 'String.prototype.normalize',
    find: 'Array.prototype.find',
    findIndex: 'Array.prototype.findIndex',
    assign: 'Object.assign',
    values: 'Object.values',
    entries: 'Object.entries',
    setPrototypeOf: 'Object.setPrototypeOf',
    isInteger: 'Number.isInteger',
    trunc: 'Math.trunc',
    sign: 'Math.sign',
    hypot: 'Math.hypot',
    closest: 'Element.prototype.closest',
    matches: 'Element.prototype.matches',
    scrollIntoView: 'Element.prototype.scrollIntoView',
    remove: 'Element.prototype.remove'
};

const files = process.argv.slice(2);
if (!files.length) {
    // default: built main.js + bridge + extrapage
    for (const f of [
        'release/githubio/js/main_uncompressed.js',
        'release/githubio/js/main.js',
        'release/githubio/js/Extrapage.js',
        'release/api.js'
    ]) {
        const full = path.join(root, f);
        if (fs.existsSync(full)) files.push(full);
    }
}

const findings = new Map(); // api -> Set(file)

for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('skip ' + file); continue; }
    const rel = path.relative(root, file).replace(/\\/g, '/');

    function note(api) {
        const intro = API_CHROME_INTRODUCED[api];
        if (intro && intro > 38) {
            if (!findings.has(api)) findings.set(api, new Set());
            findings.get(api).add(rel);
        }
    }

    // member calls: .method(
    const callRe = /\.([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = callRe.exec(src)) !== null) {
        const owner = METHOD_OWNER[m[1]];
        if (owner) note(owner);
    }
    // static/standalone patterns
    for (const [re, keyFn] of PATTERNS) {
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) note(keyFn(m));
    }
    // URL searchParams usage
    if (/\.searchParams\b/.test(src)) note('URL.prototype.searchParams');
    if (/\bURLSearchParams\b/.test(src)) note('URLSearchParams');
    // for..of / spread in shipped code (syntax handled by audit, but double-check)
    if (/\bfor\s*\(\s*[\w$]+\s+of\s+/.test(src)) note('for of');
    // Promise usage (Chrome 38 HAS Promise - intro 32, so never flagged)
    // Map/Set/Symbol: intro 38, present
}

if (!findings.size) {
    console.log('No Chrome 38 runtime API gaps found in: ' + files.join(', '));
} else {
    console.log('Chrome 38 runtime API gaps:');
    for (const [api, set] of [...findings].sort((a, b) => (API_CHROME_INTRODUCED[b[0]] || 0) - (API_CHROME_INTRODUCED[a[0]] || 0))) {
        console.log('  ' + api + ' (Chrome ' + API_CHROME_INTRODUCED[api] + ')  <-  ' + [...set].join(', '));
    }
    process.exitCode = 1;
}
