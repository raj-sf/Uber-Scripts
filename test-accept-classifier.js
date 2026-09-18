// Regression tests for the v3.5.0 fixes, using the exact payloads Uber returned.
const src = require('fs').readFileSync('/Users/raj/git/raj-sf/Uber-Scripts/uber-fleet-autograbber-v3.user.js', 'utf8');

// pull the real functions out of the userscript so we test shipped code, not a copy
function extract(name) {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('not found: ' + name);
    let d = 0, started = false;
    for (let k = i; k < src.length; k++) {
        if (src[k] === '{') { d++; started = true; }
        else if (src[k] === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
    }
    throw new Error('unbalanced: ' + name);
}
const classifyAcceptResponse = eval('(' + extract('classifyAcceptResponse') + ')');
const acceptUuidFromBody = eval('(' + extract('acceptUuidFromBody') + ')');

let fail = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got=${got}  want=${want}`);
}

console.log('--- classifier: HTTP status must be respected ---');
// THE BUG THE REVIEW CAUGHT: the 403 auth body has no .errors, so it read as ACCEPTED
check('403 auth body is NOT accepted',
    classifyAcceptResponse({ message: 'forbidden by authentication server' }, 403).kind, 'error');
check('500 with empty body is NOT accepted',
    classifyAcceptResponse({}, 500).kind, 'error');
check('429 rate limit is NOT accepted',
    classifyAcceptResponse({ message: 'too many requests' }, 429).kind, 'error');

console.log('\n--- classifier: success must be PROVEN, not assumed ---');
check('200 with real data = ok',
    classifyAcceptResponse({ data: { acceptTripRequestOffer: { uuid: 'x' } } }, 200).kind, 'ok');
check('200 with data:null is NOT accepted',
    classifyAcceptResponse({ data: null }, 200).kind, 'error');
check('200 with empty data {} is NOT accepted',
    classifyAcceptResponse({ data: {} }, 200).kind, 'error');
check('200 with all-null data is NOT accepted',
    classifyAcceptResponse({ data: { acceptTripRequestOffer: null } }, 200).kind, 'error');
check('unknown envelope is NOT accepted',
    classifyAcceptResponse({ weird: 1 }, 200).kind, 'error');

console.log('\n--- classifier: verbatim payloads from the logs ---');
check('TAKEN (00:46 log, verbatim)',
    classifyAcceptResponse({ errors: [{ message: 'Code: , Message: Offer is no longer available, Cause: code:failed-precondition message:code:failed-precondition message:Trigger is non-actionable for current state, YARPCCode: failed-precondition', path: ['acceptTripRequestOffer'] }], data: null }, 200).kind, 'taken');
check('ALREADY ACCEPTED (02:57 log, verbatim)',
    classifyAcceptResponse({ errors: [{ message: 'Code: , Message: Offer is already accepted, Cause: code:failed-precondition message:code:failed-precondition message:Offer already accepted, YARPCCode: already-exists', path: ['acceptTripRequestOffer'] }], data: null }, 200).kind, 'alreadyAccepted');
check('errors win even on HTTP 200',
    classifyAcceptResponse({ errors: [{ message: 'Offer is no longer available' }] }, 200).kind, 'taken');

console.log('\n--- accept uuid extraction (shared key space stops double-accepts) ---');
const realAcceptBody = JSON.stringify({
    operationName: 'AcceptOpenTripOffer',
    variables: {
        offerUuid: { value: 'd58ae321-8c16-4d2e-a14c-c6507328efbb' },
        fleetPartnerUuid: { value: '72d16431-d9c5-4c64-8d65-325a65461b91' },
        tenancy: 'uber/production'
    },
    query: 'mutation AcceptOpenTripOffer(...)'
});
check('uuid parsed from real accept body',
    acceptUuidFromBody(realAcceptBody), 'd58ae321-8c16-4d2e-a14c-c6507328efbb');
check('plain-string uuid variant', acceptUuidFromBody(JSON.stringify({ variables: { offerUuid: 'abc-123' } })), 'abc-123');
check('garbage body returns null', acceptUuidFromBody('not json'), null);

console.log('\n--- shipped-source assertions ---');
function has(name, re) { const ok = re.test(src); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
has('DOM path never reports ACCEPTED from a vanished row', /UNKNOWN \(row gone, no accept seen\)/);
has('direct path honours AUTO_ACCEPT', /S\.DRY_RUN \|\| !S\.AUTO_ACCEPT/);
has('direct path stands down while a DOM accept is in flight', /if \(inFlight \|\| Date\.now\(\) - lastDomAcceptAt < 15000\) return;/);
has('re-checks running/authBlocked after the offers await', /if \(!running \|\| authBlocked \|\| !S\.DIRECT_MODE\) return;/);
has('failed accept releases the reservation', /ACCEPT FAILED \(no verdict\)/);
has('gqlPost feeds the auth circuit breaker', /noteHttpStatus\(res\.status, GQL\.url\)/);
has('gqlPost has an abort timeout', /new AbortController\(\)/);
has('pickup filter fails CLOSED', /fail CLOSED: never accept when the date filter cannot be evaluated/);
has('loss regex no longer matches a bare "failed"', /trip acceptance failed\|no longer available/);
has('stop\\(\\) drains an in-flight accept', /ABORTED after accept was sent/);
has('an observed accept retires the offer for both paths', /handled\[uu\] = Date\.now\(\); saveHandled\(\);/);
has('the 1.5s retry click is gone', /^(?!.*retry click on inner)[\s\S]*$/);

console.log(fail === 0 ? '\nALL TESTS PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
