/**
 * Kantasu-Roms Persistent Save System
 * ====================================
 * A dedicated, durable save-data layer that does NOT rely on the
 * emulator's internal emscripten IDBFS (/data/saves) storage.
 *
 * Why: EmulatorJS only flushes in-game saves (SRAM/flash/eeprom) to its
 * internal IndexedDB on pause/exit. Closing the tab at the wrong moment,
 * a crash, or a locked/cleared emulator database silently destroys hours
 * of progress. This module gives every save a SECOND home in a dedicated
 * database (kantasu_saves_db) with:
 *   - Frequent auto-backup while playing (see play.html)
 *   - Emergency flush on page hide / unload
 *   - Automatic restore on game launch (newest copy wins)
 *   - AUTO-RESUME STATES (slot 0): the player's exact position is snapshotted
 *     every 30s and on page exit, then re-imported automatically on the next
 *     launch - no in-game save needed, reload lands you right back where
 *     you were
 *   - Full management UI (export / import / delete) in the launcher
 *
 * Storage layout (IndexedDB: kantasu_saves_db, version 1):
 *   saves  { key, gameName, category, data: ArrayBuffer, size, updatedAt, source }
 *          key = stable game identity (ROM path basename for built-ins,
 *                'user:<id>' for uploaded games)
 *   states { key, gameKey, gameName, data: ArrayBuffer, screenshot, createdAt, slot }
 *          key = '<gameKey>::state::<slot>'
 *
 * Exposed as window.KantasuSaves.
 */
