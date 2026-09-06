/**
 * Which language a request is answered in, decided as a pure function.
 *
 * ## Why this is not `app/[lang]/`
 *
 * A locale segment in the URL is what most Next.js i18n guides reach for, and it is
 * refused here for a reason that is written into the spec's "Never" list: routes in
 * this product are CONTRACT DATA. `SIGN_IN_PATHNAME` and `DATE_OF_BIRTH_PATHNAME`
 * live in `packages/contracts`, `apps/api` redirects to them, they are published in
 * the OpenAPI document, and `routes.test.ts` gates that each one names a directory
 * that really exists. `/en/khai-ngay-sinh` would still be a Vietnamese path, so the
 * trade would be a shareable link to a page whose URL is untranslated, bought with
 * three broken contract constants and forty-three broken navigations.
 *
 * So the locale is a property of the REQUEST, not of the address: a cookie the
 * person's own choice writes, and otherwise the `Accept-Language` their browser
 * already sends.
 *
 * ## The shape is `resolveThemeChoice`'s, deliberately
 *
 * `theme.ts` answers the same class of question — "a string from somewhere I do not
 * control means what?" — and the rule it fixes applies here without change: every
 * value that is not exactly one of the known ones falls back to the safe answer,
 * and the safe answer is never a crash and never a raw key on the screen.
 */

/** The two locales this product has. VI is first because VI is the default. */
export const LOCALES = ['vi', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * Vietnamese, and this is the only place that decision is spelled.
 *
 * It is the default AND the fallback: an unknown cookie, an unparseable header, a
 * language nobody here speaks all land on it, because the alternative — showing a
 * message key, or an empty string — is a broken screen rather than a wrong language.
 */
export const DEFAULT_LOCALE: Locale = 'vi';

/**
 * Where a chosen locale is remembered.
 *
 * Namespaced for the reason `THEME_STORAGE_KEY` gives about itself: cookies are per
 * ORIGIN, and a bare `locale` is the name every other script on a shared origin
 * reaches for.
 *
 * Nothing in the product WRITES this cookie yet — no language switch ships in this
 * story, and inventing one would be a screen nobody asked for. What ships is the
 * precedence: a value that is already there beats the browser's header, which is
 * what makes a remembered choice possible the day something records one.
 */
export const LOCALE_COOKIE_NAME = 'stuwith-locale';

/** Whether a string from a cookie, a header or a query is one of ours. */
export function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Bounds on a header a stranger controls.
 *
 * `Accept-Language` arrives from the network and can be any length with any number
 * of comma-separated entries. Neither bound changes an honest answer — a real
 * browser sends a handful of short tags — and both stop a pathological header from
 * turning locale resolution into work proportional to what somebody chose to send.
 */
const MAX_ACCEPT_LANGUAGE_LENGTH = 512;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;

/** One `en-GB;q=0.8` entry, once it has been split apart. */
interface LanguageRange {
  readonly tag: string;
  readonly quality: number;
}

/**
 * The header's entries, cut at a COMMA rather than at a character count.
 *
 * The first version was `acceptLanguage.slice(0, MAX)`, which cuts wherever byte 512
 * happens to land — possibly in the middle of a tag, and possibly in the middle of a
 * `q=`. Both truncations are silently wrong rather than loudly wrong: `…,en;q=0.9`
 * cut after `q=0.` leaves `q=0`, which RFC 9110 defines as "not acceptable", so a
 * long header would DROP a language the visitor explicitly asked for. `en-G` is the
 * milder version of the same mistake.
 *
 * Cutting back to the last complete entry means a truncated header answers with a
 * PREFIX of what the browser sent, which is the only truncation that cannot invent
 * a preference nobody expressed. A header with no comma at all inside the window is
 * dropped whole, for the same reason.
 */
function boundedEntries(acceptLanguage: string): string[] {
  if (acceptLanguage.length <= MAX_ACCEPT_LANGUAGE_LENGTH) {
    return acceptLanguage.split(',');
  }
  const window = acceptLanguage.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH);
  const lastComma = window.lastIndexOf(',');
  return lastComma === -1 ? [] : window.slice(0, lastComma).split(',');
}

/**
 * `q=` as RFC 9110 defines it, and everything it can be instead.
 *
 * A missing parameter means `1`. A parameter that is not a number, or is out of
 * range, is treated as absent rather than as zero — reading `q=banana` as "never
 * offer me this language" would be inventing a refusal nobody expressed. `q=0`
 * really does mean "not acceptable", and is the one value that drops an entry.
 *
 * **An EMPTY value is the case that broke that rule, and it is the reason for the
 * first line of the body.** `Number('')` is `0`, not `NaN` — so `en;q=` sailed
 * through `Number.isFinite(0) && 0 >= 0 && 0 <= 1` and came out as an explicit
 * refusal of English, which is the exact inversion the paragraph above forbids.
 * Measured: `resolveLocale(null, 'en;q=')` answered Vietnamese. `q=banana` was
 * always right (`NaN` fails `isFinite`); the one malformed spelling that behaves
 * backwards under `Number` is the empty string, and the same is true of
 * `q=   `, `q=\t` and every other run of whitespace.
 */
function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, raw] = parameter.split('=', 2);
    if (name?.trim().toLowerCase() !== 'q') {
      continue;
    }
    const value = raw?.trim() ?? '';
    if (value.length === 0) {
      // `Number('')` is `0`. Absent, not refused.
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  return 1;
}

/**
 * The locale the browser asked for, or `null` when it asked for nothing we speak.
 *
 * Private on purpose: "what did the header say" is never the whole answer, because
 * a cookie outranks it. {@link resolveLocale} is the only way in, so there is no
 * second reading of the same request for the two to disagree about.
 *
 * Matching is on the PRIMARY SUBTAG — `en-US`, `en-GB` and `en` are all English —
 * which is the whole of what a two-locale product can act on. `*` is ignored rather
 * than treated as a match: it means "anything", and the answer to that is already
 * the default.
 */
function preferredLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (typeof acceptLanguage !== 'string' || acceptLanguage.length === 0) {
    return null;
  }

  const ranges: LanguageRange[] = [];
  for (const entry of boundedEntries(acceptLanguage)) {
    if (ranges.length >= MAX_ACCEPT_LANGUAGE_ENTRIES) {
      break;
    }
    const [head, ...parameters] = entry.split(';');
    const tag = (head ?? '').trim().toLowerCase();
    if (tag.length === 0) {
      continue;
    }
    ranges.push({ tag, quality: qualityOf(parameters) });
  }

  /**
   * Sorted by quality, and `sort` is stable in every engine this runs on — so two
   * languages the browser offered at the same weight keep the order it wrote them
   * in, which is the order it meant.
   */
  const ordered = [...ranges].sort((left, right) => right.quality - left.quality);
  for (const range of ordered) {
    if (range.quality === 0) {
      continue;
    }
    const primary = range.tag.split('-')[0] ?? '';
    if (isLocale(primary)) {
      return primary;
    }
  }
  return null;
}

/**
 * The locale for one request: the cookie if it holds one of ours, then the header,
 * then Vietnamese.
 *
 * A cookie carrying anything else — `''`, `fr`, `../../etc`, a whole sentence — is
 * DROPPED rather than repaired, and that matters beyond tidiness: the answer is
 * written into `<html lang>`, so a value that travelled through would put attacker
 * text into an attribute of the document element. The type guard is what makes that
 * impossible: only the two literals in {@link LOCALES} can ever come out of here.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookieValue)) {
    return cookieValue;
  }
  return preferredLocale(acceptLanguage) ?? DEFAULT_LOCALE;
}
