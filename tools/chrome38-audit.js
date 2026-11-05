/* Chrome 38 / ES5 audit: parse every shipped JS file with esprima and report
 * any AST node type that is not valid ES5 (Chrome 38 = V8 3.28, no ES6 syntax).
 * Usage: node tools/chrome38-audit.js
 */
const fs = require('fs');
const path = require('path');
const esprima = require('esprima');

const root = path.resolve(__dirname, '..');

// Complete ES5 AST node type whitelist (esprima 4 / ESTree ES5 subset)
const ES5_TYPES = new Set([
    'Program', 'Statement', 'Expression',
    'EmptyStatement', 'BlockStatement', 'ExpressionStatement', 'IfStatement',
    'LabeledStatement', 'WithStatement', 'SwitchStatement', 'SwitchCase',
    'ReturnStatement', 'BreakStatement', 'ContinueStatement', 'ThrowStatement',
    'TryStatement', 'CatchClause', 'WhileStatement', 'DoWhileStatement',
    'ForStatement', 'ForInStatement', 'DebuggerStatement',
    'VariableDeclaration', 'VariableDeclarator',
    'FunctionDeclaration', 'FunctionExpression',
    'ThisExpression', 'ArrayExpression', 'ObjectExpression', 'Property',
    'SequenceExpression', 'UnaryExpression', 'UpdateExpression',
    'BinaryExpression', 'LogicalExpression', 'AssignmentExpression',
    'ConditionalExpression', 'NewExpression', 'CallExpression', 'MemberExpression',
    'Identifier', 'Literal', 'Program'
]);

const targets = [];

function walkDir(dir) {
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === '.git' || entry === 'temp_maker' || entry === 'untranslated') continue;
            walkDir(full);
        } else if (entry.endsWith('.js')) {
            targets.push(full);
        }
    }
}

// shipped code only: app sources, bridge, wrapper, release glue, extrapage
walkDir(path.join(root, 'app'));
walkDir(path.join(root, 'webos'));
targets.push(path.join(root, 'release', 'api.js'));
// built artifacts (what the TV actually downloads) — keep them honest too:
for (const built of [
    'release/githubio/js/main.js',
    'release/githubio/js/main_uncompressed.js',
    'release/githubio/js/Extrapage.js',
    'release/githubio/js/webosCompatBridge.js',
    'release/index.html',
    'release/extrapageindex.html'
]) {
    const full = path.join(root, built);
    if (fs.existsSync(full)) targets.push(full);
}

let failCount = 0;

for (const file of targets) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    let source;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch (e) {
        continue;
    }
    if (!source.trim()) continue;

    if (rel.endsWith('.html')) {
        // extract inline scripts (skip external src= scripts)
        const scripts = [];
        const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(source)) !== null) {
            if (/\bsrc\s*=/i.test(m[1])) continue;
            if (m[2].trim()) scripts.push(m[2]);
        }
        if (!scripts.length) continue;
        source = scripts.join('\n;\n');
    }

    let ast;
    try {
        ast = esprima.parse(source, {loc: true, tolerant: false});
    } catch (err) {
        // Parse failure on a strict-ES5 parser attempt: esprima 4 parses ES6+,
        // so a failure means genuinely broken syntax (or module syntax).
        console.log('PARSE-FAIL  ' + rel + '  line ' + (err.lineNumber || '?') + '  ' + err.description);
        failCount++;
        continue;
    }

    const findings = new Map(); // label -> first line

    function note(label, node) {
        if (!findings.has(label)) {
            findings.set(label, node && node.loc ? node.loc.start.line : '?');
        }
    }

    (function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (typeof node.type === 'string') {
            if (!ES5_TYPES.has(node.type)) {
                note(node.type, node);
            }
            // ES5-legal type, but ES6+ payload:
            if (node.type === 'VariableDeclaration' && node.kind && node.kind !== 'var') {
                note(node.kind + '-declaration', node);
            }
            if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && (node.generator || node.async)) {
                note((node.async ? 'async' : 'generator') + '-function', node);
            }
            if (node.type === 'Property' && (node.shorthand || node.method || node.computed)) {
                note('Property-' + (node.shorthand ? 'shorthand' : node.method ? 'method' : 'computed'), node);
            }
            if (node.type === 'MemberExpression' && node.computed === false && node.property && node.property.type === 'Identifier' && false) {
                // nothing: static member access is ES5
            }
            if (node.type === 'ObjectExpression') {
                // detect {a, b} shorthand already covered by Property; detect getter/setter is ES5 ok
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            visit(node[key]);
        }
    })(ast);

    if (findings.size) {
        failCount++;
        const list = [];
        for (const [type, line] of findings) list.push(type + '@' + line);
        console.log('ES6+        ' + rel + '  ->  ' + list.join(', '));
    }
}

console.log('\n' + failCount + ' file(s) with Chrome 38 incompatibilities.');
process.exit(failCount ? 1 : 0);