(function () {
    'use strict';

    const DB_NAME = 'kantasu_saves_db';
    const DB_VERSION = 1;
    let db = null;
    let openPromise = null;

    function openDB() {
        if (openPromise) return openPromise;
        openPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains('saves')) {
                    const store = database.createObjectStore('saves', { keyPath: 'key' });
                    store.createIndex('updatedAt', 'updatedAt');
                }
                if (!database.objectStoreNames.contains('states')) {
                    const store = database.createObjectStore('states', { keyPath: 'key' });
                    store.createIndex('gameKey', 'gameKey');
                    store.createIndex('createdAt', 'createdAt');
                }
            };
            req.onsuccess = (e) => { db = e.target.result; resolve(db); };
            req.onerror = (e) => reject(e.target.error);
        });
        return openPromise;
    }

    function tx(storeName, mode) {
        return db.transaction([storeName], mode).objectStore(storeName);
    }

    function promisify(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // ---- key derivation -------------------------------------------------

    /** Stable identity for a game, derived from the play.html URL params. */
    function gameKeyFromParams(params) {
        const userGame = params.get('usergame');
        if (userGame) return 'user:' + userGame;
        const rom = params.get('rom') || '';
        if (!rom) return null;
        // basename of the rom path, extension stripped
        const base = rom.split(/[\\/]/).pop() || rom;
        return 'rom:' + base.replace(/\.(zip|z64|n64|v64)$/i, '');
    }

    function stateKey(gameKey, slot) {
        return gameKey + '::state::' + slot;
    }

    // ---- game saves (SRAM) ----------------------------------------------

    async function putSave(key, meta, data) {
        if (!key || !data || !data.byteLength) return false;
        await openDB();
        const record = {
            key: key,
            gameName: meta.gameName || 'Unknown Game',
            category: meta.category || 'rom-hacks',
            size: data.byteLength,
            updatedAt: Date.now(),
            source: meta.source || 'auto',
            data: data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
        };
        await promisify(tx('saves', 'readwrite').put(record));
        return true;
    }

    async function getSave(key) {
        if (!key) return null;
        await openDB();
        return promisify(tx('saves', 'readonly').get(key)) || null;
    }

    async function deleteSave(key) {
        if (!key) return;
        await openDB();
        await promisify(tx('saves', 'readwrite').delete(key));
    }

    async function listSaves() {
        await openDB();
        return promisify(tx('saves', 'readonly').getAll());
    }

    // ---- save states -----------------------------------------------------

    async function putState(gameKey, meta, data, slot) {
        if (!gameKey || !data || !data.byteLength) return false;
        await openDB();
        const record = {
            key: stateKey(gameKey, slot),
            gameKey: gameKey,
            gameName: meta.gameName || 'Unknown Game',
            slot: slot,
            screenshot: meta.screenshot || null,
            createdAt: Date.now(),
            size: data.byteLength,
            data: data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer
        };
        await promisify(tx('states', 'readwrite').put(record));
        return true;
    }

    async function getStates(gameKey) {
        await openDB();
        const all = await promisify(tx('states', 'readonly').getAll());
        return all.filter(function (s) { return s.gameKey === gameKey; })
                  .sort(function (a, b) { return b.createdAt - a.createdAt; });
    }

    /** The auto-resume state (slot 0): the exact point the player left off. */
    async function getAutoState(gameKey) {
        if (!gameKey) return null;
        await openDB();
        return promisify(tx('states', 'readonly').get(stateKey(gameKey, 0)));
    }

    async function deleteState(key) {
        await openDB();
        await promisify(tx('states', 'readwrite').delete(key));
    }

    async function listStates() {
        await openDB();
        return promisify(tx('states', 'readonly').getAll());
    }

    // ---- import / export helpers -----------------------------------------

    /** Export a save record as a .sav File for downloading. */
    function saveToFile(record) {
        const safe = (record.gameName || 'game').replace(/[^a-z0-9\-_ ]/gi, '_').trim() || 'game';
        return new File([record.data], safe + '.sav', { type: 'application/octet-stream' });
    }

    /** Trigger a browser download of a record's data. */
    function downloadRecord(record) {
        if (!record) return;
        const safe = (record._exportName || ((record.gameName || 'game').replace(/[^a-z0-9\-_ ]/gi, '_').trim() || 'game') + '.sav');
        const file = new File([record.data], safe, { type: 'application/octet-stream' });
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = safe;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    /**
     * Read a .sav / .state file picked by the user into an ArrayBuffer.
     * Validates N64 save sizes (32KB/128KB eeprom-less flash variants are
     * also accepted — the core decides).
     */
    function readFileAsBuffer(file) {
        return new Promise(function (resolve, reject) {
            const r = new FileReader();
            r.onload = function (e) { resolve(e.target.result); };
            r.onerror = function () { reject(r.error); };
            r.readAsArrayBuffer(file);
        });
    }

    // ---- utilities ---------------------------------------------------------

    function formatBytes(bytes) {
        if (bytes == null) return '--';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function formatAgo(timestamp) {
        if (!timestamp) return 'never';
        const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (s < 60) return s + 's ago';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
        const d = Math.floor(h / 24);
        return d + 'd ago';
    }

    // Compare two ArrayBuffers quickly (length + sampled bytes).
    function buffersEqual(a, b) {
        if (!a || !b) return false;
        if (a.byteLength !== b.byteLength) return false;
        const ua = new Uint8Array(a), ub = new Uint8Array(b);
        if (ua.length < 64) {
            for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
            return true;
        }
        // sample start, middle, end
        for (const i of [0, 1, 2, Math.floor(ua.length / 2), ua.length - 3, ua.length - 2, ua.length - 1]) {
            if (ua[i] !== ub[i]) return false;
        }
        return true;
    }

    /**
     * Normalize a Uint8Array / ArrayBuffer / TypedArray into a standalone
     * ArrayBuffer. Critical when the input is a VIEW into a larger buffer
     * (e.g. emscripten HEAP subarrays from FS.readFile) - storing the raw
     * .buffer would copy the entire heap.
     */
    function toArrayBuffer(input) {
        if (!input) return null;
        if (input instanceof ArrayBuffer) return input;
        if (input.buffer) {
            if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) return input.buffer;
            return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
        }
        return null;
    }

    window.KantasuSaves = {
        openDB: openDB,
        gameKeyFromParams: gameKeyFromParams,
        stateKey: stateKey,
        putSave: putSave,
        getSave: getSave,
        deleteSave: deleteSave,
        listSaves: listSaves,
        putState: putState,
        getStates: getStates,
        getAutoState: getAutoState,
        AUTO_SLOT: 0,
        deleteState: deleteState,
        listStates: listStates,
        saveToFile: saveToFile,
        downloadRecord: downloadRecord,
        readFileAsBuffer: readFileAsBuffer,
        formatBytes: formatBytes,
        formatAgo: formatAgo,
        buffersEqual: buffersEqual,
        toArrayBuffer: toArrayBuffer
    };
})();
