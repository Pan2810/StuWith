import { RateLimitInputError } from '@stuwith/domain';
import { describe, expect, it } from 'vitest';
import { isStoreFault } from './store-fault';

/**
 * The judge that decides whether the blocking layer is allowed to fail open.
 *
 * Every fail-open example in `rate-limit.flow.test.ts` throws
 * `new Error('Command timed out')`, which lands on the message-marker branch. The
 * NAME branch — the shape `iovalkey` actually produces when a connection dies —
 * had no test at all: deleting the whole `STORE_ERROR_NAMES` set left the suite
 * green while a real outage would have surfaced as a 500 instead of a fail-open.
 *
 * Both directions matter and they fail in opposite ways. Saying "store fault" to a
 * bug of ours leaves the limit off for ever with the alert pointing at Valkey;
 * saying "our bug" to a real outage turns the outage into 500s for everybody
 * trying to sign in.
 */

/** The message says nothing a marker could match, so only the NAME can decide. */
const named = (name: string): Error =>
  Object.assign(new Error('Reached the max retries per request limit'), { name });

describe('a transport failure from the client library is a store fault', () => {
  it.each([
    ['MaxRetriesPerRequestError', 'the client gave up retrying a command'],
    ['ReplyError', 'the server answered with an error reply'],
    ['ClusterAllFailedError', 'no node in the cluster could be reached'],
    ['AbortError', 'the command was aborted while in flight'],
    ['ConnectionError', 'the connection failed'],
  ])('%s — %s', (name) => {
    expect(isStoreFault(named(name))).toBe(true);
  });

  it.each([
    'connect ECONNREFUSED 127.0.0.1:6379',
    'Command timed out',
    "Stream isn't writeable and enableOfflineQueue options is false",
    'Connection is closed.',
    'read ECONNRESET',
  ])('recognises %s by its message when the name is only "Error"', (message) => {
    expect(isStoreFault(new Error(message))).toBe(true);
  });
});

describe('a defect of ours is never a store fault, however it is worded', () => {
  it.each([
    ['TypeError', new TypeError("Cannot read properties of undefined (reading 'ip')")],
    ['RangeError', new RangeError('Invalid array length')],
    ['ReferenceError', new ReferenceError('subject is not defined')],
    ['SyntaxError', new SyntaxError('Unexpected end of JSON input')],
    ['RateLimitInputError', new RateLimitInputError('key must be a non-empty string')],
  ])('%s', (_label, error) => {
    expect(isStoreFault(error)).toBe(false);
  });

  /**
   * The adapter's own reply-shape error, which used to classify as a store fault
   * because the message contained the word "valkey".
   *
   * That is the inversion this file exists to prevent: the script or the adapter
   * is wrong, Valkey is healthy, and the product silently stopped limiting while
   * telling the operator to go and look at the store.
   */
  it.each(['unexpected reply shape from the rate-limit script', 'expected an integer reply'])(
    'ValkeyReplyShapeError: %s',
    (message) => {
      const error = Object.assign(new Error(message), { name: 'ValkeyReplyShapeError' });
      expect(isStoreFault(error)).toBe(false);
    },
  );

  /**
   * The word "valkey" or "redis" in a message is not evidence of an outage. It is
   * evidence that somebody wrote the product name in a string.
   */
  it.each([
    'valkey: unexpected reply shape from the rate-limit script',
    'redis key builder produced undefined',
  ])('a plain Error that merely mentions the store: %s', (message) => {
    expect(isStoreFault(new Error(message))).toBe(false);
  });

  it.each([
    ['a thrown string', 'Command timed out'],
    ['a thrown object', { message: 'Command timed out' }],
    ['null', null],
    ['undefined', undefined],
  ])('%s is not something the client library throws', (_label, thrown) => {
    expect(isStoreFault(thrown)).toBe(false);
  });
});
