// ==UserScript==
// @name         Uber Portal - Tab Switcher Only (Smart Timer)
// @namespace    http://tampermonkey.net
// @version      15.0
// @description  Loops between Announcements and Trip Management tabs safely. 2s on Inbox, Custom minutes on Trip page. No URL changes.
// @match        https://fleethub.uber.com/orgs/72d16431-d9c5-4c64-8d65-325a65461b91/trip-reservation-offer
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // ⚙️ यहाँ अपनी मर्ज़ी से मिनट बदलें (CHANGE MINUTES HERE):
    // =========================================================================
    const TRIP_MANAGEMENT_SECONDS = 2;// <--- इस 30 को मिटाकर आप 20, 40 या 60 मिनट लिख सकते हैं

    let currentTab = 0; // State track: 0 = Announcements click karna hai, 1 = Trip Management click karna hai

    function simulateHumanClick(element) {
        if (!element) return;
        element.click();
        const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(evtType => {
            const ev = new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window });
            element.dispatchEvent(ev);
        });
    }

    function clickNextTab() {
        const elements = Array.from(document.querySelectorAll('div, span, a, p, li, button, [role="tab"]'));
        let targetElement = null;
        let nextDelay = 1000; // डिफ़ॉल्ट एनाउंसमेंट का टाइम (2 सेकंड)

        if (currentTab === 0) {
            // ए. स्क्रीन पर "Inbox" टेक्स्ट वाला असली बटन ढूंढो और क्लिक करो
            for (let el of elements) {
                if (el.textContent.trim() === 'Announcements') {
                    targetElement = el;
                    break;
                }
            }
            if (targetElement) {
                console.log("[GTI Timer] 👉 Clicking Inbox...");
                simulateHumanClick(targetElement);
                currentTab = 10; // अगली बार Trip Management पर क्लिक करने के लिए सेट करें
                nextDelay = 1000; // एनाउंसमेंट पर सिर्फ 2 सेकंड का होल्ड लगेगा
            }
        } else {
            // बी. स्क्रीन पर "Trip Management" टेक्स्ट वाला असली बटन ढूंढो और क्लिक करो
            for (let el of elements) {
                if (el.textContent.trim() === 'Trip Management') {
                    targetElement = el;
                    break;
                }
            }
            if (targetElement) {
                console.log("[GTI Timer] 👉 Clicking Trip Management...");
                simulateHumanClick(targetElement);
                currentTab = 0; // अगली बार Announcements पर क्लिक करने के लिए सेट करें

                // ट्रिप मैनेजमेंट पर आने के बाद बोट आपके सेट किए हुए मिनटों तक रुका रहेगा
                nextDelay = TRIP_MANAGEMENT_SECONDS * 2 * 1000;
            }
        }

        // अगले टैब स्विच का टाइमर सेट करना
        setTimeout(clickNextTab, nextDelay);
    }

    // पहली बार टैब स्विचिंग 3 सेकंड बाद शुरू करें
    setTimeout(clickNextTab, 1000);

})();