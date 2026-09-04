import type { ApiEnv } from '@stuwith/config';
import { requireTrustedProxies, resolveClientIp } from '@stuwith/domain';
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
 * function returns but that Fastify and `resolveClientIp` AGREE about it. The last
 * block below asserts exactly that, by starting a real Fastify and asking it.
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
 * Fastify's `request.ip` and the domain's `resolveClientIp` are two independent
 * implementations of one rule, and they are BOTH used: the first ends up on log
 * lines, the second builds the rate-limit key. If they disagree, an investigation
 * reads one address while the limiter counted another.
 */
describe('Fastify and resolveClientIp agree for the same request', () => {
  const servers: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  async function askFastify(addresses: string, forwardedFor?: string): Promise<string> {
    const server = Fastify(fastifyAdapterOptions(configWith(addresses)));
    servers.push(server);
    server.get('/ip', async (request) => ({ ip: request.ip }));

    const response = await server.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.2',
      ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
    });
    return (response.json() as { ip: string }).ip;
  }

  function askDomain(addresses: string, forwardedFor?: string): string {
    return resolveClientIp({
      socketAddress: '10.0.0.2',
      forwardedFor,
      trustedProxies: requireTrustedProxies(addresses),
    });
  }

  it.each([
    ['no proxy declared, header present', 'none', '203.0.113.7'],
    ['peer is the declared proxy', '10.0.0.2', '203.0.113.7'],
    ['peer is inside a declared network', '10.0.0.0/24', '203.0.113.7'],
    ['a forged hop before the real one', '10.0.0.2', '9.9.9.9, 203.0.113.7'],
    ['no header at all', '10.0.0.2', undefined],
    ['peer is not a declared proxy', '198.51.100.9', '203.0.113.7'],
  ])('%s', async (_label, addresses, forwardedFor) => {
    expect(await askFastify(addresses, forwardedFor)).toBe(askDomain(addresses, forwardedFor));
  });
});
