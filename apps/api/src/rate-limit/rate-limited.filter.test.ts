import type { ArgumentsHost } from '@nestjs/common';
import {
  RATE_LIMITED_MESSAGE,
  SIGN_IN_OUTCOME_QUERY_PARAM,
  SIGN_IN_RETRY_AFTER_QUERY_PARAM,
  errorEnvelopeSchema,
} from '@stuwith/contracts';
import type { ApiEnv } from '@stuwith/config';
import { describe, expect, it } from 'vitest';
import { RateLimitedFilter } from './rate-limited.filter';
import { RateLimitedException } from './rate-limited.exception';

/**
 * The two shapes a refusal comes back in, asserted directly.
 *
 * `rate-limit.flow.test.ts` drives both through real HTTP, which is the stronger
 * test and the slower one. This file exists for the cases that are awkward to
 * provoke over the wire — a channel value, an unfiltered fallback — and to make
 * the mapping readable in one place.
 */

const CONFIG = { WEB_BASE_URL: 'https://stuwith.example' } as unknown as ApiEnv;

interface Recorded {
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

function replyHost(): { recorded: Recorded; host: ArgumentsHost } {
  const recorded: Recorded = { headers: {} };
  const reply = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    header(name: string, value: string) {
      recorded.headers[name] = value;
      return reply;
    },
    send(body?: unknown) {
      recorded.body = body;
      return reply;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  return { recorded, host };
}

describe('the browser leg', () => {
  it('redirects to the login page carrying the locked code and the seconds', () => {
    const { recorded, host } = replyHost();

    new RateLimitedFilter(CONFIG).catch(new RateLimitedException('browser', 42), host);

    // 303 for the same reason `failedSignIn` uses it: Apple delivers its callback
    // as a cross-site form POST, and 302 in answer to a POST formally means
    // "repeat this request over there".
    expect(recorded.status).toBe(303);

    const location = new URL(recorded.headers['location'] ?? '');
    expect(location.origin).toBe('https://stuwith.example');
    expect(location.pathname).toBe('/dang-nhap');
    expect(location.searchParams.get(SIGN_IN_OUTCOME_QUERY_PARAM)).toBe('bi-khoa');
    expect(location.searchParams.get(SIGN_IN_RETRY_AFTER_QUERY_PARAM)).toBe('42');
    // The two parameters and nothing else. An extra one is how a diagnostic
    // detail gets smuggled to the client "just for debugging".
    expect([...location.searchParams.keys()].sort()).toEqual([
      SIGN_IN_RETRY_AFTER_QUERY_PARAM,
      SIGN_IN_OUTCOME_QUERY_PARAM,
    ].sort());
  });

  it('sends Retry-After on the redirect too, for anything that is not a browser', () => {
    const { recorded, host } = replyHost();

    new RateLimitedFilter(CONFIG).catch(new RateLimitedException('browser', 42), host);

    expect(recorded.headers['retry-after']).toBe('42');
  });

  it('sends no body — the page is the message', () => {
    const { recorded, host } = replyHost();

    new RateLimitedFilter(CONFIG).catch(new RateLimitedException('browser', 42), host);

    expect(recorded.body).toBeUndefined();
  });
});

describe('the json leg', () => {
  it('answers 429 with the shared envelope and the countdown', () => {
    const { recorded, host } = replyHost();

    new RateLimitedFilter(CONFIG).catch(new RateLimitedException('json', 17), host);

    expect(recorded.status).toBe(429);
    expect(recorded.headers['retry-after']).toBe('17');

    const body = errorEnvelopeSchema.parse(recorded.body);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toBe(RATE_LIMITED_MESSAGE);
    // A number, not a string: `detailValueSchema` accepts one, so a client does
    // not have to parse it back out.
    expect(body.error.details?.['retry_after_seconds']).toBe(17);
  });

  it('sends exactly the frozen sentence, and no other field', () => {
    // Equality with the constant rather than a hand-kept blacklist: what that
    // sentence may contain is decided once, in `contracts.test.ts`, beside the
    // constant. Three divergent lists meant a word added to one left the rest
    // blind.
    const { recorded, host } = replyHost();

    new RateLimitedFilter(CONFIG).catch(new RateLimitedException('json', 17), host);

    const body = errorEnvelopeSchema.parse(recorded.body);
    expect(body.error.message).toBe(RATE_LIMITED_MESSAGE);
    expect(Object.keys(body.error.details ?? {})).toEqual(['retry_after_seconds']);
  });
});

describe('the exception on its own', () => {
  /**
   * The filter normally replaces this body — and "normally" is doing work. If the
   * filter is ever unregistered, reordered, or shadowed by another `@Catch()`,
   * Nest's default handler serialises what the exception carries. A bare string
   * there produced `{"message":"rate_limited",…}`, which does not validate against
   * `errorEnvelopeSchema`, so a client would fail to parse an answer it is
   * expected to handle.
   */
  it('carries a valid envelope as its un-filtered fallback', () => {
    const response = new RateLimitedException('json', 9).getResponse();

    const body = errorEnvelopeSchema.parse(response);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details?.['retry_after_seconds']).toBe(9);
  });

  it('is a 429 whatever channel it carries', () => {
    expect(new RateLimitedException('browser', 9).getStatus()).toBe(429);
    expect(new RateLimitedException('json', 9).getStatus()).toBe(429);
  });
});
