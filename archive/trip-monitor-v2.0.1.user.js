// ==UserScript==
// @name         Uber Fleet - Trip Monitor & Alert V2 (Fixed)
// @namespace    http://tampermonkey.net/
// @version      2.0.1
// @description  Uber Fleet trip monitor with fare, pickup, distance filters, alerts, duplicate protection and control panel.
// @match        https://fleethub.uber.com/orgs/72d16431-d9c5-4c64-8d65-325a65461b91/trip-reservation-offer
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // SETTINGS
    // ================================================================
    const SETTINGS = {
        MIN_FARE: 2800,
        MAX_FARE: 50000,
        MAX_DISTANCE_KM: 80,
        SCAN_INTERVAL_MS: 2000,
        ENABLE_PICKUP_FILTER: false,
        PICKUP_LOCATIONS: ['Chennai'],
        SOUND_ALERT: true,
        DESKTOP_NOTIFICATION: true,
        DUPLICATE_TIMEOUT_MS: 60000,
        SHOW_MATCH_POPUP: true,
        HIGHLIGHT_MATCH: true
    };

    // ================================================================
    // STATE
    // ================================================================
    let monitorEnabled = true;
    let scannerTimer = null;
    let observer = null;
    let observerDebounceTimer = null;
    let alertedTrips = new Map();
    let scanCount = 0;
    let matchCount = 0;

    // ================================================================
    // UTILITY
    // ================================================================
    function cleanText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    }

    // ================================================================
    // FARE PARSER
    // ================================================================
    function parseMoney(text) {
        text = cleanText(text);
        if (!text) return null;
        const matches = [...text.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)];
        if (!matches.length) {
            const numbers = text.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,6}(?:\.\d+)?\b/g);
            if (!numbers) return null;
            let highest = 0;
            numbers.forEach(value => {
                const number = parseFloat(value.replace(/,/g, ''));
                if (number >= 500 && number <= 100000 && number > highest) {
                    highest = number;
                }
            });
            return highest || null;
        }
        let highest = 0;
        matches.forEach(match => {
            const number = parseFloat(match[1].replace(/,/g, ''));
            if (number > highest) {
                highest = number;
            }
        });
        return highest || null;
    }

    // ================================================================
    // DISTANCE PARSER
    // ================================================================
    function parseDistance(text) {
        text = cleanText(text);
        const patterns = [
            /([\d]+(?:\.[\d]+)?)\s*km\b/i,
            /([\d]+(?:\.[\d]+)?)\s*kms\b/i,
            /([\d]+(?:\.[\d]+)?)\s*kilometers?\b/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const distance = parseFloat(match[1]);
                if (Number.isFinite(distance) && distance >= 0) {
                    return distance;
                }
            }
        }
        return null;
    }

    // ================================================================
    // PICKUP FILTER
    // ================================================================
    function pickupMatches(text) {
        if (!SETTINGS.ENABLE_PICKUP_FILTER) return true;
        const lower = cleanText(text).toLowerCase();
        if (!SETTINGS.PICKUP_LOCATIONS.length) return true;
        return SETTINGS.PICKUP_LOCATIONS.some(location =>
            lower.includes(String(location).toLowerCase().trim())
        );
    }

    // ================================================================
    // TRIP SIGNATURE
    // ================================================================
    function createTripSignature(element, text, fare, distance) {
        const attributes = [
            element?.getAttribute?.('data-testid'),
            element?.getAttribute?.('data-id'),
            element?.getAttribute?.('id')
        ].filter(Boolean).join('|');
        return [attributes, fare || '', distance || '', cleanText(text).slice(0, 700)].join('|');
    }

    // ================================================================
    // FIND TRIP CONTAINERS
    // ================================================================
    function getTripContainers() {
        const selectors = [
            'tr',
            '[role="row"]',
            '[data-testid*="trip"]',
            '[data-testid*="reservation"]',
            '[data-testid*="offer"]',
            'article',
            '[role="listitem"]'
        ];
        const found = [];
        const seen = new Set();

        selectors.forEach(selector => {
            let elements = [];
            try {
                elements = document.querySelectorAll(selector);
            } catch {
                return;
            }
            elements.forEach(element => {
                // Ignore self-created UI elements
                if (element.closest('#ufm-panel') || element.closest('#ufm-match')) return;
                if (seen.has(element)) return;
                if (!isVisible(element)) return;

                const text = cleanText(element.textContent);
                if (!text) return;

                const hasFare = /₹\s*[\d,]+/.test(text);
                const hasTripWords = /pickup|dropoff|fare|reservation|trip/i.test(text);
                if (hasFare || hasTripWords) {
                    seen.add(element);
                    found.push(element);
                }
            });
        });
        return found;
    }

    // ================================================================
    // FIND ACCEPT / ACTION BUTTON
    // ================================================================
    function findActionButton(container) {
        if (!container) return null;
        const selectors = [
            'button[data-testid="trip-reservation-table-action-button"]',
            'button[data-testid*="reservation"]',
            'button[data-testid*="offer"]',
            'button[data-testid*="trip"]',
            'button'
        ];
        for (const selector of selectors) {
            let buttons = [];
            try {
                buttons = container.querySelectorAll(selector);
            } catch {
                continue;
            }
            for (const button of buttons) {
                if (!isVisible(button)) continue;
                const text = cleanText(button.textContent).toLowerCase();
                if (/accept|offer|reserve|view|claim/i.test(text)) {
                    return button;
                }
            }
        }
        return null;
    }

    // ================================================================
    // CHECK ONE TRIP
    // ================================================================
    function checkTrip(element) {
        const text = cleanText(element.textContent);
        if (!text) return null;

        const fare = parseMoney(text);
        if (!fare || fare < SETTINGS.MIN_FARE || fare > SETTINGS.MAX_FARE) {
            return null;
        }

        const distance = parseDistance(text);
        if (distance !== null && distance > SETTINGS.MAX_DISTANCE_KM) {
            return null;
        }

        if (!pickupMatches(text)) {
            return null;
        }

        const signature = createTripSignature(element, text, fare, distance);
        const now = Date.now();
        const previous = alertedTrips.get(signature);

        if (previous && now - previous < SETTINGS.DUPLICATE_TIMEOUT_MS) {
            return null;
        }

        alertedTrips.set(signature, now);
        return { element, button: findActionButton(element), fare, distance, text, signature };
    }

    // ================================================================
    // PROCESS MATCH
    // ================================================================
    function processMatch(trip) {
        if (!trip) return;
        matchCount++;

        if (SETTINGS.HIGHLIGHT_MATCH) {
            highlightTrip(trip.element);
        }

        updatePanel(
            `<b>🚨 MATCH FOUND</b><br>` +
            `Fare: ₹${trip.fare.toLocaleString('en-IN')}<br>` +
            `Distance: ${trip.distance !== null ? trip.distance + ' km' : 'Unknown'}<br>` +
            `Matches: ${matchCount}`
        );

        if (SETTINGS.SHOW_MATCH_POPUP) {
            showMatchPopup(trip);
        }

        playAlertSound();
        desktopNotification(trip);
    }

    // ================================================================
    // HIGHLIGHT TRIP
    // ================================================================
    function highlightTrip(element) {
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.style.outline = '4px solid red';
        element.style.outlineOffset = '3px';
        element.style.background = 'rgba(255, 0, 0, 0.12)';
        element.dataset.ufmMatch = 'true';
    }

    // ================================================================
    // MATCH POPUP
    // ================================================================
    function showMatchPopup(trip) {
        const old = document.getElementById('ufm-match');
        if (old) old.remove();

        const popup = document.createElement('div');
        popup.id = 'ufm-match';
        popup.innerHTML = `
            <div class="ufm-popup-title">🚨 TRIP MATCH FOUND</div>
            <div class="ufm-popup-fare">₹${trip.fare.toLocaleString('en-IN')}</div>
            <div class="ufm-popup-info">Distance: ${trip.distance !== null ? trip.distance + ' km' : 'Not detected'}</div>
            <div class="ufm-popup-info">${SETTINGS.ENABLE_PICKUP_FILTER ? 'Pickup filter matched' : 'Pickup filter OFF'}</div>
            <button id="ufm-open-trip">OPEN MATCH</button>
            <button id="ufm-close-match">CLOSE</button>
        `;
        document.body.appendChild(popup);

        document.getElementById('ufm-open-trip').addEventListener('click', () => {
            highlightTrip(trip.element);
            popup.remove();
            if (trip.button) {
                trip.button.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            updatePanel(`MATCH READY — REVIEW AND ACCEPT MANUALLY`);
        });

        document.getElementById('ufm-close-match').addEventListener('click', () => popup.remove());
    }

    // ================================================================
    // SOUND
    // ================================================================
    function playAlertSound() {
        if (!SETTINGS.SOUND_ALERT) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const audio = new AudioContext();
            const tones = [880, 1100, 1320];
            tones.forEach((frequency, index) => {
                setTimeout(() => {
                    const oscillator = audio.createOscillator();
                    const gain = audio.createGain();
                    oscillator.type = 'sine';
                    oscillator.frequency.value = frequency;
                    gain.gain.value = 0.35;
                    oscillator.connect(gain);
                    gain.connect(audio.destination);
                    oscillator.start();
                    oscillator.stop(audio.currentTime + 0.22);
                }, index * 280);
            });
        } catch (error) {
            console.log('UFM audio error:', error);
        }
    }

    // ================================================================
    // DESKTOP NOTIFICATION
    // ================================================================
    async function desktopNotification(trip) {
        if (!SETTINGS.DESKTOP_NOTIFICATION || !('Notification' in window)) return;
        try {
            if (Notification.permission === 'default') {
                await Notification.requestPermission();
            }
            if (Notification.permission === 'granted') {
                new Notification('🚕 Uber Fleet Trip Match', {
                    body: `Fare: ₹${trip.fare.toLocaleString('en-IN')}\nDistance: ${trip.distance !== null ? trip.distance + ' km' : 'Unknown'}`,
                    requireInteraction: true
                });
            }
        } catch (error) {
            console.log('UFM notification error:', error);
        }
    }

    // ================================================================
    // PANEL
    // ================================================================
    function createPanel() {
        if (document.getElementById('ufm-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ufm-panel';
        panel.innerHTML = `
            <div class="ufm-header">🚕 Uber Fleet Monitor <span class="ufm-version">V2.0</span></div>
            <div class="ufm-status">STATUS: <span id="ufm-status">ON</span></div>
            <div class="ufm-field">
                <label>Minimum Fare ₹</label>
                <input id="ufm-minfare" type="number" min="0" value="${SETTINGS.MIN_FARE}">
            </div>
            <div class="ufm-field">
                <label>Maximum Fare ₹</label>
                <input id="ufm-maxfare" type="number" min="0" value="${SETTINGS.MAX_FARE}">
            </div>
            <div class="ufm-field">
                <label>Maximum Distance KM</label>
                <input id="ufm-maxdistance" type="number" min="0" value="${SETTINGS.MAX_DISTANCE_KM}">
            </div>
            <div class="ufm-field">
                <label>Scan Interval MS</label>
                <input id="ufm-speed" type="number" min="100" value="${SETTINGS.SCAN_INTERVAL_MS}">
            </div>
            <label class="ufm-check">
                <input id="ufm-pickup" type="checkbox" ${SETTINGS.ENABLE_PICKUP_FILTER ? 'checked' : ''}> Pickup Filter
            </label>
            <label class="ufm-check">
                <input id="ufm-sound" type="checkbox" ${SETTINGS.SOUND_ALERT ? 'checked' : ''}> Sound Alert
            </label>
            <label class="ufm-check">
                <input id="ufm-notification" type="checkbox" ${SETTINGS.DESKTOP_NOTIFICATION ? 'checked' : ''}> Desktop Notification
            </label>
            <button id="ufm-toggle" class="ufm-main-button">TURN OFF</button>
            <button id="ufm-clear" class="ufm-secondary-button">CLEAR HIGHLIGHTS</button>
            <div id="ufm-result" class="ufm-result">Waiting for trips...</div>
        `;
        document.body.appendChild(panel);
        addStyles();
        bindPanelEvents();
    }

    // ================================================================
    // PANEL EVENTS
    // ================================================================
    function bindPanelEvents() {
        const toggle = document.getElementById('ufm-toggle');
        toggle.addEventListener('click', () => {
            monitorEnabled = !monitorEnabled;
            const status = document.getElementById('ufm-status');
            if (monitorEnabled) {
                status.textContent = 'ON';
                toggle.textContent = 'TURN OFF';
                updatePanel('Monitor enabled');
                restartScanner();
            } else {
                status.textContent = 'OFF';
                toggle.textContent = 'TURN ON';
                updatePanel('Monitor paused');
                stopScanner();
            }
        });

        document.getElementById('ufm-minfare').addEventListener('change', event => {
            SETTINGS.MIN_FARE = Math.max(0, Number(event.target.value) || 0);
        });
        document.getElementById('ufm-maxfare').addEventListener('change', event => {
            SETTINGS.MAX_FARE = Math.max(SETTINGS.MIN_FARE, Number(event.target.value) || 50000);
        });
        document.getElementById('ufm-maxdistance').addEventListener('change', event => {
            SETTINGS.MAX_DISTANCE_KM = Math.max(0, Number(event.target.value) || 80);
        });
        document.getElementById('ufm-speed').addEventListener('change', event => {
            SETTINGS.SCAN_INTERVAL_MS = Math.max(100, Number(event.target.value) || 250);
            restartScanner();
        });
        document.getElementById('ufm-pickup').addEventListener('change', event => {
            SETTINGS.ENABLE_PICKUP_FILTER = event.target.checked;
        });
        document.getElementById('ufm-sound').addEventListener('change', event => {
            SETTINGS.SOUND_ALERT = event.target.checked;
        });
        document.getElementById('ufm-notification').addEventListener('change', event => {
            SETTINGS.DESKTOP_NOTIFICATION = event.target.checked;
        });
        document.getElementById('ufm-clear').addEventListener('click', clearHighlights);
    }

    // ================================================================
    // CLEAR HIGHLIGHTS
    // ================================================================
    function clearHighlights() {
        document.querySelectorAll('[data-ufm-match="true"]').forEach(element => {
            element.style.outline = '';
            element.style.outlineOffset = '';
            element.style.background = '';
            delete element.dataset.ufmMatch;
        });
        updatePanel('Highlights cleared');
    }

    // ================================================================
    // PANEL UPDATE
    // ================================================================
    function updatePanel(message) {
        const result = document.getElementById('ufm-result');
        if (!result) return;
        result.innerHTML = message;
    }

    // ================================================================
    // SCAN
    // ================================================================
    function scanTrips() {
        if (!monitorEnabled) return;
        scanCount++;

        const containers = getTripContainers();
        let matchesThisScan = 0;

        containers.forEach(element => {
            const trip = checkTrip(element);
            if (trip) {
                matchesThisScan++;
                processMatch(trip);
            }
        });

        if (matchesThisScan === 0 && !document.getElementById('ufm-match')) {
            updatePanel(
                `Scanning...<br>` +
                `Trips checked: ${containers.length}<br>` +
                `Minimum: ₹${SETTINGS.MIN_FARE.toLocaleString('en-IN')}<br>` +
                `Matches: ${matchCount}`
            );
        }

        cleanupDuplicates();
    }

    // ================================================================
    // DUPLICATE CLEANUP
    // ================================================================
    function cleanupDuplicates() {
        const now = Date.now();
        for (const [signature, timestamp] of alertedTrips) {
            if (now - timestamp > SETTINGS.DUPLICATE_TIMEOUT_MS) {
                alertedTrips.delete(signature);
            }
        }
    }

    // ================================================================
    // START / STOP SCANNER
    // ================================================================
    function restartScanner() {
        stopScanner();
        if (!monitorEnabled) return;
        scannerTimer = setInterval(scanTrips, SETTINGS.SCAN_INTERVAL_MS);
        scanTrips();
    }

    function stopScanner() {
        if (scannerTimer) {
            clearInterval(scannerTimer);
            scannerTimer = null;
        }
    }

    // ================================================================
    // MUTATION OBSERVER (Fixed Loop Guard)
    // ================================================================
    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(mutations => {
            if (!monitorEnabled) return;

            let shouldScan = false;
            for (const mutation of mutations) {
                // Ignore DOM changes produced by the script's own UI elements
                const target = mutation.target;
                if (
                    target.id === 'ufm-panel' ||
                    target.id === 'ufm-match' ||
                    target.closest('#ufm-panel') ||
                    target.closest('#ufm-match')
                ) {
                    continue;
                }

                if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                    shouldScan = true;
                    break;
                }
            }

            // Debounce observer callbacks to avoid over-scanning during rapid updates
            if (shouldScan) {
                clearTimeout(observerDebounceTimer);
                observerDebounceTimer = setTimeout(() => {
                    scanTrips();
                }, 300);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ================================================================
    // STYLES
    // ================================================================
    function addStyles() {
        if (document.getElementById('ufm-styles')) return;

        const style = document.createElement('style');
        style.id = 'ufm-styles';
        style.textContent = `
            #ufm-panel {
                position: fixed; top: 80px; right: 20px; width: 300px; z-index: 999999;
                background: #111; color: #fff; padding: 16px; border-radius: 14px;
                font-family: Arial, sans-serif; box-shadow: 0 8px 35px rgba(0,0,0,.45);
                box-sizing: border-box;
            }
            .ufm-header { font-size: 18px; font-weight: 700; margin-bottom: 10px; }
            .ufm-version { float: right; font-size: 11px; opacity: .6; }
            .ufm-status { font-size: 13px; margin-bottom: 12px; }
            #ufm-status { font-weight: 700; }
            .ufm-field { margin: 8px 0; }
            .ufm-field label { display: block; font-size: 12px; margin-bottom: 4px; }
            .ufm-field input { width: 100%; box-sizing: border-box; padding: 7px; border-radius: 6px; border: 1px solid #555; background: #222; color: #fff; }
            .ufm-check { display: block; font-size: 13px; margin: 8px 0; }
            .ufm-main-button, .ufm-secondary-button { width: 100%; padding: 10px; margin-top: 8px; border: 0; border-radius: 7px; cursor: pointer; font-weight: 700; }
            .ufm-secondary-button { background: #333; color: #fff; }
            .ufm-result { margin-top: 12px; padding: 10px; border-radius: 7px; background: #222; font-size: 12px; line-height: 1.5; }
            #ufm-match {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 370px; max-width: 90vw; z-index: 1000000; padding: 25px;
                background: #111; color: #fff; border-radius: 16px; text-align: center;
                font-family: Arial, sans-serif; box-shadow: 0 15px 60px rgba(0,0,0,.7);
            }
            .ufm-popup-title { font-size: 21px; font-weight: 700; }
            .ufm-popup-fare { font-size: 38px; font-weight: 700; margin: 18px 0; }
            .ufm-popup-info { margin: 8px 0; font-size: 14px; }
            #ufm-open-trip { width: 100%; padding: 14px; margin-top: 18px; border: 0; border-radius: 8px; cursor: pointer; font-size: 17px; font-weight: 700; }
            #ufm-close-match { margin-top: 10px; padding: 8px 20px; border-radius: 6px; border: 1px solid #555; background: #222; color: #fff; cursor: pointer; }
        `;
        document.head.appendChild(style);
    }

    // ================================================================
    // INITIALIZE
    // ================================================================
    function initialize() {
        createPanel();
        startObserver();
        restartScanner();
        console.log('🚕 Uber Fleet Monitor V2.0 started');
    }

    setTimeout(initialize, 1500);
})();