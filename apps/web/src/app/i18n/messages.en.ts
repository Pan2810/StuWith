/**
 * The English catalogue.
 *
 * ## Why this file imports nothing, not even the key type
 *
 * The obvious spelling is `export const EN_MESSAGES: Record<MessageKey, string>`,
 * importing `MessageKey` from `./messages`. That is a CYCLE — `messages.ts` has to
 * import this file to build the dictionary table — and `.dependency-cruiser.cjs`
 * runs with `tsPreCompilationDeps: true`, so an `import type` is an edge like any
 * other and `no-circular` fails the build. It is the right rule: a cycle here would
 * mean the two catalogues could only be understood together.
 *
 * The type check happens at the ONE place that already knows both, in `messages.ts`:
 *
 * ```ts
 * const DICTIONARIES: Readonly<Record<Locale, Dictionary>> = { vi: VI_MESSAGES, en: EN_MESSAGES };
 * ```
 *
 * `Dictionary` is `Record<MessageKey, string>` and `MessageKey` is derived from the
 * Vietnamese catalogue, so a key added to Vietnamese and forgotten here is a
 * `tsc` error that NAMES the missing key. That is the acceptance criterion, and it
 * is a property of the type system rather than of a test somebody has to run.
 *
 * The other direction — a key here that Vietnamese does not have — is not a type
 * error, because an imported constant is not a fresh object literal and excess
 * property checking does not apply to it. `tests/gates/i18n-catalogue.test.ts`
 * compares the two key sets for exactly that half.
 *
 * ## Length is a design constraint, not a detail
 *
 * `EXPERIENCE.md` records that Vietnamese runs 15-25% longer than English. The
 * consequence for THIS file is the reverse of the one people expect: every label
 * here is shorter than its Vietnamese twin, so a layout that fits English proves
 * nothing about the product's default language. `he-thiet-ke.spec.ts` measures
 * reflow at 320px and `ngon-ngu.spec.ts` does it in both locales.
 */
export const EN_MESSAGES = {
  'app.description': 'Live study rooms, anonymous whenever you need to be.',

  'home.frameReady': 'The project skeleton is up.',
  'home.contractVersion': 'API contract: {version}.',
  'home.signIn': 'Sign in',

  'theme.legend': 'Appearance',
  'theme.system': 'Follow the system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.applied.light': 'The light appearance is in use.',
  'theme.applied.dark': 'The dark appearance is in use.',

  /**
   * The only plural in the product, and the reason `Intl.PluralRules` is here at
   * all. English has two categories and Vietnamese has one, so the Vietnamese
   * catalogue carries the same sentence twice while this one carries two.
   */
  'countdown.retryIn.one': 'Retry in {seconds} second.',
  'countdown.retryIn.other': 'Retry in {seconds} seconds.',
  'countdown.done': 'You can try again now.',

  'signIn.heading': 'Sign in',
  'signIn.checkingSession': 'Checking your session…',
  'signIn.chooseProvider': 'Choose a social account to continue:',
  'signIn.providerDisabled':
    'A provider that is not enabled on this server answers “not found”.',
  'signIn.continueWith': 'Continue with {provider}',
  'signIn.signedInAs': 'Signed in: {name} (role: {role})',
  'signIn.declarePrompt':
    'Your profile is still missing a date of birth. Declare it to use every feature.',
  'signIn.declareLink': 'Declare a date of birth',
  'signIn.signOut': 'Sign out',
  'signIn.outcome.failed': 'Signing in did not work. Try again, or choose another way.',
  'signIn.outcome.cancelled':
    'You cancelled at the permission step. Choose a way to sign in below.',

  'sessionExpiry.title': 'Your session has ended',
  'sessionExpiry.message':
    'Sign in again to carry on from where you were. This page stays here in the meantime.',
  'sessionExpiry.dismiss': 'Later',

  'profile.unavailable': 'We could not read your profile. Please try again in a few minutes.',
  'profile.retry': 'Try again',

  'dateOfBirth.heading': 'Declare a date of birth',
  'dateOfBirth.label': 'Your date of birth',
  'dateOfBirth.hint': 'You declare it once, and cannot change it yourself afterwards.',
  'dateOfBirth.submit': 'Save date of birth',
  'dateOfBirth.declaredHeading': 'You have declared a date of birth',
  'dateOfBirth.backToAccount': 'Back to your account',
  'dateOfBirth.signedOut': 'You need to sign in before declaring a date of birth.',
  'dateOfBirth.toSignIn': 'Go to the sign-in page',
  'dateOfBirth.sessionLost': 'Your session has ended. Sign in again, then try once more.',
  'dateOfBirth.tryAgain': 'That was not saved. Please try again in a few minutes.',
  'dateOfBirth.requestNotSent': 'This request could not be sent. Reload the page, then try again.',

  /**
   * The role labels, which are what closes a defect this story found rather than
   * inherited: `sign-in-outcome.tsx` rendered `user.role` RAW, so a signed-in
   * organisation administrator read "(vai trò: org_admin)" on their own account
   * page. A wire enum is not a label in any language.
   */
  'role.guest': 'Guest',
  'role.user': 'Member',
  'role.host': 'Room host',
  'role.orgAdmin': 'Organisation admin',
  'role.moderator': 'Moderator',
  'role.systemAdmin': 'System admin',
  'role.unknown': 'Member',

  /**
   * The five sentences `packages/contracts` owns.
   *
   * Their Vietnamese values are IMPORTED there rather than retyped — one string,
   * two consumers, no copy to drift. The English side has no such source, because
   * nothing crosses the wire in English: `apps/web` never reads `error.message`
   * from a response body (measured — the three `response.json()` calls all parse a
   * SUCCESS body), so these are the client's own translations of sentences the API
   * happens to send in Vietnamese.
   */
  'error.rateLimited': 'You have tried too many times. Please wait a moment, then try again.',
  'error.dateOfBirthInvalid':
    'That date of birth is not valid. Choose your date of birth again, then try once more.',
  'error.dateOfBirthAlreadySet':
    'The profile already has a date of birth, and a date of birth cannot be changed here.',
  'error.unauthenticated': 'That sign-in session is not valid. Please try signing in again.',
  'error.moneyInForbidden':
    'Your account is not allowed to receive coins from other users yet.',
};
