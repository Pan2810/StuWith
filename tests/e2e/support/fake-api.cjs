'use strict';

/**
 * A stand-in for `apps/api`, for the half of the product no other suite can reach.
 *
 * ## What this exists to prove, and what it does not
 *
 * The `web` Vitest project runs `environment: 'node'` with no DOM and no
 * `@testing-library` (adding one is an Ask First item), so it renders components
 * with `renderToStaticMarkup` — which never runs a `useEffect`. Every screen in
 * `apps/web` therefore had its DECISIONS tested and its WIRING tested by nothing:
 * whether React actually calls `/v1/auth/me` on mount, whether a submitted form
 * reaches the API, whether the answer redraws the screen. `date-of-birth-form.test.tsx`
 * says so in its own docblock.
 *
 * That is the gap these specs close, and it is a gap in the CLIENT. The server
 * half is already covered end to end by `auth.flow.test.ts`, which drives the real
 * NestJS app over real HTTP with a fake authorization server. Reproducing that here
 * would need a database, a Valkey, and provider discovery URLs made configurable —
 * a production-visible change made for a test's convenience.
 *
 * So: real browser, real Next.js bundle, real `fetch`, real CORS preflight, real
 * cookie. Fake origin server. What it cannot tell you is whether `apps/api` agrees
 * with these responses — for that, the contract is the shared authority, which is
 * why every body below is validated by the REAL schema from `@stuwith/contracts`
 * before it is sent. A response this file could not have produced is a crash here,
 * not a passing test against a body the product would never see.
 */

const http = require('node:http');
const contracts = require('../../../packages/contracts/dist/index.js');

const {
  AUTH_ME_PATH,
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_REFRESH_PATH,
  DATE_OF_BIRTH_FIELD,
  SESSION_COOKIE_NAME,
  SESSION_REFRESHED_STATUS,
  currentUserSchema,
  parseDateOfBirth,
} = contracts;

/** Control surface. Not under `/v1` — nothing here may look like a real route. */
const RESET_PATH = '/__e2e__/reset';
const HEALTH_PATH = '/__e2e__/healthz';

const PORT = Number(process.env['FAKE_API_PORT'] ?? 3200);
const WEB_ORIGIN = process.env['FAKE_API_WEB_ORIGIN'] ?? 'http://127.0.0.1:3100';

/**
 * One scenario PER BROWSER CONTEXT, not one per server.
 *
 * The first version of this file held a single module-level `state`, and three of
 * five specs failed the moment they ran: `fullyParallel` gives each spec its own
 * context but they all talk to this one process, so one spec's "already declared"
 * overwrote another's "not yet" between that spec's navigation and its assertion.
 * The symptom was a form that would not appear, which reads like a broken page.
 *
 * The key is a cookie the reset endpoint mints, so isolation comes from the same
 * mechanism the browser already uses for sessions and no spec has to coordinate
 * with any other. `signedIn: false` is the signed-out case; `declared` is what
 * `/v1/auth/me` reports as `profile_completed`, and the write endpoint refuses a
 * second declaration exactly as the `UPDATE ... WHERE date_of_birth IS NULL`
 * statement does in `packages/db`.
 */
const SCENARIO_COOKIE = 'e2e_scenario';
const scenarios = new Map();
let nextScenarioId = 0;

function cookiesOf(req) {
  const header = req.headers['cookie'];
  if (typeof header !== 'string') return {};
  const jar = {};
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at === -1) continue;
    jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return jar;
}

/**
 * Missing scenario is an ERROR, not a default.
 *
 * A default would let a spec that forgot to call reset pass against whatever the
 * fallback happened to be — the same "green for the wrong reason" this file exists
 * to stop.
 */
function scenarioOf(req) {
  const id = cookiesOf(req)[SCENARIO_COOKIE];
  return id === undefined ? undefined : scenarios.get(id);
}

function baseUser() {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    display_name: 'Người dùng thử',
    avatar_url: null,
    role: 'user',
  };
}

/**
 * The real schema, on the way out.
 *
 * `parse`, not `safeParse`: a body this fake cannot produce must stop the run
 * loudly. A fake that quietly drifts from the contract turns a green e2e suite
 * into a claim about nothing, which is the failure this whole file is here to
 * avoid repeating.
 */
function currentUserBody(state) {
  return currentUserSchema.parse({
    ...baseUser(),
    profile_completed: state.declared,
    is_over_18: state.declared,
  });
}

