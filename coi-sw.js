/*
 * coi-serviceworker.js
 *
 * Enables crossOriginIsolated (SharedArrayBuffer) on GitHub Pages, which
 * cannot send the COOP/COEP HTTP headers any other way. This service worker
 * intercepts document (navigation) responses and injects:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * which lets the browser mark the page as cross-origin isolated. With
 * isolation active, EmulatorJS can use its threaded cores
 * (EJS_threads = true), running N64 emulation on a real worker thread
 * instead of fighting the browser UI for the single main thread - the
 * single biggest performance win available for in-browser emulation.
 *
 * The window side (bottom half) registers the worker and performs a single
 * one-time page reload after activation, because the FIRST load of a page
 * is never isolated (headers only apply once the SW controls the document).
 * A sessionStorage flag prevents reload loops.
 *
 * Based on the coi-serviceworker technique (MIT, github.com/gzuidhof/coi-serviceworker),
 * adapted for kantasu-roms.
 */

// ===== Service Worker context =====
if (typeof window === "undefined") {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (event) => {
        if (event.data && event.data.type === "deregister") {
            self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
                clients.forEach((client) => client.navigate(client.url));
            });
        }
    });

    self.addEventListener("fetch", (event) => {
        const r = event.request;
        // Only rewrite navigation (document) requests. All other subresources
        // (ROMs, cores, wasm, scripts) are same-origin and pass through the
        // network untouched, so Range requests / streaming downloads keep working.
        if (r.mode !== "navigate") return;

        const request = new Request(r, { redirect: "follow" });
        event.respondWith(
            fetch(request).then((response) => {
                if (response.type === "opaqueredirect") return response;
                const headers = new Headers(response.headers);
                headers.set("Cross-Origin-Opener-Policy", "same-origin");
                headers.set("Cross-Origin-Embedder-Policy", "require-corp");
                headers.set("Cache-Control", "no-store");
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: headers,
                });
            }).catch((e) => {
                console.error("[coi-sw] fetch failed:", e);
                return fetch(r);
            })
        );
    });
}
// ===== Window context =====
else {
    // Synchronous reload decision - set BEFORE any async work so the page
    // can abort expensive/unsafe boot work (IndexedDB opens by the emulator)
    // before this worker reloads the document. A page killed mid-IndexedDB-
    // transaction leaves the database permanently locked (open() hangs
    // forever -> "game never loads"). This gate prevents that class of bug.
    // COI_RELOADING === true means: this page WILL be replaced by a reload in
    // a moment - do not start anything that must not be interrupted.
    //
    // LOOP-GUARD: the "already reloaded" marker is kept in sessionStorage AND
    // in window.name. sessionStorage throws (blocked cookies / storage
    // partitioning / opaque origins), and with the flag unset every page
    // reloaded itself forever - the "game never loads AT ALL" bug. window.name
    // survives same-tab reloads even with storage completely blocked.
    const COI_FLAG = "coiReloadedBySelf";
    const COI_NAME_TAG = "|kantasu-coi-1|";
    function coiAlreadyTried() {
        try { if (sessionStorage.getItem(COI_FLAG) === "1") return true; } catch (e) {}
        try { if (String(window.name).indexOf(COI_NAME_TAG) !== -1) return true; } catch (e) {}
        return false;
    }
    function coiMarkTried() {
        try { sessionStorage.setItem(COI_FLAG, "1"); } catch (e) {}
        try {
            var n = String(window.name || "");
            if (n.indexOf(COI_NAME_TAG) === -1) window.name = n + COI_NAME_TAG;
        } catch (e) {}
    }
    window.COI_RELOADING = false;
    if (!window.crossOriginIsolated && "serviceWorker" in navigator) {
        // No controller on this load + not attempted yet this session ->
        // registration + reload is unavoidable (barring registration failure,
        // which clears the flag below).
        if (!coiAlreadyTried() && !navigator.serviceWorker.controller) window.COI_RELOADING = true;
    }

    // Exposed so the page can await the isolation attempt before choosing
    // which emulator core build to load (threaded vs single-threaded).
    window.COI_DONE = (async () => {
        if (window.crossOriginIsolated) return "isolated"; // already isolated
        if (!("serviceWorker" in navigator)) return "no-sw";

        // One reload attempt per tab session (sessionStorage + window.name,
        // whichever works). If isolation still fails after the single retry
        // (e.g. a browser that rejects COEP), the site simply continues
        // single-threaded - never loops.
        if (coiAlreadyTried()) return "already-tried";
        coiMarkTried();

        try {
            await navigator.serviceWorker.register("coi-sw.js");
            if (window.crossOriginIsolated) { window.COI_RELOADING = false; return "isolated-late"; }
            // If this page is already controlled by the worker but STILL not
            // isolated, its navigation response went through a fallback path
            // without COI headers. One more reload may pick the header path
            // up; the marker above guarantees this can only happen once.
            if (!navigator.serviceWorker.controller) {
                await new Promise((resolve) => {
                    const done = () => { clearTimeout(timer); resolve(); };
                    const timer = setTimeout(done, 1500);
                    navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
                });
            }
            location.reload();
            // SAFETY NET: if the reload somehow fails to replace this
            // document, clear the gate flag so the page's boot logic is
            // allowed to run instead of waiting forever.
            setTimeout(() => { try { window.COI_RELOADING = false; } catch (e) {} }, 3000);
            return "reloading";
        } catch (err) {
            // Registration failed - no reload is coming, let the page boot.
            window.COI_RELOADING = false;
            console.warn("[coi-sw] registration failed (emulator stays single-threaded):", err);
            return "failed";
        }
    })();
}
