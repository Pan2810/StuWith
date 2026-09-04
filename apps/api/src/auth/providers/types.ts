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
    throw new ProviderExchangeError(`${what} returned HTTP ${response.status}`, provider);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new ProviderExchangeError(`${what} returned a body that is not JSON: ${String(error)}`, provider);
  }
}