function corsHeaders() {
  return {
    // Named, never `*`: the fetch spec rejects a wildcard whenever credentials are
    // included, so a wildcard here would fail closed and look like a mystery.
    'access-control-allow-origin': WEB_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-request-id',
    vary: 'Origin',
  };
}

function send(res, status, body, extraHeaders = {}) {
  const headers = { ...corsHeaders(), ...extraHeaders };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    send(res, 204, undefined);
    return;
  }

  // Readiness, kept off `/v1` and answered before any scenario exists — Playwright
  // waits on this before it builds the web app.
  if (url.pathname === HEALTH_PATH) {
    send(res, 200, { status: 'ok', service: 'fake-api' });
    return;
  }

  if (url.pathname === RESET_PATH) {
    const next = await readBody(req);
    // Reuse the caller's id when it already has one, so a spec can change its own
    // scenario mid-test — the 409 case declares the date out from under the screen
    // between filling the form and submitting it.
    const id = cookiesOf(req)[SCENARIO_COOKIE] ?? `s${(nextScenarioId += 1)}`;
    const state = {
      signedIn: next?.signedIn ?? true,
      declared: next?.declared ?? false,
      refreshWorks: next?.refreshWorks ?? false,
      meStatus: next?.meStatus ?? 200,
    };
    scenarios.set(id, state);
    // The session cookie is set here rather than by a login flow, because the login
    // flow belongs to `apps/api` and is tested there. What matters for the browser
    // is that a cookie exists, travels cross-origin with `credentials: 'include'`,
    // and is invisible to JavaScript — all three are real here.
    const session = state.signedIn
      ? `${SESSION_COOKIE_NAME}=e2e; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`
      : `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
    send(res, 200, { ok: true }, {
      'set-cookie': [`${SCENARIO_COOKIE}=${id}; Path=/; Max-Age=3600; SameSite=Lax`, session],
    });
    return;
  }

  const state = scenarioOf(req);
  if (state === undefined) {
    send(res, 418, { error: 'chua-dat-kich-ban', hint: `POST ${RESET_PATH} first` });
    return;
  }

  if (url.pathname === AUTH_ME_PATH) {
    if (state.meStatus !== 200) {
      send(res, state.meStatus, { error: 'khong-the-doc-ho-so' }, { 'retry-after': '30' });
      return;
    }
    if (!state.signedIn) {
      send(res, 401, { error: 'chua-dang-nhap' });
      return;
    }
    send(res, 200, currentUserBody(state));
    return;
  }

  if (url.pathname === AUTH_REFRESH_PATH) {
    if (state.refreshWorks) {
      state.signedIn = true;
      // The contract's constant, so this fake cannot be the reason a status
      // disagreement goes unnoticed — a disagreement is exactly what it found.
      send(res, SESSION_REFRESHED_STATUS, undefined);
      return;
    }
    send(res, 401, { error: 'phien-da-ket-thuc' });
    return;
  }

  if (url.pathname === AUTH_DATE_OF_BIRTH_PATH) {
    if (!state.signedIn) {
      send(res, 401, { error: 'chua-dang-nhap' });
      return;
    }
    const body = await readBody(req);
    // The same parser the API uses, so "what counts as a date" cannot differ
    // between this fake and production.
    if (parseDateOfBirth(body?.[DATE_OF_BIRTH_FIELD], new Date()) === null) {
      send(res, 400, { error: 'ngay-sinh-khong-hop-le' });
      return;
    }
    if (state.declared) {
      // Write-once, the way the statement enforces it: the second writer loses.
      send(res, 409, { error: 'ngay-sinh-da-khai' });
      return;
    }
    state.declared = true;
    /**
     * 200 with the updated profile, not 204.
     *
     * `auth.service.ts:754` answers with the same projection `/v1/auth/me` uses, so
     * the client gets the new flags without a second round trip — and
     * `declarationOutcomeFor` treats only 200 as written. This file shipped a 204
     * first and the spec failed with a form that never turned into a confirmation:
     * validating the BODY against the contract schema, which is what this fake does
     * everywhere else, says nothing about the STATUS. Status agreement is checked by
     * reading the handler, and that is a real limit of the technique.
     */
    send(res, 200, currentUserBody(state));
    return;
  }

  send(res, 404, { error: 'khong-tim-thay' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fake-api listening on http://127.0.0.1:${PORT}\n`);
});
