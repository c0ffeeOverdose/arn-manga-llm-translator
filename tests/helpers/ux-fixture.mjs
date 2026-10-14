import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';

export async function compileBoundary(entry, { extra = '', real = [] } = {}) {
    const path = resolve(entry), source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports = {};
    for (const node of ast.statements) {
        if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || real.includes(node.moduleSpecifier.text)) continue;
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        imports[node.moduleSpecifier.text] ??= new Set();
        for (const item of bindings.elements) if (!item.isTypeOnly) imports[node.moduleSpecifier.text].add((item.propertyName ?? item.name).text);
    }
    const stubs = Object.fromEntries(Object.entries(imports).map(([path, names]) => [path,
        [...names].map(name => `export const ${name} = fixture[${JSON.stringify(name)}];`).join('\n')]));
    const result = await build({ entryPoints: [path], write: false, bundle: true, format: 'iife', globalName: 'Subject',
        logLevel: 'silent', plugins: [{ name: 'ux-boundaries', setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => args.importer === path && args.path in stubs
                ? { path: args.path, namespace: 'boundary' } : undefined);
            builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: stubs[args.path], loader: 'js' }));
            builder.onLoad({ filter: /\.ts$/ }, args => args.path === path ? { contents: source + '\n' + extra, loader: 'ts' } : undefined);
        } }] });
    return result.outputFiles[0].text;
}

export function boundary(values) {
    return new Proxy(values, { get: (object, key) => key in object ? object[key] : () => {} });
}
export function evaluate(code, fixture, globals = {}) {
    const world = { fixture, console, structuredClone, DOMException, AbortController, AbortSignal,
        setTimeout, clearTimeout, setInterval, clearInterval, URL, Date, performance, ...globals };
    runInNewContext(code, world);
    return world.Subject;
}
export async function tick() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
export function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
export class Element {
    children = []; style = {}; dataset = {}; value = ''; textContent = ''; offsetWidth = 0;
    checked = false; disabled = false; open = false; hidden = false;
    classList = { add() {}, remove() {}, toggle() {} };
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    set innerHTML(_value) { this.children = []; }
    addEventListener() {} setAttribute() {} removeAttribute() {} focus() {} select() {}
}
export function elements() {
    const nodes = new Map();
    const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
    return { $, document: { getElementById: $, documentElement: { dataset: {} }, createElement: () => new Element(),
        addEventListener() {}, querySelectorAll: () => [], body: { classList: { toggle() {} } } } };
}
