# Uber-Scripts

Tampermonkey userscripts for the Uber Fleet Supplier Portal (Trip Management page).

## Current

| File | What it does |
|---|---|
| `uber-fleet-autograbber-v3.user.js` | **Use this one.** **DIRECT API mode (v3.3.0):** learns Uber's own GraphQL calls (`GetInProgressTripReservationOffers` / `AcceptOpenTripOffer`) and accepts straight over the API, skipping the DOM entirely. Falls back to clicking until the templates are learned. Scans Trip Management, reads the Fare column exactly, filters by pickup date (skip today, or a from/to window, IST), auto-accepts trips inside the configured fare range, confirms only the dialog it opened, keeps the request list fresh by toggling Announcements/Trip Management, keeps running in a background tab (Web Worker timer + inaudible keep-alive tone), logs every accept (CSV export). Panel with min/max fare, optional city filter, intervals, sound, dry run. |

### Install
1. Tampermonkey > Create a new script > paste the file > save.
2. Open `https://fleethub.uber.com/orgs/<org>/trip-reservation-offer`.
3. Press **START** on the panel (a click is required so the browser allows audio).
4. Optional: tick **DRY RUN** first (highlights and logs, never clicks) to watch a few requests; untick it to go live. Dry-run matches are memory-only and become eligible the moment you untick.
5. Remove the older scripts below from Tampermonkey so they do not fight over the same buttons.

Sounds: two rising tones = accepted. Continuous beep = a match needs a human (alert-only mode, dry run, or an accept that timed out); ACKNOWLEDGE stops it. No sound on tab switches.

## Archive (superseded by V3)

| File | Notes |
|---|---|
| `archive/trip-monitor-v2.0.1.user.js` | Alert-only monitor (fare/distance/pickup filters, popup, sound, notification). No accept, no list refresh. |
| `archive/sudarsan-tab-switcher-grabber-v21.user.js` | Sudarsan's grabber: clicks Accept when a number in the row is >= minimum and auto-clicks any Confirm. Its pushState tab switch has broken URLs and never worked. Fare parse takes the first rupee figure in the row, which caused under-threshold accepts. |
| `archive/sudarsan-tab-switcher-only-v15.user.js` | Sudarsan's tab toggler (Announcements <-> Trip Management) used to make the list refetch without a reload. V3 reuses this approach. |
| `archive/auto-acceptor-2026-08-25.user.js` | First auto-acceptor (city + min price, page reload every 3 s). |

## Notes
- Selectors come from the scripts that worked on the portal: Accept = `button[data-testid="trip-reservation-table-action-button"]`, confirm buttons = `button[data-baseweb="button"]` inside a modal.
- If V3 logs `TIMEOUT` on a match, the confirm dialog or Accept button markup changed; nothing is clicked in that case.

## Why DOM clicking loses trips (measured 2026-09-18)

Captured from Uber's own API during a failed accept:

```
POST /graphql  AcceptOpenTripOffer
  -> {"errors":[{"message":"Offer is no longer available,
       Cause: failed-precondition ... Trigger is non-actionable for current state"}]}
```

The offer list query (`GetInProgressTripReservationOffers`) took **1485 ms** to return.
So the table on screen is already >1.5 s stale before a human or a DOM clicker ever sees it.
By the time a click walks through React and reaches the server, the offer is gone.

Direct API mode removes that whole chain: poll the offers query, and the moment a matching
offer appears in the JSON, fire `AcceptOpenTripOffer` with its uuid. No render, no stale row,
no tab toggling.
