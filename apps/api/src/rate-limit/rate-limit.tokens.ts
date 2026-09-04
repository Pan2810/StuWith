/**
 * Injection token for the `RateLimitPort` implementation.
 *
 * Its own file so that the guard, the module and `AuthModule` can all reach it
 * without any of them importing another's file — the same reason `APP_CONFIG`
 * lives alone.
 */
export const RATE_LIMIT_PORT = Symbol('RATE_LIMIT_PORT');
