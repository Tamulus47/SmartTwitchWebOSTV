/* Audit arbitrary JS files (e.g. CDN deps) for Chrome 38 / ES5 compatibility.
 * Usage: node tools/chrome38-audit-file.js file1.js file2.js ...
 */
const fs = require('fs');
const esprima = require('esprima');

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

let fail = 0;
for (const file of process.argv.slice(2)) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('MISSING ' + file); continue; }
    let ast;
    try {
        ast = esprima.parse(source, {loc: true, tolerant: false});
    } catch (err) {
        console.log('PARSE-FAIL  ' + file + '  line ' + (err.lineNumber || '?') + '  ' + err.description);
        fail++;
        continue;
    }
    const findings = new Map();
    (function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (typeof node.type === 'string' && !ES5_TYPES.has(node.type) && !findings.has(node.type)) {
            findings.set(node.type, node.loc ? node.loc.start.line : '?');
        }
        if (node.type === 'VariableDeclaration' && node.kind && node.kind !== 'var' && !findings.has(node.kind)) {
            findings.set(node.kind, node.loc ? node.loc.start.line : '?');
        }
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && (node.generator || node.async) && !findings.has('async/gen')) {
            findings.set('async/gen', node.loc ? node.loc.start.line : '?');
        }
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'range') continue;
            visit(node[key]);
        }
    })(ast);
    if (findings.size) {
        fail++;
        const list = [];
        for (const [type, line] of findings) list.push(type + '@' + line);
        console.log('ES6+  ' + file + '  ->  ' + list.join(', '));
    } else {
        console.log('ES5-OK  ' + file);
    }
}
process.exit(fail ? 1 : 0);
