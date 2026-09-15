// ==UserScript==
// @name         Uber Fleet - Tab Switcher & Grabber (No Refresh)
// @namespace    http://tampermonkey.net
// @version      21.0
// @description  Switches between Inbox/Trip tabs every 2 seconds and grabs matching trips. No page reloads.
// @match        https://fleethub.uber.com/orgs/72d16431-d9c5-4c64-8d65-325a65461b91/trip-reservation-offer
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ====================================================================
    // ⚙️ यहाँ अपनी मर्ज़ी से सेटिंग्स बदलें (CHANGE SETTINGS HERE):
    // ====================================================================
    const MY_MINIMUM_PRICE = 3000// 💰 मिनिमम किराया (रु.)
    const MY_CLICK_SPEED = 80 // ⏱️ क्लिकर की स्पीड मिलीसेकंड में
    const TAB_SWITCH_SPEED = 1000; // 🔄 टैब बदलने की स्पीड (2 सेकंड)

    // ====================================================================
    // 🛠️ इसके नीचे कोड को बिल्कुल न छुएं (Don't change below code):
    // ====================================================================
    const TARGET_SELECTOR = 'button[data-testid="trip-reservation-table-action-button"], button._css-eTgiHo';
    const POPUP_SELECTOR = 'button[data-baseweb="button"]';

    // 🎵 ट्रिप मिलने पर बजने वाला साउंड
    function playAlertSound() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    const oscillator = audioCtx.createOscillator();
                    const gainNode = audioCtx.createGain();
                    oscillator.connect(gainNode);
                    gainNode.connect(audioCtx.destination);
                    oscillator.type = 'sine';
                    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
                    gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
                    oscillator.start();
                    oscillator.stop(audioCtx.currentTime + 0.3);
                }, i * 400);
            }
        } catch (e) { console.error("Sound error:", e); }
    }

    // 🖱️ क्लिक करने का फंक्शन
    function executeClick(element) {
        if (!element) return;
        element.click();
        const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(evtType => {
            const ev = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
            element.dispatchEvent(ev);
        });
    }

    // 🔄 बिना पेज रीलोड किए टैब बदलने का लॉजिक
    function flawlessTabSwitch() {
        // अगर स्क्रीन पर ट्रिप उठाने का बटन दिख रहा है, तो टैब चेंज रोक दें
        if (document.querySelector(TARGET_SELECTOR)) {
            console.log("⏳ Trip detected! Holding current view...");
            return;
        }

        const currentURL = window.location.href;
        const orgMatch = currentURL.match(/orgs\/([a-f0-9\-]+)/);

        if (!orgMatch) return;

        const orgId = orgMatch[1];
        const inboxURL = `https://uber.com{orgId}/inbox`;
        const tripsURL = `https://uber.com{orgId}/trip-reservation-offer`;

        if (currentURL.includes('trip-reservation-offer')) {
            console.log("🔄 Navigating safely to -> Inbox");
            window.history.pushState({}, '', inboxURL);
        } else {
            console.log("🔄 Navigating safely to -> Trip Management");
            window.history.pushState({}, '', tripsURL);
        }

        // Uber के React framework को फोर्स अपडेट भेजना ताकि डेटा लोड हो जाए
        window.dispatchEvent(new PopStateEvent('popstate'));
    }

    // 🟢 ट्रिप स्कैन करने और ग्रैब करने का अल्ट्रा-फास्ट फंक्शन
    function ultraFastScan() {
        const acceptButtons = document.querySelectorAll(TARGET_SELECTOR);

        if (acceptButtons.length > 0) {
            for (let i = 0; i < acceptButtons.length; i++) {
                const btn = acceptButtons[i];
                if (!(btn.offsetWidth > 0 && btn.offsetHeight > 0)) continue;

                const tripRow = btn.closest('tr._css-edURPB') || btn.closest('tr') || btn.parentElement;
                if (!tripRow) continue;

                const rowText = tripRow.textContent || "";
                let detectedPrice = 0;

                const rupeeMatch = rowText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                if (rupeeMatch) {
                    detectedPrice = parseFloat(rupeeMatch[1].replace(/,/g, ''));
                } else {
                    const allNumbers = rowText.match(/\d+(?:,\d+)*(?:\.\d+)?/g);
                    if (allNumbers) {
                        for (let j = 0; j < allNumbers.length; j++) {
                            const num = parseFloat(allNumbers[j].replace(/,/g, ''));
                            if (num >= 100 && num > detectedPrice) {
                                detectedPrice = num;
                            }
                        }
                    }
                }

                if (detectedPrice >= MY_MINIMUM_PRICE) {
                    console.log('🟢 Match Found! Price: ₹' + detectedPrice + ' - Clicking...');
                    executeClick(btn);
                    playAlertSound();
                    return;
                }
            }
        }

        // कन्फर्मेशन पॉपअप ऑटो-क्लिक (Confirm/Submit/Apply)
        const popups = document.querySelectorAll(POPUP_SELECTOR);
        for (let k = 0; k < popups.length; k++) {
            const popBtn = popups[k];
            const txt = popBtn.textContent ? popBtn.textContent.trim().toLowerCase() : "";
            if (txt === 'confirm' || txt.includes('confirm') || txt === 'submit' || txt === 'apply') {
                if (popBtn.offsetWidth > 0 && popBtn.offsetHeight > 0) {
                    executeClick(popBtn);
                    playAlertSound();
                    return;
                }
            }
        }
    }

    // 🚀 स्क्रिप्ट की शुरुआत (Initialization)
    setTimeout(() => {
        console.log("🚀 Uber Fleet Master Suite Active (No-Refresh & Fixed Sound).");
        setInterval(ultraFastScan, MY_CLICK_SPEED);
        setInterval(flawlessTabSwitch, TAB_SWITCH_SPEED);
    }, 1000);

})();