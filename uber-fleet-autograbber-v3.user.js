// ==UserScript==
// @name         Uber Fleet - Auto Grabber V3 (Monitor + Accept, exact fare)
// @namespace    http://tampermonkey.net/
// @version      3.0.2
// @description  Scans Trip Management, reads the Fare column exactly, auto-accepts trips inside the fare range, confirms only its own dialog, keeps the list fresh by tab toggling, keeps working in background tabs, logs every accept.
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
        SCAN_MS: 250,              // scan interval (floor 100)
        REFRESH_MS: 3000,          // tab toggle interval to force the list to refetch (floor 1500: faster makes React rebuild the table mid-click)
        REFRESH_ON: true,          // toggle Announcements <-> Trip Management
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

    const SEL = {
        acceptBtn: 'button[data-testid="trip-reservation-table-action-button"]',
        dialog: '[role="dialog"], [role="alertdialog"], [data-baseweb="modal"], [aria-modal="true"], [data-baseweb="drawer"]',
        baseButton: 'button[data-baseweb="button"], button'
    };

    // ================================================================
    // STATE
    // ================================================================
    let S = loadSettings();
    S.SCAN_MS = Math.max(100, Number(S.SCAN_MS) || 250);
    S.REFRESH_MS = Math.max(1500, Number(S.REFRESH_MS) || 3000);
    let running = false;
    let worker = null;
    let pageTimer = null;
    let refreshTimer = null;
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
        const cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
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
        document.querySelectorAll('[role="alert"], [role="status"], [data-baseweb="toast"], [role="dialog"], [data-baseweb="modal"], [aria-modal="true"], [data-baseweb="drawer"]').forEach(el => {
            if (el.closest('#ufm3-panel') || el.closest('#ufm3-popup')) return;
            if (!isVisible(el)) return;
            const t = clean(el.textContent).slice(0, 160);
            if (t) out.push(t);
        });
        return out;
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
        document.querySelectorAll(SEL.acceptBtn).forEach(btn => {
            if (!isVisible(btn)) return;
            if (btn.closest('#ufm3-panel')) return;
            const row = btn.closest('tr') || btn.closest('[role="row"]') || btn.parentElement;
            if (!row) return;
            out.push({ row, btn });
        });
        return out;
    }

    // ================================================================
    // SCAN
    // ================================================================
    function scan() {
        if (!running) return;
        scanCount++;
        if (inFlight) { checkInFlight(); return; }

        const cands = candidateRows();
        let seen = 0, matched = null;

        for (const { row, btn } of cands) {
            seen++;
            const fare = rowFare(row);
            if (fare === null) continue;
            const id = rowTripId(row);
            const key = id + '|' + fare;
            if (handled[key] || dryHandled.has(key)) continue;
            if (fare < S.MIN_FARE || fare > S.MAX_FARE) continue;
            if (!cityOk(row)) continue;
            matched = { row, btn, fare, id, key };
            break; // one at a time
        }

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
            status(`Scanning… rows: ${seen}, range ₹${S.MIN_FARE}–₹${S.MAX_FARE}${S.DRY_RUN ? ' (DRY RUN)' : ''}`);
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
        inFlight = { id: m.id, fare: m.fare, startedAt: now, row: m.row, confirmed: false };
        acceptTimes.push(now);
        status(`Accepting ₹${m.fare.toLocaleString('en-IN')} (${m.id})…`);
        log(`ACCEPT click ₹${m.fare} ${m.id}`);
        requestAnimationFrame(() => fireClick(m.btn));
    }

    function checkInFlight() {
        const f = inFlight;
        const elapsed = Date.now() - f.startedAt;

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
        const msgs = pageMessages();
        if (msgs.length) f.lastMsg = msgs.join(' | ');
        if (!liveRow && elapsed > 800) {
            finishInFlight('ACCEPTED');
            return;
        }
        if (/no longer available|already (been )?accepted|not available|unavailable|taken|expired|something went wrong|error/i.test(f.lastMsg || '')) {
            finishInFlight('LOST: ' + f.lastMsg.slice(0, 90));
            return;
        }
        if (elapsed > S.CONFIRM_WINDOW_MS + 4000) {
            finishInFlight('TIMEOUT' + (f.confirmed ? ' after confirm' : ' no confirm dialog seen') + (f.lastMsg ? ': ' + f.lastMsg.slice(0, 90) : ''));
        }
    }

    function finishInFlight(result) {
        const f = inFlight; inFlight = null;
        addLog({ id: f.id, fare: f.fare, result });
        if (result === 'ACCEPTED') { playAcceptTone(); notify({ fare: f.fare, id: f.id }, 'Accepted'); }
        else if (result.startsWith('LOST')) { tone(440, 0.3, 0.3); }
        else { startBeepLoop(); unhandledMatch = { key: f.id, fare: f.fare, id: f.id }; }
        status(`${result}: ₹${f.fare.toLocaleString('en-IN')} (${f.id})`);
    }

    // ================================================================
    // LIST REFRESH (tab toggle, the method that works on this portal)
    // ================================================================
    let refreshPhase = 0;
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
        if (!running || !S.REFRESH_ON) return;
        if (inFlight) return;
        if (candidateRows().length) return;            // never switch away while a trip is on screen
        if (refreshPhase === 0) {
            const a = findByText('Announcements');
            if (a) { fireClick(a); refreshPhase = 1; }
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
    }
    function stopTimers() {
        if (worker) { try { worker.postMessage({ cmd: 'stop' }); worker.terminate(); } catch {} worker = null; }
        if (pageTimer) { clearInterval(pageTimer); pageTimer = null; }
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }

    function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver(muts => {
            if (!running) return;
            for (const m of muts) {
                const t = m.target;
                if (t.id === 'ufm3-panel' || t.id === 'ufm3-popup' || (t.closest && (t.closest('#ufm3-panel') || t.closest('#ufm3-popup')))) continue;
                if (m.addedNodes && m.addedNodes.length) {
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
            ${num('ufm3-scan', 'Scan every (ms)', S.SCAN_MS, 100)}
            ${num('ufm3-refresh', 'Refresh list every (ms)', S.REFRESH_MS, 1000)}
            ${chk('ufm3-refreshon', 'Tab-toggle refresh', S.REFRESH_ON)}
            ${chk('ufm3-sound', 'Sound', S.SOUND_ON)}
            ${chk('ufm3-notify', 'Desktop notification', S.NOTIFY_ON)}
            ${chk('ufm3-keep', 'Keep tab alive in background', S.KEEPALIVE_ON)}
            <button id="ufm3-toggle" class="b main">START</button>
            <button id="ufm3-ackbtn" class="b">ACKNOWLEDGE / STOP BEEP</button>
            <button id="ufm3-csv" class="b">EXPORT ACCEPT LOG (CSV)</button>
            <button id="ufm3-clear" class="b">CLEAR HANDLED MEMORY</button>
            <div id="ufm3-status" class="s">Idle</div>
            <div class="h2">Accept log</div><div id="ufm3-log" class="l"></div>`;
        document.body.appendChild(p); styles(); renderLog();

        const bind = (id, key, kind) => document.getElementById(id).addEventListener('change', e => {
            S[key] = kind === 'bool' ? e.target.checked : kind === 'text' ? e.target.value : Number(e.target.value);
            if (key === 'SCAN_MS') { S.SCAN_MS = Math.max(100, S.SCAN_MS || 250); e.target.value = S.SCAN_MS; }
            if (key === 'REFRESH_MS') { S.REFRESH_MS = Math.max(1500, S.REFRESH_MS || 3000); e.target.value = S.REFRESH_MS; }
            saveSettings();
            if (running && (key === 'SCAN_MS' || key === 'REFRESH_MS')) startTimers();
            if (key === 'KEEPALIVE_ON') { S.KEEPALIVE_ON ? startKeepAlive() : stopKeepAlive(); }
            if ((key === 'DRY_RUN' && !S.DRY_RUN) || (key === 'AUTO_ACCEPT' && S.AUTO_ACCEPT)) { dryHandled.clear(); stopBeepLoop(); status('Live mode: dry-run matches are eligible again'); }
        });
        bind('ufm3-min', 'MIN_FARE'); bind('ufm3-max', 'MAX_FARE'); bind('ufm3-auto', 'AUTO_ACCEPT', 'bool');
        bind('ufm3-dry', 'DRY_RUN', 'bool'); bind('ufm3-cityon', 'CITY_FILTER_ON', 'bool'); bind('ufm3-city', 'CITY_LIST', 'text');
        bind('ufm3-scan', 'SCAN_MS'); bind('ufm3-refresh', 'REFRESH_MS'); bind('ufm3-refreshon', 'REFRESH_ON', 'bool');
        bind('ufm3-sound', 'SOUND_ON', 'bool'); bind('ufm3-notify', 'NOTIFY_ON', 'bool'); bind('ufm3-keep', 'KEEPALIVE_ON', 'bool');

        document.getElementById('ufm3-toggle').onclick = () => running ? stop() : start();
        document.getElementById('ufm3-ackbtn').onclick = stopBeepLoop;
        document.getElementById('ufm3-csv').onclick = exportCsv;
        document.getElementById('ufm3-clear').onclick = () => { handled = {}; dryHandled.clear(); saveHandled(); status('Handled memory cleared'); };
    }

    function styles() {
        const st = document.createElement('style');
        st.textContent = `
        #ufm3-panel{position:fixed;top:70px;right:16px;width:290px;z-index:999999;background:#111;color:#fff;padding:14px;border-radius:12px;font:12px Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);box-sizing:border-box}
        #ufm3-panel .h{font-size:16px;font-weight:700;margin-bottom:8px}#ufm3-panel .h span{float:right;font-size:11px;opacity:.6}
        #ufm3-panel .h2{font-weight:700;margin-top:10px}
        #ufm3-panel label{display:block;margin:6px 0}#ufm3-panel label.c{display:flex;gap:6px;align-items:center}
        #ufm3-panel input[type=number],#ufm3-panel input[type=text]{width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:1px solid #555;background:#222;color:#fff;margin-top:3px}
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
        running = true; ensureAudio(); startKeepAlive(); startObserver(); startTimers();
        document.getElementById('ufm3-toggle').textContent = 'STOP';
        document.getElementById('ufm3-toggle').classList.add('on');
        const r = document.getElementById('ufm3-run'); r.textContent = 'RUNNING' + (S.DRY_RUN ? ' (DRY RUN)' : S.AUTO_ACCEPT ? ' · AUTO-ACCEPT' : ' · ALERT ONLY'); r.className = 'run on';
        status('Started'); log('started');
        scan();
    }
    function stop() {
        running = false; stopTimers(); stopKeepAlive(); stopBeepLoop(); inFlight = null;
        if (observer) observer.disconnect();
        document.getElementById('ufm3-toggle').textContent = 'START';
        document.getElementById('ufm3-toggle').classList.remove('on');
        const r = document.getElementById('ufm3-run'); r.textContent = 'STOPPED · click START'; r.className = 'run off';
        status('Stopped'); log('stopped');
    }

    setTimeout(() => { panel(); log('panel ready. Press START (a click is needed so the browser allows sound).'); }, 1500);
})();
