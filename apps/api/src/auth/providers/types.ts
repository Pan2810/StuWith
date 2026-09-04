import type { AuthProvider } from '@stuwith/contracts';
import type { ProviderIdentity } from '@stuwith/domain';

/**
 * One interface, four providers. `apps/api`'s service layer knows nothing about
 * OIDC discovery, Graph API versions or Apple's signed client secret — only that a
 * provider can produce an authorization URL and, given a code, a normalised
 * identity.
 */

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface CallbackExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

export interface ProviderAdapter {
  readonly provider: AuthProvider;
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  identityFromCallback(exchange: CallbackExchange): Promise<ProviderIdentity>;
}

/**
 * Anything that went wrong between here and the provider.
 *
 * It exists so the service has ONE thing to catch, and so that the provider's own
 * error body has somewhere to die. The message is for the server log; the client
 * gets the standard `unauthenticated` envelope with no provider name and no
 * provider error code in it — `errorEnvelopeSchema` refuses a `provider_error`
 * key outright, and this type is what stops one being assembled in the first place.
 */
export class ProviderExchangeError extends Error {
  override readonly name = 'ProviderExchangeError';

  constructor(
    message: string,
    readonly provider: AuthProvider,
    /**
     * Whether the provider ANSWERED and refused SOMETHING THE CALLER SENT, as
     * opposed to being unreachable, slow, broken, or refusing US.
     *
     * The distinction decides whether a failed sign-in walks somebody towards a
     * brute-force lock, so it has to separate three things a plain "4xx" runs
     * together:
     *
     * - `400` / `404` — the provider rejecting the `code`, the verifier or the
     *   redirect the caller supplied. That is exactly what an attacker submitting
     *   guessed codes against one stolen `state` cookie produces, and it is the
     *   natural attack on `/callback`. It counts.
     * - `401` / `403` / `429` — the provider rejecting OUR credential or OUR
     *   quota. `invalid_client` means our client secret is wrong or expired;
     *   Apple's is rotated every six months. Counting it means that on the day the
     *   secret expires every visitor's attempts fail and every visitor is then
     *   locked out for fifteen minutes — a configuration mistake of ours turned
     *   into an outage with a security-shaped explanation.
     * - a timeout, a `5xx` or unparseable JSON — the provider having a bad
     *   afternoon, which would lock out everybody who tried during it.
     *
     * Only the first is somebody's own doing, so only the first is `true`. The
     * other two travel as `provider_exchange_failed`, which is on the innocent
     * list.
     */
    readonly refusedByProvider = false,
  ) {
    super(message);
  }
}

/**
 * The injected `fetch`. Production passes Node's global; the flow tests pass one
 * that routes to an in-process authorization server.
 *
 * Injecting it is what makes an end-to-end test of this flow possible at all
 * without a real Google credential — and it costs one parameter.
 */
export type FetchLike = typeof fetch;

/**
 * How long any single call to a provider may take.
 *
 * Without a deadline, a provider that accepts the TCP connection and then never
 * answers holds a Fastify connection AND a `pg` pool slot open indefinitely — so
 * one silently-degraded third party takes down endpoints that have nothing to do
 * with it. Five seconds is generous for a token exchange and short enough that a
 * hung provider surfaces as a failed login rather than as an outage.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * The provider statuses that mean "what the caller sent was refused", and
 * therefore the only ones that may count towards a brute-force lock.
 *
 * Exported so the classification is one list rather than a comparison repeated at
 * each call site — and so a test can read it.
 */
export const CALLER_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/** Small helper: a fetch that throws a ProviderExchangeError instead of a body. */
export async function fetchJson(
  fetchImpl: FetchLike,
  provider: AuthProvider,
  url: string,
  init: RequestInit | undefined,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      // A caller-supplied signal wins; nothing passes one today, and if something
      // ever does it will have a better reason than this default.
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      ...init,
    });
  } catch (error) {
    // A timeout arrives here as an AbortError and is a provider failure like any
    // other: the caller gets a refused sign-in with an audit row, not a 500.
    throw new ProviderExchangeError(`${what} request failed: ${String(error)}`, provider);
  }
  if (!response.ok) {
    // The body is deliberately NOT read into the error. A provider error body is
    // long, multi-line, and routinely contains the token or the code that was
    // rejected; putting it in an Error is how it reaches a log and then a ticket.
    //
    // Only 400 and 404 are "the provider refused what the CALLER sent" — a bad
    // `code`, a bad verifier, a redirect URI that is not registered. 401, 403 and
    // 429 are about US: an expired client secret, a disabled app, our own quota.
    // They used to fall in here with the rest of the 4xx range, so the day Apple's
    // six-monthly secret expired would have locked every user out for fifteen
    // minutes on top of nobody being able to sign in. See `refusedByProvider`.
    throw new ProviderExchangeError(
      `${what} returned HTTP ${response.status}`,
      provider,
      CALLER_REFUSED_STATUSES.has(response.status),
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new ProviderExchangeError(`${what} returned a body that is not JSON: ${String(error)}`, provider);
  }
}
