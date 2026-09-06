/**
 * Response headers a BROWSER is allowed to read, named once for every process
 * that has to agree about them.
 *
 * ## Why this list is a contract and not an `apps/api` detail
 *
 * `apps/web` and `apps/api` are two origins. A cross-origin response carries every
 * header the server sent, but the browser hands JavaScript only the CORS-safelisted
 * ones plus whatever `Access-Control-Expose-Headers` names — silently. There is no
 * error, no warning: `response.headers.get('retry-after')` simply returns `null`,
 * exactly as it would if the server had never sent the header at all.
 *
 * That is what shipped through all of Epic 1. `exposedHeaders` listed
 * `x-request-id` and nothing else, while `rate-limited.filter.ts` set `Retry-After`
 * on every `429`. Measured in Chromium against the real API:
 * `{"status":429,"retryAfter":null,"visibleHeaders":["content-length","content-type"]}`.
 * Three call sites in `apps/web` read that header, all three got `null`, the
 * screens rendered the generic "try again later" copy instead of the countdown,
 * and — because `disabled={retryAfterSeconds !== null}` — the retry button stayed
 * ENABLED for the whole lockout. The immediate-retry loop the rate limit exists to
 * break, reintroduced by an omission in a list.
 *
 * No suite could see it, because every suite watched one end of the seam:
 * `apps/api`'s flow tests use Node's `fetch`, which ignores CORS entirely; the web
 * unit tests pass the header string in by hand; and the E2E fake API mirrored the
 * omission by not sending `Access-Control-Expose-Headers` at all. Three green
 * suites, one broken product. So the fix is not another assertion at one end — it
 * is this array, which both ends and the fake now read, plus the scanner in
 * `tests/gates/cors-exposed-headers.test.ts` that fails when a fourth header is set
 * on a response without a decision being recorded here.
 *
 * It lives in `packages/contracts` because that is where the wire vocabulary lives
 * (AD-13), and because `apps/web` may import nothing else from the workspace.
 */

/** Correlation id, echoed on every response so a caller can quote it in a ticket. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Seconds to wait after a `429`. Always a delay, never an HTTP date. */
export const RETRY_AFTER_HEADER = 'retry-after';

/**
 * The `Access-Control-Expose-Headers` value, as data.
 *
 * Lower-case throughout: header names are case-insensitive on the wire, and
 * `Headers.get` lower-cases its argument, but a list that mixes spellings invites
 * the comparison that fails on case — the failure class `LOG_REDACT_PATHS` was
 * patched for twice in Story 1.5 before Story 1.7 removed the shape entirely.
 *
 * Adding an entry here is a decision that the header is safe for any page on
 * `WEB_BASE_URL` to read. It must never carry a secret, a session identifier, or
 * anything derived from one.
 */
export const BROWSER_READABLE_RESPONSE_HEADERS = [
  REQUEST_ID_HEADER,
  RETRY_AFTER_HEADER,
] as const;

export type BrowserReadableResponseHeader = (typeof BROWSER_READABLE_RESPONSE_HEADERS)[number];

/**
 * Response headers `apps/api` sets that a browser must NOT be handed, declared so
 * the scanner can tell "decided against" apart from "nobody looked".
 *
 * An empty carve-out would make the gate unfalsifiable in the other direction: the
 * first genuinely server-only header someone adds would have no place to go except
 * the exposed list, which is the wrong answer arrived at by the path of least
 * resistance.
 */
export const SERVER_ONLY_RESPONSE_HEADERS = [
  // Set by the OAuth legs and by `rate-limited.filter.ts` on the browser channel.
  // A cross-origin `303` is followed by the browser itself; script never needs the
  // target, and exposing it would leak the `?ket-qua=` outcome of a login attempt
  // to any page that can fetch this origin.
  'location',
  // `Set-Cookie` is on the fetch spec's forbidden-response-header list: it can
  // never be exposed, whatever this array says. Named anyway so a reader does not
  // have to wonder whether it was forgotten.
  'set-cookie',
  // Content negotiation and framing. CORS-safelisted or irrelevant to script.
  'content-type',
  'content-length',
  'cache-control',
  'vary',
] as const;
