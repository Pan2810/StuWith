import { RATE_LIMITED_MESSAGE, type CurrentUser } from '@stuwith/contracts';
import { describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from './i18n/locale';
import { VI_TRANSLATE, translatorFor } from './i18n/messages';
import {
  PROFILE_UNAVAILABLE_KEY,
  profileLoadOutcome,
  unavailableMessageKey,
} from './profile-load';

/**
 * The ONE reading of a `/v1/auth/me` answer, executed.
 *
 * It used to be two: `/khai-ngay-sinh` had a five-state reading with a written
 * argument behind it — only `401` means signed out, everything else that is not a
 * usable `200` is `unavailable`, because a rate-limited visitor sent to the login
 * page spends another attempt per click — while `/dang-nhap` mapped a `200` carrying
 * an unparseable body to `signed-out` and offered four login links to somebody who
 * was already signed in, in a loop that signing in again cannot break.
 *
 * These examples are about the decision. What each screen RENDERS from it is
 * asserted where that screen lives.
 */
const user = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
  id: '019200f0-0000-7000-8000-000000000001',
  display_name: 'An Nguyen',
  avatar_url: null,
  role: 'user',
  ...overrides,
});

describe('profileLoadOutcome — one reading for every screen that asks', () => {
  it('reads a 200 with a profile as that profile', () => {
    expect(profileLoadOutcome(200, user({ profile_completed: true }), null)).toEqual({
      kind: 'profile',
      user: user({ profile_completed: true }),
    });
  });

  it('reads a 401, and ONLY a 401, as signed out', () => {
    expect(profileLoadOutcome(401, null, null)).toEqual({ kind: 'signed-out' });
  });

  /**
   * The case that produced the loop. A `200` means a session was accepted; a body
   * that will not parse means this product cannot read the profile behind it. Those
   * two facts together are not "nobody is signed in", and offering a login is an
   * instruction that cannot succeed.
   */
  it('does not call a 200 with an unreadable body "signed out"', () => {
    expect(profileLoadOutcome(200, null, null)).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: null,
    });
  });

  it.each([[0], [429], [403], [500], [502], [503]])(
    'reads %i as unavailable rather than as signed out',
    (status) => {
      expect(profileLoadOutcome(status, null, null).kind).toBe('unavailable');
    },
  );

  it('carries the wait through on a 429, which is the answer this state exists for', () => {
    expect(profileLoadOutcome(429, null, '45')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: 45,
    });
  });

  it('shows no clock for a header this product did not write', () => {
    // The same parser the sign-in page's URL parameter goes through: a nonsense or
    // absurd value becomes "no clock", never a number on the screen.
    for (const header of [null, '', 'soon', '-5', '0', '99999999', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      expect(profileLoadOutcome(429, null, header)).toEqual({
        kind: 'unavailable',
        retryAfterSeconds: null,
      });
    }
  });

  it('reads a wait only from a 429', () => {
    // A `Retry-After` on a 503 is a server hint about itself, not a rate-limit
    // budget; presenting it as "you have tried too many times" accuses somebody of
    // something they did not do.
    for (const status of [0, 500, 502, 503]) {
      expect(profileLoadOutcome(status, null, '45')).toEqual({
        kind: 'unavailable',
        retryAfterSeconds: null,
      });
    }
  });

  it('ignores a wait on the two answers that are not "unavailable"', () => {
    expect(profileLoadOutcome(401, null, '45')).toEqual({ kind: 'signed-out' });
    expect(profileLoadOutcome(200, user(), '45').kind).toBe('profile');
  });
});

describe('unavailableMessageKey — the sentence and the clock are one decision', () => {
  it('says "we could not read your profile" when there is no wait', () => {
    expect(unavailableMessageKey(null)).toBe(PROFILE_UNAVAILABLE_KEY);
  });

  it('says the rate-limit sentence when there is one', () => {
    // The sentence the countdown belongs beside, and the one both processes already
    // share for exactly this. Saying "thử lại sau ít phút" to somebody about to be
    // made to wait forty-five seconds is vaguer than the truth.
    // The KEY whose Vietnamese value the catalogue imports from the contract, so
    // the two processes still cannot come to say different things.
    expect(unavailableMessageKey(45)).toBe('error.rateLimited');
    expect(VI_TRANSLATE(unavailableMessageKey(45))).toBe(RATE_LIMITED_MESSAGE);
  });

  it('says nothing technical and nothing about logging in, in EITHER locale', () => {
    /**
     * The rule survived being translated, which is the half a single-locale check
     * could not ask about. "Do not tell a rate-limited visitor to go and log in" is
     * a claim about the WORDS somebody reads, so an English catalogue that quietly
     * said "please sign in again" would reopen the loop this reading exists to
     * break — in English only, invisibly to every existing assertion.
     */
    const technical = ['http', '429', 'api', 'fetch'];
    const signIn: Readonly<Record<Locale, string>> = { vi: 'đăng nhập', en: 'sign in' };

    for (const locale of LOCALES) {
      const t = translatorFor(locale);
      for (const message of [t(unavailableMessageKey(null)), t(unavailableMessageKey(45))]) {
        for (const leak of [...technical, signIn[locale]]) {
          expect(message.toLowerCase(), `${locale}: ${message}`).not.toContain(leak);
        }
        expect(message.length).toBeGreaterThan(20);
      }
    }
  });
});
