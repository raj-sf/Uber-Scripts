// ==UserScript==
// @name         Uber Fleet Auto-Acceptor (Safe Audio & React Event Fix)
// @namespace    http://tampermonkey.net/
// @version      2026-08-25
// @description  Safely clicks Uber BaseWeb accept buttons without audio exceptions blocking processing
// @author       You
// @match        https://supplier.uber.com/orgs/72d16431-d9c5-4c64-8d65-325a65461b91/trip-reservation-offer
// @icon         https://www.google.com/s2/favicons?sz=64&domain=uber.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        minPrice: 1000,
        scanInterval: 300,
        refreshInterval: 3000,
        requiredCity: 'chennai'
    };

    let isProcessing = false;
    let audioCtx = null;

    // Non-blocking Web Audio player
    function playAlertSound() {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }

            if (audioCtx.state === 'running') {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, audioCtx.currentTime);
                gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
                osc.start();
                osc.stop(audioCtx.currentTime + 0.3);
            }
        } catch (e) {
            // Silence audio errors so script flow isn't interrupted
        }
    }

    // Trigger full event sequence for React / BaseWeb elements
    function forceClick(el) {
        if (!el) return;

        // Native click fallback
        if (typeof el.click === 'function') {
            el.click();
        }

        // Pointer/Mouse sequence for React synthetic handlers
        const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(type => {
            const evt = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window
            });
            el.dispatchEvent(evt);
        });
    }

    function parseMaxFare(text) {
        const matches = text.match(/[\d,]+\.\d{2}/g);
        if (!matches) return 0;

        let max = 0;
        for (let match of matches) {
            const val = parseFloat(match.replace(/,/g, ''));
            if (!isNaN(val) && val > max && val < 100000) {
                max = val;
            }
        }
        return max;
    }

    function scanTableRows() {
        const rows = document.querySelectorAll('tr');

        for (let row of rows) {
            const rowText = row.textContent.toLowerCase();
            if (!rowText.includes(CONFIG.requiredCity)) continue;

            const rowFare = parseMaxFare(row.textContent);
            if (rowFare < CONFIG.minPrice) continue;

            // Direct target using Uber's specific data attribute seen in logs
            const acceptBtn = row.querySelector('button[data-testid="trip-reservation-table-action-button"]') ||
                              Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim().toLowerCase() === 'accept');

            if (acceptBtn) {
                console.log(`[ACCEPTING RIDE] ₹${rowFare} in ${CONFIG.requiredCity}!`);
                isProcessing = true;

                // Safely execute audio without blocking click operation
                playAlertSound();

                // Fire click in next animation frame to align with dynamic DOM rendering
                window.requestAnimationFrame(() => {
                    forceClick(acceptBtn);
                });
                return true;
            }
        }
        return false;
    }

    function fastScan() {
        if (isProcessing) return;
        scanTableRows();
    }

    // Automatic reloader
    setInterval(() => {
        if (isProcessing) return;
        window.location.reload();
    }, CONFIG.refreshInterval);

    // Scanner loop
    setInterval(fastScan, CONFIG.scanInterval);

    console.log('⚡ Uber Fleet Direct Acceptor (Safe Audio & React Event Fix Active)');
})();
