import { Valkey, type RedisOptions } from 'iovalkey';

/**
 * The one place a Valkey connection is built.
 *
 * Every option below exists because the DEFAULT is wrong for a blocking layer that
 * has been told to fail open. The rule that shapes all of them: when Valkey cannot
 * answer, the command must REJECT quickly and let `apps/api` decide what to do —
 * never hang, never queue, never retry until the request times out. A rate-limit
 * check that takes ten seconds to fail has turned an outage of the counter into an
 * outage of the login.
 */
export interface ValkeyClientOptions {
  /** How long one command may take before it is treated as an outage. */
  readonly commandTimeoutMs: number;
  /**
   * How long the initial TCP+handshake may take. Defaults to
   * {@link MIN_CONNECT_TIMEOUT_MS} or the command timeout, whichever is larger.
   */
  readonly connectTimeoutMs?: number;
}

/**
 * The floor under the CONNECT timeout, which is a different question from the
 * command timeout and must not inherit it.
 *
 * A command timeout is deliberately tiny (250ms by default) because the layer
 * fails open and every millisecond of waiting is added to a login that is going to
 * succeed anyway. A connect is a TCP handshake to a machine that may be in another
 * data centre and may be cold; 250ms there fails every attempt, the reconnect
 * strategy retries and fails again, and the blocking layer is permanently off with
 * a healthy Valkey sitting right there.
 */
export const MIN_CONNECT_TIMEOUT_MS = 5_000;

/** The two scripts, defined once so they travel as `EVALSHA` rather than as source. */
export const HIT_COMMAND = 'stuwithRateLimitHit';
export const LOCK_COMMAND = 'stuwithRateLimitLock';

/**
 * Count one attempt and report the truth about the window, in ONE atomic step.
 *
 * `INCR` then `PEXPIRE` as two commands is the version that looks obviously fine
 * and is not: a process that dies between them leaves a counter with no expiry — a
 * key that never resets, so the person it belongs to is locked out permanently and
 * nothing in the product can tell them why.
 *
 * The `ttl < 0` branch is the REPAIR, and it is not theoretical. `PEXPIRE` used to
 * run only when `count == 1`, so a key that reached this script without an expiry —
 * left by an older build, a manual `SET`, a partially-applied script — stayed
 * without one for ever: `PTTL` answers -1, the caller is refused, and the countdown
 * it is told to wait is one second, every second, indefinitely. Re-applying the
 * expiry whenever it is missing makes that state self-healing instead of terminal.
 *
 * `PTTL` rather than `TTL`: whole-second resolution rounds a 4.6-second remainder
 * to 4, and somebody who waits exactly the 4 seconds they were told is refused
 * again. Milliseconds come back and `retryAfterSecondsFrom` rounds UP.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
end
return { count, ttl }
`;

/**
 * Start a lock only if one is not already running, and answer with its REAL
 * remaining time.
 *
 * `SET key value PX ms NX` is the atomic "only if absent" form. Without `NX` every
 * later failure would restart the clock, so the countdown a person is watching
 * would jump back up and a determined attacker's own traffic would keep their
 * victim locked out for ever.
 *
 * The same repair as above, for the same reason: `NX` is a no-op against an
 * existing key, so a lock key that somehow has no expiry would never gain one and
 * the lock would be permanent.
 */
const LOCK_SCRIPT = `
redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
end
return ttl
`;

/**
 * A client with the two rate-limit scripts attached.
 *
 * `defineCommand` registers them as `EVALSHA` with an automatic `NOSCRIPT`
 * fallback, so the Lua source travels once per connection instead of on every
 * command — the same semantics, without a few hundred bytes of script body in
 * front of every login.
 */
export interface ValkeyClient extends Valkey {
  [HIT_COMMAND](key: string, windowMs: string): Promise<unknown>;
  [LOCK_COMMAND](key: string, lockMs: string): Promise<unknown>;
}

interface CommandDefiner {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
}

export function createValkeyClient(url: string, options: ValkeyClientOptions): ValkeyClient {
  const connectTimeout = Math.max(
    options.connectTimeoutMs ?? MIN_CONNECT_TIMEOUT_MS,
    options.commandTimeoutMs,
  );
  const settings: RedisOptions = {
    /**
     * Do NOT connect during construction. `createProductionRuntime` runs while the
     * Nest modules are being wired, and a connect that throws there takes the
     * process down before `/healthz` exists — turning "Valkey is down" into "the
     * API is down", which is the exact opposite of the fail-open decision.
     */
    lazyConnect: true,
    /**
     * Reject immediately instead of parking the command until a connection comes
     * back. The offline queue is the right default for a cache whose caller can
     * wait; here the caller is an HTTP request that must not.
     */
    enableOfflineQueue: false,
    /**
     * One attempt, then give up. Retrying inside the client multiplies the
     * timeout: three retries at 250ms each is 750ms added to a login that is
     * going to be allowed through anyway.
     */
    maxRetriesPerRequest: 1,
    /**
     * NOT the command timeout. A handshake to a cold or distant server needs
     * seconds where a command needs milliseconds, and inheriting the command
     * timeout here means every connect attempt fails, the retry strategy loops,
     * and the layer is permanently off next to a perfectly healthy Valkey.
     */
    connectTimeout,
    /** The matrix's "Valkey trả chậm" row: slow is handled exactly like down. */
    commandTimeout: options.commandTimeoutMs,
    /**
     * Keep trying to come BACK, with a ceiling. Reconnecting is what makes the
     * outage self-healing once Valkey returns; the ceiling stops a long outage
     * turning into a tight reconnect loop.
     */
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  };

  const client = new Valkey(url, settings);

  /**
   * An `error` event with no listener is an unhandled 'error' on an EventEmitter,
   * which takes the whole process down. That would make a Valkey blip kill the
   * API — the same failure `createProductionRuntime` already guards against on the
   * pg pool, for the same reason. Errors that matter reach us as a rejected
   * command, which is where the fail-open decision and its log line live.
   */
  client.on('error', () => {});

  const definer = client as unknown as CommandDefiner;
  definer.defineCommand(HIT_COMMAND, { numberOfKeys: 1, lua: HIT_SCRIPT });
  definer.defineCommand(LOCK_COMMAND, { numberOfKeys: 1, lua: LOCK_SCRIPT });

  return client as ValkeyClient;
}
