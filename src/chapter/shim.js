// Runs as a CLASSIC script before the runner module (see page.html). An offscreen document
// is given only the `runtime` API, so `chrome.storage` is undefined there and every module
// that reads settings would throw at import time. This installs a proxy area backed by the
// background page, which has full storage access. It must not be an ES module: module
// evaluation order would put the runner's own imports first.
(function () {
    'use strict';
    if (typeof chrome === 'undefined') return;
    var existing = chrome.storage;
    if (existing && existing.local && existing.session) return; // background page: real storage

    function send(type, payload) {
        return chrome.runtime.sendMessage(Object.assign({ type: type }, payload));
    }
    function area(name) {
        return {
            get: function (keys) { return send('mt:storage-get', { area: name, keys: keys == null ? null : keys }); },
            set: function (items) {
                return send('mt:storage-set', { area: name, items: items }).then(function (r) {
                    if (r && r.ok === false) throw new Error(r.error || 'storage set failed');
                });
            },
            remove: function (keys) {
                return send('mt:storage-remove', { area: name, keys: keys }).then(function (r) {
                    if (r && r.ok === false) throw new Error(r.error || 'storage remove failed');
                });
            },
            clear: function () {
                return send('mt:storage-clear', { area: name }).then(function (r) {
                    if (r && r.ok === false) throw new Error(r.error || 'storage clear failed');
                });
            },
            // Storage-change events cannot cross contexts. The runner re-reads on demand and
            // stops on a settings change, so a no-op event keeps every caller working.
            onChanged: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
        };
    }
    var noopEvent = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
    var shim = { local: area('local'), session: area('session'), onChanged: noopEvent };
    try {
        Object.defineProperty(chrome, 'storage', { value: shim, configurable: true, writable: true });
    } catch (e) {
        if (existing && typeof existing === 'object') {
            try { existing.local = shim.local; existing.session = shim.session; } catch (e2) { /* frozen */ }
        }
    }
})();
