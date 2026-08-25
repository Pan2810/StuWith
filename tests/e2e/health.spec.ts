import { expect, test } from '@playwright/test';
import { API_BASE_URL, GATEWAY_BASE_URL } from '../../playwright.config';

/**
 * The whole of Story 1.1's E2E surface: two processes, two ports, two health
 * checks. The acceptance criterion is about separation, so the test asserts the
 * separation, not just that something answered.
 */
test('apps/api answers /healthz', async ({ request }) => {
  const response = await request.get(`${API_BASE_URL}/healthz`);

  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', service: 'api' });
});

test('apps/realtime-gateway answers /healthz on a different port', async ({ request }) => {
  expect(GATEWAY_BASE_URL).not.toBe(API_BASE_URL);

  const response = await request.get(`${GATEWAY_BASE_URL}/healthz`);

  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', service: 'realtime-gateway' });
});

test('each process reports its own identity, so a misrouted proxy is visible', async ({
  request,
}) => {
  const [api, gateway] = await Promise.all([
    request.get(`${API_BASE_URL}/healthz`).then((r) => r.json()),
    request.get(`${GATEWAY_BASE_URL}/healthz`).then((r) => r.json()),
  ]);

  expect(api.service).not.toBe(gateway.service);
});
