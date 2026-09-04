import type { ApiEnv } from '@stuwith/config';
import { compileTrustedProxies } from '@stuwith/config';
import type { FastifyRequest } from 'fastify';
import { clientIpOf } from './rate-limit/request-identity';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { fastifyAdapterOptions } from './http-setup';

/**
 * Three docblocks call `trustProxy` "the most dangerous setting in the story" and
 * nothing tested it.
 *
 * The two failure directions are silent and opposite — trust nothing behind Caddy
 * and every visitor becomes one bucket; trust the header with nothing in front and
 * anybody picks their own key — so what matters is not only the value this
 * function returns but that Fastify and `clientIpOf` AGREE about it. The last
 * block below asserts exactly that, by starting a real Fastify and asking it.
 *
 * Since both now go through `@fastify/proxy-addr` — the same library at the same
 * pinned version Fastify 5 itself resolves — agreement is a property of the wiring
 * rather than of two implementations happening to match. These examples are the
 * check that the wiring is actually shared, and they cover the cases the deleted
 * hand-written parser avoided: a chain longer than any cap, an unparseable entry,
 * an IPv4-mapped peer, an IPv6 peer.
 */
function configWith(addresses: string): ApiEnv {
  return { TRUSTED_PROXY_ADDRESSES: addresses } as unknown as ApiEnv;
}

describe('fastifyAdapterOptions', () => {
  it('trusts nothing when the deployment declared no proxy', () => {
    // `false`, not `'none'` and not an empty string: with nothing in front, the
    // header is not evidence of anything and must not be read at all.
    expect(fastifyAdapterOptions(configWith('none')).trustProxy).toBe(false);
  });

  it('passes the declared list through as the comma-joined STRING', () => {
    expect(fastifyAdapterOptions(configWith('10.0.0.2')).trustProxy).toBe('10.0.0.2');
    expect(fastifyAdapterOptions(configWith(' 10.0.0.2 , 10.0.0.0/24 ')).trustProxy).toBe(
      '10.0.0.2,10.0.0.0/24',
    );
  });

  /**
   * Two copies of Fastify are installed and they disagree about what a NUMBER
   * means: `5.11.3` (the one `@nestjs/platform-fastify` resolves, so the one that
   * runs) honours "trust this many hops", while `5.12.1` returns `() => false` for
   * it as a security fix. A numeric literal would therefore mean one thing today
   * and "trust nothing" after a routine dependency bump — silently changing every
   * visitor's counted address.
   */
  it.each(['none', '10.0.0.2', '10.0.0.0/24, 10.0.0.9'])(
    'never produces a number for %s',
    (addresses) => {
      expect(typeof fastifyAdapterOptions(configWith(addresses)).trustProxy).not.toBe('number');
    },
  );

  it('throws rather than quietly narrowing the list', () => {
    // The config layer already validated this, so anything invalid here is a bug —
    // and continuing with a shortened set of trusted proxies is the "trusts too
    // few" failure with nothing said.
    expect(() => fastifyAdapterOptions(configWith('0.0.0.0/0'))).toThrow(
      /TRUSTED_PROXY_ADDRESSES/,
    );
    expect(() => fastifyAdapterOptions(configWith(','))).toThrow(/TRUSTED_PROXY_ADDRESSES/);
  });
});

/**
 * Fastify's `request.ip` and `clientIpOf` answer the same question on the same
 * request, and BOTH answers are used: the first ends up on log lines, the second
 * builds the rate-limit key. If they disagree, an investigation reads one address
 * while the limiter counted another.
 */
describe('Fastify and clientIpOf agree for the same request', () => {
  const servers: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  /**
   * Both answers for one request, taken from the SAME server: Fastify computes
   * `request.ip` itself, and `clientIpOf` is handed the very request object the
   * handler received.
   */
  async function bothAnswers(
    addresses: string,
    peer: string,
    forwardedFor?: string,
  ): Promise<{ fastify: string; ours: string }> {
    const compiled = compileTrustedProxies(addresses);
    if (!compiled.ok) {
      throw new Error(compiled.problem);
    }

    const server = Fastify(fastifyAdapterOptions(configWith(addresses)));
    servers.push(server);
    server.get('/ip', async (request) => ({
      fastify: request.ip,
      ours: clientIpOf(request as unknown as FastifyRequest, compiled.trust),
    }));

    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: peer,
      ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
    });
    return response.json() as { fastify: string; ours: string };
  }

  const longChain = [
    ...Array.from({ length: 400 }, (_unused, index) => `1.2.3.${index % 256}`),
    '203.0.113.7',
  ].join(', ');

  it.each([
    ['no proxy declared, header present', 'none', '10.0.0.2', '203.0.113.7'],
    ['peer is the declared proxy', '10.0.0.2', '10.0.0.2', '203.0.113.7'],
    ['peer is inside a declared network', '10.0.0.0/24', '10.0.0.7', '203.0.113.7'],
    ['a forged hop before the real one', '10.0.0.2', '10.0.0.2', '9.9.9.9, 203.0.113.7'],
    ['no header at all', '10.0.0.2', '10.0.0.2', undefined],
    ['peer is not a declared proxy', '198.51.100.9', '10.0.0.2', '203.0.113.7'],
    // The cases the hand-written parser avoided, and where a cap or a lenient
    // address check would have made the two disagree.
    ['a chain longer than any cap', '10.0.0.2', '10.0.0.2', longChain],
    ['an entry that is not an address', '10.0.0.2', '10.0.0.2', 'not-an-ip, 203.0.113.7'],
    ['an entry net.isIP rejects', '10.0.0.2', '10.0.0.2', '1.2.3.4::5, 203.0.113.7'],
    ['an IPv4-mapped peer', '10.0.0.2', '::ffff:10.0.0.2', '203.0.113.7'],
    ['an IPv6 peer', '::1', '::1', '203.0.113.7'],
    ['an IPv6 peer with no header', '::1', '::1', undefined],
  ])('%s', async (_label, addresses, peer, forwardedFor) => {
    const { fastify, ours } = await bothAnswers(addresses, peer, forwardedFor);

    // `clientIpOf` folds `::ffff:` to the plain IPv4 form so one machine is one
    // budget; Fastify reports whatever the socket produced. That is the only
    // permitted difference, and it is a normalisation rather than a decision.
    expect(ours).toBe(fastify.toLowerCase().replace(/^::ffff:/, ''));
  });
});
