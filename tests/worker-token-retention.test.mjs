import ts from 'typescript';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = ts.createSourceFile('background.ts', readFileSync('src/background/background.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let handler;
function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(source) === "msg?.type === 'mt:worker-token'") handler = node.thenStatement.getText(source);
    ts.forEachChild(node, visit);
}
visit(source); assert.ok(handler);
const compiled = await transform('function register(msg, sendResponse) ' + handler.replace("await import('../storage-session')", 'session'), { loader: 'ts' });

test('recreated inference workers prune full session keys and retain the latest token', async () => {
    const data = { mtChapterTab: 'keep' };
    const scope = { session: {
        sessGet: async () => ({ ...data }),
        sessSet: async values => Object.assign(data, values),
        sessRemove: async keys => keys.forEach(key => { delete data[key]; }),
    } };
    runInNewContext(compiled.code, scope);
    for (let i = 0; i < 80; i++) {
        const nonce = i.toString(16).padStart(16, '0');
        const response = await new Promise(resolve => scope.register({ nonce, token: '1'.repeat(32) }, resolve));
        assert.equal(response.ok, true);
        assert.equal(data['mtWorkerToken:' + nonce], '1'.repeat(32));
        assert.ok(Object.keys(data).filter(key => key.startsWith('mtWorkerToken:')).length <= 32);
    }
    assert.equal(data.mtChapterTab, 'keep');
    assert.equal(data['mtWorkerToken:0000000000000000'], undefined);
});
