import { z } from 'zod';

/**
 * AD-13 — the vocabulary of `/v1/auth/*`. Nothing here may be redeclared in
 * `apps/*`: the four provider names, the six roles and the shape of the signed-in
 * profile are the contract a future mobile client reads, not an implementation
 * detail of the NestJS shell.
 */

/**
 * The four providers Epic 1 promises. This list is the ONLY place the set is
 * written down: the config schema derives its credential requirements from it, the
 * migration derives its CHECK constraint from it, and the router refuses anything
 * that is not in it.
 */
export const AUTH_PROVIDERS = ['google', 'facebook', 'apple', 'microsoft'] as const;

export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * "The role model has to hold six roles from day one" (Epic 1 constraint). All six
 * are declared here so that the model is complete before any of them has a screen.
 *
 * `host` is in the list and deliberately NOT in {@link GLOBAL_USER_ROLES}: it is a
 * permission held **per room**, not a global role a `users` row can carry. Putting
 * it in the column would make "host of one room" mean "host everywhere", which is
 * the exact confusion Epic 2 has to avoid. The split is expressed here rather than
 * in a comment on the migration so both halves come from one source.
 */
export const USER_ROLES = [
  'guest',
  'user',
  'host',
  'org_admin',
  'moderator',
  'system_admin',
] as const;

export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** The five roles a `users` row may carry. `host` is per-room (Epic 2). */
export const GLOBAL_USER_ROLES = USER_ROLES.filter((role) => role !== 'host') as ReadonlyArray<
  Exclude<UserRole, 'host'>
>;

export const globalUserRoleSchema = z.enum(
  GLOBAL_USER_ROLES as unknown as [Exclude<UserRole, 'host'>, ...Array<Exclude<UserRole, 'host'>>],
);
export type GlobalUserRole = z.infer<typeof globalUserRoleSchema>;

/**
 * `GET /v1/auth/me`.
 *
 * What is NOT here is the point: no email and no provider id. The client never
 * needs either, and every field a response carries is a field that ends up in a
 * browser cache, a screenshot and eventually a support ticket. Story 1.4 adds an
 * over-18 flag; it does NOT add the date of birth.
 */
export const currentUserSchema = z.object({
  id: z.uuid(),
  display_name: z.string().min(1).max(120),
  avatar_url: z.url().nullable(),
  role: globalUserRoleSchema,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Cookie names are part of the boundary, not of the shell: the browser is the
 * transport, so renaming one is a breaking change to `/v1` exactly as renaming a
 * JSON field would be.
 *
 * All three are `httpOnly` + `Secure` + `SameSite=Lax` and are never readable from
 * JavaScript. `Lax` (not `Strict`) is required: the OAuth callback arrives as a
 * top-level cross-site navigation from the provider, and `Strict` would withhold
 * the state cookie on exactly that request, making every login fail.
 */
export const SESSION_COOKIE_NAME = 'stuwith_session';
export const REFRESH_COOKIE_NAME = 'stuwith_refresh';

/**
 * A PREFIX, not a name. One cookie per login attempt, named
 * `stuwith_oauth_<handle>`.
 *
 * A single fixed name looks simpler and is wrong for a thing people actually do:
 * open the login page in two tabs. The second `/start` overwrites the first tab's
 * state cookie, and finishing the first tab then fails as "state missing" —
 * indistinguishable, to the user, from a broken product. Per-attempt cookies make
 * two tabs work, and the callback finds its own by matching the signed `state`
 * inside each candidate rather than by trusting the cookie name.
 *
 * Housekeeping is the `Max-Age`: an abandoned attempt's cookie disappears after
 * `OAUTH_STATE_TTL_SECONDS`, and a completed or failed one is cleared explicitly.
 */
export const OAUTH_STATE_COOKIE_PREFIX = 'stuwith_oauth_';

/** The path prefix the refresh and state cookies are scoped to. */
export const AUTH_COOKIE_PATH = '/v1/auth';

/** The session cookie is needed by every authenticated endpoint, not just `/v1/auth`. */
export const SESSION_COOKIE_PATH = '/';
