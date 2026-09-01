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
    // Exposed so the page can await the isolation attempt before choosing
    // which emulator core build to load (threaded vs single-threaded).
    window.COI_DONE = (async () => {
        if (window.crossOriginIsolated) return "isolated"; // already isolated
        if (!("serviceWorker" in navigator)) return "no-sw";

        // One reload attempt per tab session. The flag is written BEFORE any
        // async work so the updatefound/controllerchange races can never cause
        // a reload loop: even if events fire mid-registration, the next load
        // sees the flag and never reloads again. If isolation still fails
        // after the single retry (e.g. Safari without COEP support), the site
        // simply continues single-threaded - never loops.
        const FLAG = "coiReloadedBySelf";
        let reloaded = false;
        try { reloaded = sessionStorage.getItem(FLAG) === "1"; } catch (e) {}
        if (reloaded) return "already-tried";

        try { sessionStorage.setItem(FLAG, "1"); } catch (e) {}

        try {
            await navigator.serviceWorker.register("coi-sw.js");
            if (window.crossOriginIsolated) return "isolated-late";
            // Give a freshly-installed worker a moment to activate and claim
            // this page, then reload so the document is served through the
            // worker with COI headers.
            if (!navigator.serviceWorker.controller) {
                await new Promise((resolve) => {
                    const done = () => { clearTimeout(timer); resolve(); };
                    const timer = setTimeout(done, 1500);
                    navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
                });
            }
            location.reload();
            return "reloading";
        } catch (err) {
            console.warn("[coi-sw] registration failed (emulator stays single-threaded):", err);
            return "failed";
        }
    })();
}
