// ==UserScript==
// @name         Uber Fleet - Auto Grabber V3 (Monitor + Accept, exact fare)
// @namespace    http://tampermonkey.net/
// @version      3.5.2
// @description  Scans Trip Management, reads the Fare column exactly, filters by pickup date, auto-accepts trips inside the fare range, confirms only its own dialog, keeps the list fresh by tab toggling, keeps working in background tabs, logs every accept.
// @match        https://fleethub.uber.com/orgs/*/trip-reservation-offer*
// @match        https://supplier.uber.com/orgs/*/trip-reservation-offer*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // DEFAULT SETTINGS (all editable in the panel, saved in localStorage)
    // ================================================================
    const DEFAULTS = {
        MIN_FARE: 3000,            // accept if fare >= MIN_FARE
        MAX_FARE: 50000,           // and fare <= MAX_FARE
        AUTO_ACCEPT: true,         // false = alert only (behaves like V2)
        DRY_RUN: false,            // true = highlight + log + beep, but never click Accept (memory-only, does not mark trips handled).
        CITY_FILTER_ON: false,     // optional: only accept if pickup/stop city text matches
        CITY_LIST: 'Chennai',      // comma separated, case-insensitive substring match
        PICKUP_FILTER_ON: false,   // only accept if pickup date is inside the window below (IST)
        PICKUP_FROM: '',           // 'YYYY-MM-DD' (IST) or blank = no lower limit
        PICKUP_TO: '',             // 'YYYY-MM-DD' (IST) or blank = no upper limit
        SKIP_TODAY: false,         // quick switch: never accept pickups dated today (IST)
        SETTLE_MS: 400,            // table must be free of DOM changes this long before we click (prevents clicking stale rows mid-render)
        POST_REFRESH_MS: 800,      // after a tab toggle, wait this long before clicking anything
        DIRECT_MODE: true,         // talk to Uber's GraphQL API directly instead of clicking DOM buttons (much faster, no stale rows)
        DIRECT_POLL_MS: 400,       // how often to poll the offers queries in direct mode
        // Which offer lists to poll. ONLY Open holds acceptable offers.
        // Measured live 2026-09-18: 11 of 12 accepts sourced from Unassigned came back
        // "Offer is already accepted" - that list is trips the fleet ALREADY has, waiting on
        // a driver. Polling it just spams Uber with pointless accepts. Open only.
        DIRECT_SOURCES: 'GetOpenTripReservationOffers',
        SCAN_MS: 10,               // scan interval (ms). 10 = ~100 DOM scans/sec; CPU heavy but allowed
        REFRESH_MS: 150,           // tab toggle interval (ms). Warning: <1000 means many list fetches/sec; Uber may throttle ('Fetching unassigned offer failed')
        REFRESH_ON: false,         // OFF: each toggle fires ~7 GraphQL queries; sustained toggling got the session 403'd on 2026-09-18
        SOUND_ON: true,
        NOTIFY_ON: true,
        KEEPALIVE_ON: true,        // silent 20 Hz tone so the browser does not throttle this tab
        MAX_ACCEPTS_PER_MIN: 6,    // safety cap
        CONFIRM_WINDOW_MS: 5000,   // confirm dialog must appear within this window after our click
        HANDLED_TTL_MS: 6 * 3600 * 1000
    };

    const LS_SETTINGS = 'ufm3.settings';
    const LS_HANDLED = 'ufm3.handled';
    const LS_LOG = 'ufm3.log';
    const LS_DIAG = 'ufm3.diag';
    const LS_NET = 'ufm3.net';
    const LS_GQL = 'ufm3.gql';

    const SEL = {
        acceptBtn: 'button[data-testid="trip-reservation-table-action-button"]',
        dialog: '[role="dialog"], [role="alertdialog"], [data-baseweb="modal"], [aria-modal="true"], [data-baseweb="drawer"]',
        baseButton: 'button[data-baseweb="button"], button'
    };

    // ================================================================
    // STATE
    // ================================================================
    let S = loadSettings();
    S.SCAN_MS = Math.max(10, Number(S.SCAN_MS) || 10);
    S.REFRESH_MS = Math.max(100, Number(S.REFRESH_MS) || 150);
    let running = false;
    let worker = null;
    let pageTimer = null;
    let refreshTimer = null;
    let directTimer = null;
    let observer = null;
    let observerDebounce = null;
    let inFlight = null;                // { id, fare, startedAt }
    let acceptTimes = [];               // timestamps of accepts, for the per-minute cap
    let unhandledMatch = null;          // for alert-only / dry-run continuous beep
    let beepLoop = null;
    let audioCtx = null;
    let keepAliveNodes = null;
    let scanCount = 0;
    let handled = loadHandled();
    let dryHandled = new Set();          // dry-run / alert-only matches: memory only, never persisted
    let acceptLog = loadLog();
    let retryOnce = {};                  // key -> true once we have re-armed it after a 'please refresh' rejection
    let fareColIndexCache = new WeakMap();

    // ================================================================
    // STORAGE
    // ================================================================
    function loadSettings() {
        try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); }
        catch { return Object.assign({}, DEFAULTS); }
    }
    function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S)); } catch {} }
    function loadHandled() {
        try {
            const m = JSON.parse(localStorage.getItem(LS_HANDLED) || '{}');
            const now = Date.now();
            Object.keys(m).forEach(k => { if (now - m[k] > S.HANDLED_TTL_MS) delete m[k]; });
            return m;
        } catch { return {}; }
    }
    function saveHandled() { try { localStorage.setItem(LS_HANDLED, JSON.stringify(handled)); } catch {} }
    function loadLog() { try { return JSON.parse(localStorage.getItem(LS_LOG) || '[]'); } catch { return []; } }
    function saveLog() { try { localStorage.setItem(LS_LOG, JSON.stringify(acceptLog.slice(-500))); } catch {} }

    // ================================================================
    // UTIL
    // ================================================================
    const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
    }
    function fireClick(el) {
        if (!el) return;
        try { el.click(); } catch {}
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch {}
        });
    }
    function log(msg) { console.log('[UFM3] ' + msg); }

    // ================================================================
    // FARE: exact parse from the Fare column
    // ================================================================
    function parseRupee(text) {
        text = clean(text);
        let m = text.match(/₹\s*([\d,]+(?:\.\d+)?)/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
        m = text.match(/(?:INR|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
        return null;
    }

    function fareColumnIndex(table) {
        if (!table) return -1;
        if (fareColIndexCache.has(table)) return fareColIndexCache.get(table);
        let idx = -1;
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th');
        headerCells.forEach((c, i) => { if (idx < 0 && /^fare$/i.test(clean(c.textContent))) idx = i; });
        fareColIndexCache.set(table, idx);
        return idx;
    }

    function rowFare(row) {
        let cells = row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]');
        if (!cells.length) cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
        const table = row.closest('table');
        const idx = fareColumnIndex(table);
        if (idx >= 0 && cells[idx]) {
            const v = parseRupee(cells[idx].textContent);
            if (v !== null) return v;
        }
        // fallback: first cell that contains a rupee amount (never the whole-row max)
        for (const c of cells) {
            const v = parseRupee(c.textContent);
            if (v !== null) return v;
        }
        return null;
    }

    function findRowById(id) {
        const btns = document.querySelectorAll(SEL.acceptBtn);
        for (const b of btns) {
            const row = b.closest('tr') || b.closest('[role="row"]') || b.parentElement;
            if (row && rowTripId(row) === id) return row;
        }
        return null;
    }

    function pageMessages() {
        // toasts / alerts / dialogs visible right now, for diagnostics
        const out = [];
        document.querySelectorAll('[role="alert"], [role="status"], [data-baseweb="toast"], [data-baseweb="snackbar"], [role="dialog"], [data-baseweb="modal"], [aria-modal="true"], [data-baseweb="drawer"], div[class*="toast" i], div[class*="snack" i]').forEach(el => {
            if (el.closest('#ufm3-panel') || el.closest('#ufm3-popup')) return;
            if (!isVisible(el)) return;
            const t = clean(el.textContent).slice(0, 160);
            if (t) out.push(t);
        });
        // text sweep for Uber's known messages even if the container has no role. NEVER read our own panel/popup.
        const body = clean(Array.from(document.body.children)
            .filter(el => el.id !== 'ufm3-panel' && el.id !== 'ufm3-popup' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE')
            .map(el => el.innerText || '').join(' '));
        const known = body.match(/(fetching unassigned offer failed[^.]{0,40}|trip acceptance failed[^.]{0,40}|please refresh|no longer available|already (?:been )?accepted|something went wrong|trip (?:was )?not available|offer (?:has )?expired)/i);
        if (known && !out.some(x => x.toLowerCase().includes(known[0].toLowerCase()))) out.push('TEXT: ' + known[0]);
        return out;
    }

    function closeToasts() {
        document.querySelectorAll('[role="alert"], [data-baseweb="toast"], div[class*="toast" i]').forEach(t => {
            if (t.closest('#ufm3-panel') || !isVisible(t)) return;
            const b = Array.from(t.querySelectorAll('button')).find(x => /^(close|dismiss|×|x)$/i.test(clean(x.textContent)) || /close/i.test(x.getAttribute('aria-label') || ''));
            if (b) fireClick(b);
        });
    }

    // ---------- accept-response classifier (Uber's API is the source of truth) ----------
    // ok              : accepted, it is ours
    // taken           : someone else got there first
    // alreadyAccepted : offer already in accepted state - ambiguous, check the Accepted tab
    function classifyAcceptResponse(json, status) {
        try {
            // An HTTP error body (e.g. the 403 {"message":"forbidden by authentication server"})
            // is a valid object with no .errors array. Without this check it read as ACCEPTED.
            if (status !== undefined && status !== null && (status < 200 || status >= 300)) {
                return { kind: 'error', label: 'HTTP ' + status + ' - NOT accepted' };
            }
            if (!json || typeof json !== 'object') return { kind: 'error', label: 'invalid accept response' };
            const errs = json.errors;
            if (!errs || !errs.length) {
                // success must be proven, never assumed from "no errors"
                const data = json.data;
                if (data && typeof data === 'object' && Object.keys(data).length &&
                    Object.keys(data).some(k => data[k] !== null && data[k] !== undefined)) {
                    return { kind: 'ok', label: 'ACCEPTED' };
                }
                return { kind: 'error', label: 'no accept confirmation in response' };
            }
            const msg = String(errs[0].message || '');
            if (/already[- ]?exists|already\s+accepted/i.test(msg)) {
                return { kind: 'alreadyAccepted', label: 'ALREADY ACCEPTED (verify in Accepted tab)', msg };
            }
            if (/no longer available|not available|expired|non-actionable/i.test(msg)) {
                return { kind: 'taken', label: 'TAKEN by someone else', msg };
            }
            return { kind: 'error', label: 'API error: ' + msg.slice(0, 80), msg };
        } catch (e) { return { kind: 'error', label: 'unparsable accept response' }; }
    }

    // ---------- network recorder: Uber's own API calls for offers / accept ----------
    // Capture every request; only drop known high-volume noise. Uber uses RELATIVE urls,
    // so a hostname-based match misses the real calls (this is why /flipr was all we ever saw).
    const NET_SKIP = /\/flipr|\.(js|css|png|jpe?g|svg|gif|woff2?|ico|map)(\?|$)|analytics|metrics|beacon|sentry|datadog|segment/i;
    function netSave(entry) {
        try {
            const all = JSON.parse(localStorage.getItem(LS_NET) || '[]'); all.push(entry);
            localStorage.setItem(LS_NET, JSON.stringify(all.slice(-250)));
        } catch {}
        if (inFlight && inFlight.diag) inFlight.diag.events.push({ t: Date.now() - inFlight.startedAt, net: entry });
        try {
            if (/AcceptOpenTripOffer/.test(entry.reqBody || '')) {
                const uu = acceptUuidFromBody(entry.reqBody);
                // Any accept we observe - ours, or the operator clicking in the Uber UI -
                // retires that offer for BOTH paths, so they can never double-accept it.
                if (uu) { handled[uu] = Date.now(); saveHandled(); }
                if (inFlight) {
                    if (uu && !inFlight.acceptUuid) inFlight.acceptUuid = uu;
                    inFlight.acceptSeen = true;
                    const started = Date.parse(entry.time) - (entry.ms || 0);
                    const mine = !inFlight.acceptUuid || !uu || uu === inFlight.acceptUuid;
                    if (!inFlight.apiResult && entry.resBody && mine && started >= inFlight.startedAt - 250) {
                        let parsed = null; try { parsed = JSON.parse(entry.resBody); } catch {}
                        inFlight.apiResult = classifyAcceptResponse(parsed, entry.status);
                        log('accept API says: ' + inFlight.apiResult.label);
                    }
                }
            }
        } catch {}
    }
    function acceptUuidFromBody(body) {
        try {
            const j = JSON.parse(body);
            const v = j && j.variables && j.variables.offerUuid;
            return (v && (typeof v === 'string' ? v : v.value)) || null;
        } catch { return null; }
    }

    // ---------- direct GraphQL engine ----------
    let GQL = (function () { try { return JSON.parse(localStorage.getItem(LS_GQL) || '{}'); } catch { return {}; } })();
    function saveGql() { try { localStorage.setItem(LS_GQL, JSON.stringify(GQL)); } catch {} }
    function learnGql(url, headers, body) {
        if (!/graphql/i.test(url) || typeof body !== 'string') return;
        let j; try { j = JSON.parse(body); } catch { return; }
        const op = String(j.operationName || '');
        // Learn EVERY offer-list query, not just one. 2026-09-18: only
        // GetInProgressTripReservationOffers was learned, which lists trips already running
        // (2 rows) while the acceptable requests live in Open/Unassigned (8 and 19 rows),
        // so direct mode polled the wrong list and never accepted anything.
        if (/^Get\w*TripReservationOffers$/i.test(op)) {
            GQL.url = url;
            GQL.offerQueries = GQL.offerQueries || {};
            GQL.offerQueries[op] = body;
            if (headers) GQL.headers = headers;
            saveGql();
        } else if (/AcceptOpenTripOffer/i.test(op)) {
            GQL.url = url; GQL.acceptBody = body; if (headers) GQL.headers = headers; saveGql();
        }
    }
    // the lists worth polling for acceptable offers, best first
    function offerSources() {
        const want = String(S.DIRECT_SOURCES || '').split(',').map(x => x.trim()).filter(Boolean);
        const have = GQL.offerQueries || {};
        return want.filter(nm => have[nm]).map(nm => ({ name: nm, body: have[nm] }));
    }
    function gqlReady() { return !!(GQL.url && GQL.acceptBody && offerSources().length); }

    function installNetRecorder() {
        if (window.__ufm3NetInstalled) return; window.__ufm3NetInstalled = true;
        const origFetch = window.fetch;
        window.__ufm3OrigFetch = origFetch;
        window.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            const started = Date.now();
            let body = null; try { body = init && typeof init.body === 'string' ? init.body.slice(0, 4000) : null; } catch {}
            let hdrs = null;
            try { if (init && init.headers) { hdrs = {}; new Headers(init.headers).forEach((v, k) => { hdrs[k] = v; }); } } catch {}
            try { learnGql(url, hdrs, body); } catch {}
            const res = await origFetch.apply(this, arguments);
            try { if (!NET_SKIP.test(url)) noteHttpStatus(res.status, url); } catch {}
            if (!NET_SKIP.test(url)) {
                let text = null;
                try { text = (await res.clone().text()).slice(0, 3000); } catch {}
                netSave({ time: new Date().toISOString(), via: 'fetch', method, url: url.slice(0, 300), status: res.status, ms: Date.now() - started, reqBody: body, resBody: text });
            }
            return res;
        };
        const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (m, u) { this.__ufm = { method: m, url: String(u), started: 0, headers: {} }; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (this.__ufm) this.__ufm.headers[String(k).toLowerCase()] = String(v); } catch {} return origSetHeader.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (b) {
            const meta = this.__ufm;
            try { if (meta) learnGql(meta.url, meta.headers, typeof b === 'string' ? b : null); } catch {}
            if (meta && !NET_SKIP.test(meta.url)) {
                meta.started = Date.now(); meta.reqBody = typeof b === 'string' ? b.slice(0, 4000) : null;
                this.addEventListener('loadend', () => {
                    try { noteHttpStatus(this.status, meta.url); } catch {}
                    let text = null; try { text = String(this.responseText || '').slice(0, 3000); } catch {}
                    netSave({ time: new Date().toISOString(), via: 'xhr', method: meta.method, url: meta.url.slice(0, 300), status: this.status, ms: Date.now() - meta.started, reqBody: meta.reqBody, resBody: text });
                });
            }
            return origSend.apply(this, arguments);
        };
        log('network recorder installed');
    }
    function exportNet() {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([localStorage.getItem(LS_NET) || '[]'], { type: 'application/json' }));
        a.download = 'uber-grabber-net.json'; a.click();
    }

    async function gqlPost(body, timeoutMs) {
        const f = window.__ufm3OrigFetch || window.fetch;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs || 8000) : null;
        try {
            const opts = {
                method: 'POST', credentials: 'include',
                headers: Object.assign({ 'content-type': 'application/json' }, GQL.headers || {}),
                body
            };
            if (ctrl) opts.signal = ctrl.signal;
            const res = await f.call(window, GQL.url, opts);
            // direct-mode traffic bypasses the wrapped fetch, so arm the breaker here
            try { noteHttpStatus(res.status, GQL.url); } catch {}
            let json = null; try { json = await res.json(); } catch {}
            return { status: res.status, ok: res.ok, json };
        } finally { if (timer) clearTimeout(timer); }
    }

    // find the array of offers anywhere in the response
    function extractOffers(obj, out) {
        out = out || [];
        if (!obj || typeof obj !== 'object') return out;
        if (Array.isArray(obj)) { obj.forEach(x => extractOffers(x, out)); return out; }
        if (obj.uuid && obj.fareDetails) out.push(obj);
        Object.keys(obj).forEach(k => { const v = obj[k]; if (v && typeof v === 'object') extractOffers(v, out); });
        return out;
    }
    function offerUuid(o) { return typeof o.uuid === 'string' ? o.uuid : (o.uuid && o.uuid.value) || null; }
    function offerFare(o) { try { return parseRupee(o.fareDetails.displayFare); } catch { return null; } }
    function offerPickupMs(o) {
        const seen = [];
        (function walk(x) {
            if (!x || typeof x !== 'object') return;
            Object.keys(x).forEach(k => {
                const v = x[k];
                if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && /pickup|start|begin|scheduled/i.test(k)) seen.push(Date.parse(v));
                else if ((typeof v === 'number' || (typeof v === 'string' && /^\d{10,13}$/.test(v))) && /pickup|start|begin|scheduled/i.test(k)) {
                    const num = Number(v); const ms = num > 1e12 ? num : num * 1000;
                    const now = Date.now();
                    if (ms > now - 86400000 * 30 && ms < now + 86400000 * 400) seen.push(ms);   // reject nonsense epochs
                } else if (v && typeof v === 'object') walk(v);
            });
        })(o);
        const valid = seen.filter(x => Number.isFinite(x));
        return valid.length ? Math.min.apply(null, valid) : null;
    }
    function offerMatches(o) {
        const fare = offerFare(o);
        if (fare === null || fare < S.MIN_FARE || fare > S.MAX_FARE) return false;
        const blob = JSON.stringify(o).toLowerCase();
        if (S.CITY_FILTER_ON) {
            const list = S.CITY_LIST.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
            if (list.length && !list.some(c => blob.includes(c))) return false;
        }
        if (S.SKIP_TODAY || S.PICKUP_FILTER_ON) {
            const ms = offerPickupMs(o);
            if (ms === null) return false;              // fail CLOSED: never accept when the date filter cannot be evaluated
            if (ms !== null) {
                const day = istDateString(ms);
                if (S.SKIP_TODAY && day === istDateString(Date.now())) return false;
                if (S.PICKUP_FILTER_ON) {
                    if (S.PICKUP_FROM && day < S.PICKUP_FROM) return false;
                    if (S.PICKUP_TO && day > S.PICKUP_TO) return false;
                }
            }
        }
        return true;
    }

    // ---------- auth circuit breaker ----------
    // 2026-09-18: Uber began returning 403 {"message":"forbidden by authentication server"} on
    // every query including the page's own. Hammering a blocked session makes it worse, so stop dead.
    let authBlocked = false, authFailCount = 0, lastAuthFail = 0;
    function noteHttpStatus(status, url) {
        if (status === 403 || status === 401) {
            authFailCount++; lastAuthFail = Date.now();
            if (!authBlocked && authFailCount >= 3) {
                authBlocked = true;
                log('AUTH BLOCKED: ' + status + ' from ' + String(url).slice(0, 60) + ' — stopping all activity');
                addLog({ id: '-', fare: 0, result: 'AUTH BLOCKED (' + status + ') — session rejected, re-login required' });
                stop();
                startBeepLoop();
                status_('SESSION BLOCKED by Uber (HTTP ' + status + '). Log out, log back in, then press START.');
            }
        } else if (status >= 200 && status < 300) {
            if (Date.now() - lastAuthFail > 30000) authFailCount = 0;   // healthy again
        }
    }
    function status_(m) { const el = document.getElementById('ufm3-status'); if (el) el.innerHTML = '<b style="color:#ff6b6b">' + m + '</b>'; }

    let directBusy = false, directPolls = 0, directSeen = 0, lastPollOkAt = 0, lastDomAcceptAt = 0;
    async function directTick() {
        if (authBlocked) return;
        if (!running || !S.DIRECT_MODE || directBusy || !gqlReady()) return;
        if (inFlight || Date.now() - lastDomAcceptAt < 15000) return;   // a DOM accept is outstanding
        directBusy = true;
        try {
            // poll every configured list, newest-first, and merge them by uuid
            const offers = []; const byUuid = new Set(); let anyOk = false;
            for (const src of offerSources()) {
                const pj = await gqlPost(src.body, 5000);
                if (!running || authBlocked || !S.DIRECT_MODE) return;  // state may have changed across the await
                if (!pj.ok) { log('offers poll ' + src.name + ' HTTP ' + pj.status); continue; }
                anyOk = true;
                for (const o of extractOffers(pj.json)) {
                    const u = offerUuid(o);
                    if (!u || byUuid.has(u)) continue;
                    byUuid.add(u); o.__src = src.name; offers.push(o);
                }
            }
            if (!anyOk) return;
            lastPollOkAt = Date.now();
            directPolls++; directSeen = offers.length;
            for (const o of offers) {
                const uu = offerUuid(o); if (!uu) continue;
                const fare = offerFare(o);
                const key = uu;
                if (handled[key] || dryHandled.has(key)) continue;
                if (!offerMatches(o)) continue;

                // alert-only mode must NEVER book a trip through the direct path
                if (S.DRY_RUN || !S.AUTO_ACCEPT) {
                    dryHandled.add(key);
                    addLog({ id: uu.slice(0, 8), fare, result: S.DRY_RUN ? 'DRY RUN match (direct)' : 'ALERT - manual accept needed (direct)' });
                    notify({ fare, id: uu.slice(0, 8) }, 'Trip match');
                    startBeepLoop();
                    break;
                }

                const now = Date.now();
                acceptTimes = acceptTimes.filter(t => now - t < 60000);
                if (acceptTimes.length >= S.MAX_ACCEPTS_PER_MIN) { status('Accept cap reached this minute'); break; }

                const t0 = Date.now();
                let body; try { const b = JSON.parse(GQL.acceptBody); b.variables.offerUuid = { value: uu }; body = JSON.stringify(b); }
                catch (e) { log('accept template broken: ' + e); break; }
                if (!running || authBlocked) break;                     // re-check right before we spend money
                acceptTimes.push(now);
                handled[key] = now; saveHandled();                      // reserve, then confirm or release below
                let cls, ms;
                try {
                    const r = await gqlPost(body, 8000);
                    ms = Date.now() - t0;
                    cls = classifyAcceptResponse(r.json, r.status);
                } catch (e) {
                    // no verdict: release the reservation so the offer is retried instead of silently burned
                    delete handled[key]; saveHandled();
                    addLog({ id: uu.slice(0, 8), fare, result: 'ACCEPT FAILED (no verdict): ' + String(e).slice(0, 60) + ' - re-armed' });
                    tone(440, 0.3, 0.3);
                    break;
                }
                addLog({ id: uu.slice(0, 8), fare, result: cls.label + ' (direct via ' + String(o.__src || '?').replace(/^Get|TripReservationOffers$/g, '') + ', ' + ms + 'ms)' });
                if (cls.kind === 'ok' || cls.kind === 'alreadyAccepted') {
                    playAcceptTone(); notify({ fare, id: uu.slice(0, 8) }, cls.kind === 'ok' ? 'Accepted' : 'Already accepted');
                } else {
                    if (cls.kind === 'error') { delete handled[key]; saveHandled(); }   // transient: allow a retry
                    tone(440, 0.3, 0.3);
                }
                break;   // one at a time
            }
        } catch (e) { log('direct poll error: ' + e); }
        finally { directBusy = false; }
    }

    // ---------- diagnostics recorder: what changed on the page after our click ----------
    function visibleButtonTexts() {
        const set = new Set();
        document.querySelectorAll('button, [role="button"], [role="menuitem"], a').forEach(b => {
            if (b.closest('#ufm3-panel') || b.closest('#ufm3-popup')) return;
            if (isVisible(b)) { const t = clean(b.textContent).slice(0, 40); if (t) set.add(t); }
        });
        return set;
    }
    function diagStart(m) {
        const btn = m.btn;
        return {
            time: new Date().toISOString(), id: m.id, fare: m.fare,
            button: (btn.outerHTML || '').slice(0, 400),
            rowCells: Array.from(m.row.querySelectorAll(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]')).map(c => clean(c.textContent).slice(0, 60)),
            before: Array.from(visibleButtonTexts()),
            events: []
        };
    }
    function diagTick(f) {
        if (!f.diag) return;
        const now = visibleButtonTexts();
        const appeared = Array.from(now).filter(t => !f.diag.beforeSet.has(t));
        const gone = f.diag.before.filter(t => !now.has(t));
        const msgs = pageMessages();
        const roles = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-baseweb="modal"], [data-baseweb="popover"], [data-baseweb="menu"], [data-baseweb="drawer"]')).filter(isVisible).map(e => (e.getAttribute('data-baseweb') || e.getAttribute('role')) + ':' + clean(e.textContent).slice(0, 80));
        const sig = JSON.stringify([appeared, gone, msgs, roles]);
        if (sig !== f.diag.lastSig) { f.diag.lastSig = sig; f.diag.events.push({ t: Date.now() - f.startedAt, appeared, gone, msgs, roles, url: location.pathname }); }
    }
    function diagSave(f, result) {
        if (!f.diag) return;
        f.diag.result = result;
        try {
            const all = JSON.parse(localStorage.getItem(LS_DIAG) || '[]'); all.push(f.diag);
            localStorage.setItem(LS_DIAG, JSON.stringify(all.slice(-20)));
        } catch {}
    }
    function exportDiag() {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([localStorage.getItem(LS_DIAG) || '[]'], { type: 'application/json' }));
        a.download = 'uber-grabber-diag.json'; a.click();
    }

    // ---------- pickup time (IST) ----------
    const MONTHS = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
    function parsePickup(text) {
        // "Thursday, September 17, 2026, 7:00:00 AM GMT+5:30"  -> epoch ms
        const m = clean(text).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*GMT([+-]\d{1,2}):?(\d{2})?)?/i);
        if (!m) return null;
        const mon = MONTHS[m[1].toLowerCase()]; if (mon === undefined) return null;
        let h = Number(m[4]); const mi = Number(m[5]), sec = Number(m[6] || 0);
        if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
        const offMin = m[8] !== undefined ? (Number(m[8]) * 60 + (Number(m[8]) < 0 ? -1 : 1) * Number(m[9] || 0)) : 330;
        return Date.UTC(Number(m[3]), mon, Number(m[2]), h, mi, sec) - offMin * 60000;
    }
    function istDateString(ms) {          // YYYY-MM-DD in IST
        const d = new Date(ms + 330 * 60000);
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    function pickupColumnIndex(table) {
        if (!table) return -1;
        const cells = table.querySelectorAll('thead th, thead td, tr:first-child th');
        let idx = -1; cells.forEach((c, i) => { if (idx < 0 && /pickup\s*time/i.test(clean(c.textContent))) idx = i; });
        return idx;
    }
    function rowPickup(row) {
        let cells = row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]');
        if (!cells.length) cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
        const idx = pickupColumnIndex(row.closest('table'));
        if (idx >= 0 && cells[idx]) { const v = parsePickup(cells[idx].textContent); if (v !== null) return v; }
        for (const c of cells) { const v = parsePickup(c.textContent); if (v !== null) return v; }   // first date-looking cell = pickup (submitted time comes later)
        return null;
    }
    function pickupOk(row) {
        if (!S.PICKUP_FILTER_ON && !S.SKIP_TODAY) return true;
        const ms = rowPickup(row);
        if (ms === null) return true;                     // cannot read it: do not block on this filter
        const day = istDateString(ms);
        if (S.SKIP_TODAY && day === istDateString(Date.now())) return false;
        if (S.PICKUP_FILTER_ON) {
            if (S.PICKUP_FROM && day < S.PICKUP_FROM) return false;
            if (S.PICKUP_TO && day > S.PICKUP_TO) return false;
        }
        return true;
    }

    // ---------- freshness guards ----------
    let lastDomChange = 0;          // last time the results table changed
    let lastRefreshAt = 0;          // last time we toggled tabs

    function requestsCount() {
        const els = document.querySelectorAll('button, [role="tab"], a, span, div');
        for (const el of els) {
            if (el.closest('#ufm3-panel')) continue;
            const t = clean(el.textContent);
            if (t.length > 30) continue;
            const m = t.match(/Requests\((\d+)\)/);
            if (m) return Number(m[1]);
        }
        return null;
    }

    // true when the table is settled and the tab counter agrees there are live offers
    function listIsFresh() {
        const n = requestsCount();
        if (n === 0) return false;                                   // counter says nothing is on offer: rows on screen are ghosts
        if (Date.now() - lastRefreshAt < S.POST_REFRESH_MS) return false;
        if (lastDomChange && Date.now() - lastDomChange < S.SETTLE_MS) return false;
        return true;
    }

    function rowTripId(row) {
        const first = row.querySelector('td, [role="cell"], [role="gridcell"]');
        const id = clean(first ? first.textContent : '');
        return id || clean(row.textContent).slice(0, 60);
    }

    function cityOk(row) {
        if (!S.CITY_FILTER_ON) return true;
        const list = S.CITY_LIST.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (!list.length) return true;
        const text = clean(row.textContent).toLowerCase();
        return list.some(c => text.includes(c));
    }

    // ================================================================
    // FIND CANDIDATE ROWS
    // ================================================================
    function candidateRows() {
        const out = [];
        document.querySelectorAll(SEL.acceptBtn + ', button').forEach(btn => {
            if (!isVisible(btn)) return;
            if (btn.closest('#ufm3-panel')) return;
            if (!/^accept$/i.test(clean(btn.textContent))) return;   // never "Assign driver" / "View"
            if (!btn.closest('tr, [role="row"]')) return;
            const row = btn.closest('tr') || btn.closest('[role="row"]') || btn.parentElement;
            if (!row) return;
            out.push({ row, btn });
        });
        return out;
    }

    // ================================================================
    // SCAN
    // ================================================================
    let lastSeen = 0;
    function findMatch() {
        const cands = candidateRows();
        lastSeen = cands.length;
        for (const { row, btn } of cands) {
            const fare = rowFare(row);
            if (fare === null) continue;
            const id = rowTripId(row);
            const key = id + '|' + fare;
            if (handled[key] || dryHandled.has(key)) continue;
            if (fare < S.MIN_FARE || fare > S.MAX_FARE) continue;
            if (!cityOk(row)) continue;
            if (!pickupOk(row)) continue;
            return { row, btn, fare, id, key };
        }
        return null;
    }

    let skippedStale = 0;
    function scan() {
        if (!running || authBlocked) return;
        scanCount++;
        if (inFlight) { checkInFlight(); return; }

        if (S.DIRECT_MODE && gqlReady()) return;                     // direct API is handling accepts; do not also click the DOM
        if (!listIsFresh()) {                                        // table mid-render or counter at 0: never click a ghost row
            if (findMatch()) skippedStale++;
            return;
        }

        const matched = findMatch();
        const seen = lastSeen;

        if (matched) {
            highlight(matched.row);
            if (S.AUTO_ACCEPT && !S.DRY_RUN) {
                accept(matched);
            } else {
                if (!unhandledMatch || unhandledMatch.key !== matched.key) {
                    unhandledMatch = matched;
                    dryHandled.add(matched.key);
                    addLog({ id: matched.id, fare: matched.fare, result: S.DRY_RUN ? 'DRY RUN match' : 'ALERT (manual accept)' });
                    notify(matched);
                    startBeepLoop();
                    showPopup(matched);
                }
            }
        } else {
            if (scanCount % 20 === 0) status(`Scanning… rows: ${seen} · range ₹${S.MIN_FARE}–₹${S.MAX_FARE}${S.DRY_RUN ? ' · DRY RUN' : ''}${S.SKIP_TODAY ? ' · skip today' : ''}${S.PICKUP_FILTER_ON ? ' · pickup ' + (S.PICKUP_FROM || '…') + '→' + (S.PICKUP_TO || '…') : ''}<br>${S.DIRECT_MODE ? (gqlReady() ? `DIRECT API · polls: ${directPolls} · offers: ${directSeen} · lists: ${offerSources().map(x => x.name.replace(/^Get|TripReservationOffers$/g, '')).join('+') || 'none'}` : 'DIRECT API armed · lists learned: ' + Object.keys(GQL.offerQueries || {}).length + (GQL.acceptBody ? '' : ' · needs 1 normal accept to learn the mutation')) : `scans: ${scanCount} · refreshes: ${refreshCount} · held(stale): ${skippedStale}`}`);
        }
    }

    // ================================================================
    // ACCEPT FLOW
    // ================================================================
    function accept(m) {
        const now = Date.now();
        acceptTimes = acceptTimes.filter(t => now - t < 60000);
        if (acceptTimes.length >= S.MAX_ACCEPTS_PER_MIN) { status('Accept cap reached this minute, waiting…'); return; }

        handled[m.key] = now; saveHandled();
        inFlight = { id: m.id, fare: m.fare, startedAt: now, row: m.row, btn: m.btn, confirmed: false, retried: false, baseline: new Set(pageMessages()), lastCheck: 0 };
        inFlight.diag = diagStart(m); inFlight.diag.beforeSet = new Set(inFlight.diag.before);
        acceptTimes.push(now);
        lastDomAcceptAt = Date.now();
        status(`Accepting ₹${m.fare.toLocaleString('en-IN')} (${m.id})…`);
        log(`ACCEPT click ₹${m.fare} ${m.id}`);
        requestAnimationFrame(() => fireClick(m.btn));
    }

    function checkInFlight() {
        const f = inFlight;
        const elapsed = Date.now() - f.startedAt;
        if (Date.now() - f.lastCheck < 100) return;
        f.lastCheck = Date.now();
        diagTick(f);

        // NO retry click. Measured 2026-09-18: the old 1.5 s retry fired a SECOND
        // AcceptOpenTripOffer; Uber answered "Offer is already accepted" (already-exists)
        // and a trip we had actually won was logged as a loss.

        // Uber's answer to our accept call is authoritative - stop guessing from toasts.
        if (f.apiResult) {
            const r = f.apiResult;
            finishInFlight(r.kind === 'ok' ? 'ACCEPTED' : r.label);
            return;
        }

        // 1) confirm dialog that appeared AFTER our click, inside a modal only
        if (!f.confirmed && elapsed <= S.CONFIRM_WINDOW_MS) {
            const dialogs = document.querySelectorAll(SEL.dialog);
            for (const d of dialogs) {
                if (!isVisible(d)) continue;
                const btns = d.querySelectorAll(SEL.baseButton);
                for (const b of btns) {
                    const t = clean(b.textContent).toLowerCase();
                    if (isVisible(b) && /^(confirm|submit|apply|yes|accept|ok|accept trip|yes, accept|confirm accept)$/.test(t)) {
                        f.confirmed = true;
                        log('CONFIRM click');
                        fireClick(b);
                        return;
                    }
                }
            }
        }

        // 2) judge by re-finding the row by trip id (React re-renders replace the nodes)
        const liveRow = findRowById(f.id);
        const msgs = pageMessages().filter(x => !f.baseline.has(x));   // only messages that appeared AFTER our click
        if (msgs.length) f.lastMsg = msgs.join(' | ');

        // A row also disappears when SOMEONE ELSE takes the trip, so a vanished row is not
        // proof of a win. Check the loss evidence first, and never report ACCEPTED from the DOM.
        if (!liveRow && elapsed > 800) {
            if (/no longer available|already accepted|trip acceptance failed/i.test(f.lastMsg || '')) {
                finishInFlight('TAKEN by someone else');
            } else if (f.acceptSeen) {
                finishInFlight('SENT, awaiting verdict - verify in Accepted tab');
            } else {
                finishInFlight('UNKNOWN (row gone, no accept seen) - verify in Accepted tab');
            }
            return;
        }
        // scoped to ACCEPT wording: the bare /failed/ used to match the unrelated
        // "Fetching unassigned offer failed" list error and abort a live accept
        if (/trip acceptance failed|no longer available|already (been )?accepted|offer (is )?not available|unavailable|expired/i.test(f.lastMsg || '')) {
            finishInFlight('LOST: ' + f.lastMsg.slice(0, 90));
            setTimeout(closeToasts, 200);
            if (/please refresh|failed/i.test(f.lastMsg)) {
                refreshPhase = 0; setTimeout(() => forceRefresh(), 300);
                const key = f.id + '|' + f.fare;
                if (!retryOnce[key]) { retryOnce[key] = true; setTimeout(() => {
                    delete handled[key]; saveHandled();
                    const present = !!findRowById(f.id);
                    log('re-armed ' + key + ' after refresh; row present=' + present);
                    addLog({ id: f.id, fare: f.fare, result: present ? 'RETRY armed (row still listed)' : 'GONE after refresh (taken by someone else)' });
                }, 2500); }
            }
            return;
        }
        if (elapsed > S.CONFIRM_WINDOW_MS + 4000) {
            finishInFlight('TIMEOUT' + (f.confirmed ? ' after confirm' : ' no confirm dialog seen') + (f.lastMsg ? ': ' + f.lastMsg.slice(0, 90) : ''));
        }
    }

    function forceRefresh() {
        lastRefreshAt = Date.now();
        const a = findByText('Announcements'); if (a) fireClick(a);
        setTimeout(() => { const t = findByText('Trip Management'); if (t) fireClick(t); }, 700);
        setTimeout(() => { const req = findByTextPrefix('Requests'); if (req && req.getAttribute('aria-selected') !== 'true') fireClick(req); }, 1400);
    }

    function finishInFlight(result) {
        const f = inFlight; inFlight = null;
        diagSave(f, result);
        addLog({ id: f.id, fare: f.fare, result });
        if (result === 'ACCEPTED') { playAcceptTone(); notify({ fare: f.fare, id: f.id }, 'Accepted'); }
        else if (result.startsWith('ALREADY ACCEPTED')) { playAcceptTone(); notify({ fare: f.fare, id: f.id }, 'Already accepted'); }
        else if (result.startsWith('LOST') || result.startsWith('TAKEN')) { tone(440, 0.3, 0.3); }
        else { startBeepLoop(); unhandledMatch = { key: f.id, fare: f.fare, id: f.id }; }
        status(`${result}: ₹${f.fare.toLocaleString('en-IN')} (${f.id})`);
    }

    // ================================================================
    // LIST REFRESH (tab toggle, the method that works on this portal)
    // ================================================================
    let refreshPhase = 0;
    let lastToggle = 0;
    let refreshCount = 0;
    function findByText(text) {
        const els = document.querySelectorAll('a, button, div, span, p, li, [role="tab"]');
        for (const el of els) {
            if (el.closest('#ufm3-panel')) continue;
            if (clean(el.textContent) === text && isVisible(el)) return el;
        }
        return null;
    }
    function findByTextPrefix(prefix) {
        const els = document.querySelectorAll('a, button, div, span, [role="tab"]');
        for (const el of els) {
            if (el.closest('#ufm3-panel')) continue;
            if (clean(el.textContent).startsWith(prefix) && isVisible(el) && clean(el.textContent).length < prefix.length + 8) return el;
        }
        return null;
    }
    function refreshTick() {
        if (!running || !S.REFRESH_ON || authBlocked) return;
        if (inFlight) return;
        if (Date.now() - lastToggle < S.REFRESH_MS) return;
        lastToggle = Date.now(); lastRefreshAt = Date.now();
        if (findMatch()) return;                        // hold only while a MATCHING trip is on screen
        if (refreshPhase === 0) {
            const a = findByText('Announcements');
            if (a) { fireClick(a); refreshPhase = 1; refreshCount++; }
        } else {
            const t = findByText('Trip Management');
            if (t) fireClick(t);
            refreshPhase = 0;
            setTimeout(() => {
                const req = findByTextPrefix('Requests');
                if (req && req.getAttribute('aria-selected') !== 'true') fireClick(req);
            }, 600);
        }
    }

    // ================================================================
    // BACKGROUND-SAFE TIMERS
    // ================================================================
    function startTimers() {
        stopTimers();
        try {
            const src = `let t=null;onmessage=e=>{if(e.data.cmd==='start'){clearInterval(t);t=setInterval(()=>postMessage('tick'),e.data.ms)}if(e.data.cmd==='stop'){clearInterval(t)}}`;
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
            worker.onmessage = () => scan();
            worker.postMessage({ cmd: 'start', ms: S.SCAN_MS });
        } catch (e) {
            log('Worker unavailable, using page timer: ' + e);
        }
        pageTimer = setInterval(scan, Math.max(S.SCAN_MS, 1000));   // backup
        refreshTimer = setInterval(refreshTick, S.REFRESH_MS);
        directTimer = setInterval(directTick, S.DIRECT_POLL_MS);
    }
    function stopTimers() {
        if (worker) { try { worker.postMessage({ cmd: 'stop' }); worker.terminate(); } catch {} worker = null; }
        if (pageTimer) { clearInterval(pageTimer); pageTimer = null; }
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        if (directTimer) { clearInterval(directTimer); directTimer = null; }
    }

    function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver(muts => {
            if (!running) return;
            for (const m of muts) {
                const t = m.target;
                if (t.id === 'ufm3-panel' || t.id === 'ufm3-popup' || (t.closest && (t.closest('#ufm3-panel') || t.closest('#ufm3-popup')))) continue;
                if (m.addedNodes && m.addedNodes.length) {
                    if (t.closest && (t.closest('table') || t.closest('[role="table"]') || t.closest('[role="grid"]'))) lastDomChange = Date.now();
                    clearTimeout(observerDebounce);
                    observerDebounce = setTimeout(scan, 150);
                    break;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ================================================================
    // AUDIO: keep-alive tone, accept tone, continuous alert beep
    // ================================================================
    function ensureAudio() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        } catch {}
        return audioCtx;
    }
    function startKeepAlive() {
        if (!S.KEEPALIVE_ON || keepAliveNodes) return;
        const ctx = ensureAudio(); if (!ctx) return;
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = 20; g.gain.value = 0.02;   // inaudible, but counts as playing audio
        osc.connect(g); g.connect(ctx.destination); osc.start();
        keepAliveNodes = { osc, g };
    }
    function stopKeepAlive() {
        if (!keepAliveNodes) return;
        try { keepAliveNodes.osc.stop(); } catch {}
        keepAliveNodes = null;
    }
    function tone(freq, dur, gain = 0.35, when = 0) {
        const ctx = ensureAudio(); if (!ctx || !S.SOUND_ON) return;
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq; g.gain.value = gain;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + when); o.stop(ctx.currentTime + when + dur);
    }
    function playAcceptTone() { tone(880, 0.18); tone(1320, 0.22, 0.35, 0.25); }   // two tones = accepted
    function startBeepLoop() {
        if (beepLoop) return;
        const beep = () => { tone(1000, 0.25, 0.4); tone(1000, 0.25, 0.4, 0.4); };
        beep(); beepLoop = setInterval(beep, 1500);                                // continuous = needs a human
        document.title = '🚨 TRIP MATCH - ' + document.title.replace(/^🚨 TRIP MATCH - /, '');
    }
    function stopBeepLoop() {
        if (beepLoop) { clearInterval(beepLoop); beepLoop = null; }
        unhandledMatch = null;
        document.title = document.title.replace(/^🚨 TRIP MATCH - /, '');
        const p = document.getElementById('ufm3-popup'); if (p) p.remove();
    }

    async function notify(m, title) {
        if (!S.NOTIFY_ON || !('Notification' in window)) return;
        try {
            if (Notification.permission === 'default') await Notification.requestPermission();
            if (Notification.permission === 'granted') {
                new Notification((title || '🚕 Trip match') + ' ₹' + Number(m.fare).toLocaleString('en-IN'), { body: 'Trip ' + m.id, requireInteraction: true });
            }
        } catch {}
    }

    // ================================================================
    // UI
    // ================================================================
    function highlight(row) {
        if (!row) return;
        row.style.outline = '4px solid #e53935'; row.style.outlineOffset = '2px'; row.style.background = 'rgba(229,57,53,.12)';
        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    }
    function showPopup(m) {
        let p = document.getElementById('ufm3-popup'); if (p) p.remove();
        p = document.createElement('div'); p.id = 'ufm3-popup';
        p.innerHTML = `<div class="t">🚨 TRIP MATCH</div><div class="f">₹${Number(m.fare).toLocaleString('en-IN')}</div><div class="i">${m.id}</div>
            <div class="i">${S.DRY_RUN ? 'DRY RUN: would have accepted' : 'Auto-accept is OFF: accept manually'}</div>
            <button id="ufm3-ack">ACKNOWLEDGE (stop beep)</button>`;
        document.body.appendChild(p);
        document.getElementById('ufm3-ack').onclick = stopBeepLoop;
    }
    function status(msg) { const el = document.getElementById('ufm3-status'); if (el) el.innerHTML = msg; }
    function addLog(e) {
        e.time = new Date().toLocaleString('en-IN', { hour12: false });
        acceptLog.push(e); saveLog(); renderLog();
    }
    function renderLog() {
        const el = document.getElementById('ufm3-log'); if (!el) return;
        el.innerHTML = acceptLog.slice(-8).reverse().map(e => `<div>${e.time} · ₹${Number(e.fare).toLocaleString('en-IN')} · ${e.id} · <b>${e.result}</b></div>`).join('') || '<div>No accepts yet</div>';
    }
    function exportCsv() {
        const rows = [['time', 'trip_id', 'fare', 'result']].concat(acceptLog.map(e => [e.time, e.id, e.fare, e.result]));
        const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'uber-accept-log.csv'; a.click();
    }

    function panel() {
        if (document.getElementById('ufm3-panel')) return;
        const p = document.createElement('div'); p.id = 'ufm3-panel';
        const num = (id, label, val, min) => `<label>${label}<input id="${id}" type="number" min="${min || 0}" value="${val}"></label>`;
        const chk = (id, label, val) => `<label class="c"><input id="${id}" type="checkbox" ${val ? 'checked' : ''}> ${label}</label>`;
        p.innerHTML = `
            <div class="h">🚕 Uber Fleet Auto Grabber <span>V3.0</span></div>
            <div id="ufm3-run" class="run off">STOPPED · click START</div>
            ${num('ufm3-min', 'Minimum fare ₹', S.MIN_FARE)}
            ${num('ufm3-max', 'Maximum fare ₹', S.MAX_FARE)}
            ${chk('ufm3-auto', 'Auto-accept in range', S.AUTO_ACCEPT)}
            ${chk('ufm3-dry', 'DRY RUN (log only, never click)', S.DRY_RUN)}
            ${chk('ufm3-cityon', 'City filter', S.CITY_FILTER_ON)}
            <label>Cities (comma separated)<input id="ufm3-city" type="text" value="${S.CITY_LIST}"></label>
            ${chk('ufm3-skiptoday', 'Skip today\'s pickups (IST)', S.SKIP_TODAY)}
            ${chk('ufm3-pickupon', 'Pickup date window (IST)', S.PICKUP_FILTER_ON)}
            <label>Pickup from<input id="ufm3-pfrom" type="date" value="${S.PICKUP_FROM}"></label>
            <label>Pickup to<input id="ufm3-pto" type="date" value="${S.PICKUP_TO}"></label>
            ${num('ufm3-scan', 'Scan every (ms)', S.SCAN_MS, 10)}
            ${num('ufm3-refresh', 'Refresh list every (ms)', S.REFRESH_MS, 100)}
            ${num('ufm3-settle', 'Table settle before click (ms)', S.SETTLE_MS, 0)}
            ${num('ufm3-postref', 'Quiet after refresh (ms)', S.POST_REFRESH_MS, 0)}
            ${chk('ufm3-direct', 'DIRECT API mode (recommended)', S.DIRECT_MODE)}
            ${num('ufm3-dpoll', 'Direct poll every (ms)', S.DIRECT_POLL_MS, 100)}
            <label>Offer lists to poll<input id="ufm3-dsrc" type="text" value="${S.DIRECT_SOURCES}"></label>
            ${chk('ufm3-refreshon', 'Tab-toggle refresh', S.REFRESH_ON)}
            ${chk('ufm3-sound', 'Sound', S.SOUND_ON)}
            ${chk('ufm3-notify', 'Desktop notification', S.NOTIFY_ON)}
            ${chk('ufm3-keep', 'Keep tab alive in background', S.KEEPALIVE_ON)}
            <button id="ufm3-toggle" class="b main">START</button>
            <button id="ufm3-ackbtn" class="b">ACKNOWLEDGE / STOP BEEP</button>
            <button id="ufm3-csv" class="b">EXPORT ACCEPT LOG (CSV)</button>
            <button id="ufm3-diag" class="b">EXPORT DIAGNOSTICS (JSON)</button>
            <button id="ufm3-net" class="b">EXPORT NETWORK LOG (JSON)</button>
            <button id="ufm3-clear" class="b">CLEAR HANDLED MEMORY</button>
            <div id="ufm3-status" class="s">Idle</div>
            <div class="h2">Accept log</div><div id="ufm3-log" class="l"></div>`;
        document.body.appendChild(p); styles(); renderLog();

        const bind = (id, key, kind) => document.getElementById(id).addEventListener('change', e => {
            S[key] = kind === 'bool' ? e.target.checked : kind === 'text' ? e.target.value : Number(e.target.value);
            if (key === 'SCAN_MS') { S.SCAN_MS = Math.max(10, S.SCAN_MS || 10); e.target.value = S.SCAN_MS; }
            if (key === 'REFRESH_MS') { S.REFRESH_MS = Math.max(100, S.REFRESH_MS || 150); e.target.value = S.REFRESH_MS; }
            saveSettings();
            if (running && (key === 'SCAN_MS' || key === 'REFRESH_MS' || key === 'DIRECT_POLL_MS')) startTimers();
            if (key === 'KEEPALIVE_ON') { S.KEEPALIVE_ON ? startKeepAlive() : stopKeepAlive(); }
            if ((key === 'DRY_RUN' && !S.DRY_RUN) || (key === 'AUTO_ACCEPT' && S.AUTO_ACCEPT)) { dryHandled.clear(); stopBeepLoop(); status('Live mode: dry-run matches are eligible again'); }
        });
        bind('ufm3-min', 'MIN_FARE'); bind('ufm3-max', 'MAX_FARE'); bind('ufm3-auto', 'AUTO_ACCEPT', 'bool');
        bind('ufm3-dry', 'DRY_RUN', 'bool'); bind('ufm3-cityon', 'CITY_FILTER_ON', 'bool'); bind('ufm3-city', 'CITY_LIST', 'text');
        bind('ufm3-skiptoday', 'SKIP_TODAY', 'bool'); bind('ufm3-pickupon', 'PICKUP_FILTER_ON', 'bool'); bind('ufm3-pfrom', 'PICKUP_FROM', 'text'); bind('ufm3-pto', 'PICKUP_TO', 'text');
        bind('ufm3-scan', 'SCAN_MS'); bind('ufm3-refresh', 'REFRESH_MS'); bind('ufm3-refreshon', 'REFRESH_ON', 'bool');
        bind('ufm3-settle', 'SETTLE_MS'); bind('ufm3-postref', 'POST_REFRESH_MS');
        bind('ufm3-direct', 'DIRECT_MODE', 'bool'); bind('ufm3-dpoll', 'DIRECT_POLL_MS'); bind('ufm3-dsrc', 'DIRECT_SOURCES', 'text');
        bind('ufm3-sound', 'SOUND_ON', 'bool'); bind('ufm3-notify', 'NOTIFY_ON', 'bool'); bind('ufm3-keep', 'KEEPALIVE_ON', 'bool');

        document.getElementById('ufm3-toggle').onclick = () => running ? stop() : start();
        document.getElementById('ufm3-ackbtn').onclick = stopBeepLoop;
        document.getElementById('ufm3-csv').onclick = exportCsv;
        document.getElementById('ufm3-diag').onclick = exportDiag;
        document.getElementById('ufm3-net').onclick = exportNet;
        document.getElementById('ufm3-clear').onclick = () => { handled = {}; dryHandled.clear(); saveHandled(); status('Handled memory cleared'); };
    }

    function styles() {
        const st = document.createElement('style');
        st.textContent = `
        #ufm3-panel{position:fixed;top:70px;right:16px;width:290px;z-index:999999;background:#111;color:#fff;padding:14px;border-radius:12px;font:12px Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);box-sizing:border-box}
        #ufm3-panel .h{font-size:16px;font-weight:700;margin-bottom:8px}#ufm3-panel .h span{float:right;font-size:11px;opacity:.6}
        #ufm3-panel .h2{font-weight:700;margin-top:10px}
        #ufm3-panel label{display:block;margin:6px 0}#ufm3-panel label.c{display:flex;gap:6px;align-items:center}
        #ufm3-panel input[type=number],#ufm3-panel input[type=text],#ufm3-panel input[type=date]{width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:1px solid #555;background:#222;color:#fff;margin-top:3px}
        #ufm3-panel .b{width:100%;padding:9px;margin-top:6px;border:0;border-radius:7px;cursor:pointer;font-weight:700;background:#333;color:#fff}
        #ufm3-panel .b.main{background:#2e7d32}#ufm3-panel .b.main.on{background:#c62828}
        #ufm3-panel .run{padding:6px;border-radius:6px;text-align:center;font-weight:700;margin-bottom:6px;background:#444}
        #ufm3-panel .run.on{background:#2e7d32}#ufm3-panel .run.off{background:#555}
        #ufm3-panel .s{margin-top:10px;padding:8px;border-radius:6px;background:#222;line-height:1.5}
        #ufm3-panel .l{max-height:150px;overflow:auto;font-size:11px;line-height:1.5;background:#1a1a1a;padding:6px;border-radius:6px}
        #ufm3-popup{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:360px;max-width:90vw;z-index:1000000;padding:22px;background:#111;color:#fff;border-radius:14px;text-align:center;font-family:Arial,sans-serif;box-shadow:0 15px 60px rgba(0,0,0,.7)}
        #ufm3-popup .t{font-size:20px;font-weight:700}#ufm3-popup .f{font-size:36px;font-weight:700;margin:14px 0}#ufm3-popup .i{margin:6px 0;font-size:13px}
        #ufm3-popup button{width:100%;padding:12px;margin-top:14px;border:0;border-radius:8px;cursor:pointer;font-size:15px;font-weight:700}`;
        document.head.appendChild(st);
    }

    // ================================================================
    // START / STOP
    // ================================================================
    function start() {
        authBlocked = false; authFailCount = 0;
        running = true; ensureAudio(); startKeepAlive(); startObserver(); startTimers();
        document.getElementById('ufm3-toggle').textContent = 'STOP';
        document.getElementById('ufm3-toggle').classList.add('on');
        const r = document.getElementById('ufm3-run'); r.textContent = 'RUNNING' + (S.DRY_RUN ? ' (DRY RUN)' : S.AUTO_ACCEPT ? ' · AUTO-ACCEPT' : ' · ALERT ONLY'); r.className = 'run on';
        status('Started'); log('started');
        scan();
    }
    function stop() {
        running = false; stopTimers(); stopKeepAlive(); stopBeepLoop();
        if (inFlight) {                                   // never drop an accept silently
            const f = inFlight; inFlight = null;
            try { diagSave(f, 'ABORTED'); } catch {}
            addLog({ id: f.id, fare: f.fare, result: f.acceptSeen ? 'ABORTED after accept was sent - VERIFY in Accepted tab' : 'ABORTED before accept' });
        }
        inFlight = null;
        if (observer) observer.disconnect();
        document.getElementById('ufm3-toggle').textContent = 'START';
        document.getElementById('ufm3-toggle').classList.remove('on');
        const r = document.getElementById('ufm3-run'); r.textContent = 'STOPPED · click START'; r.className = 'run off';
        status('Stopped'); log('stopped');
    }

    installNetRecorder();
    setTimeout(() => { panel(); log('panel ready. Press START (a click is needed so the browser allows sound).'); }, 1500);
})();
