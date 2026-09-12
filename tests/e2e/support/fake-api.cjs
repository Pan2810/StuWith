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
const { randomUUID } = require('node:crypto');
const contracts = require('../../../packages/contracts/dist/index.js');

const {
  AUTH_ME_PATH,
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_REFRESH_PATH,
  BROWSER_READABLE_RESPONSE_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_REQUEST_HEADERS,
  CORS_ALLOW_CREDENTIALS,
  DATE_OF_BIRTH_FIELD,
  DEFAULT_USER_PLAN,
  PLAN_PARTICIPANT_LIMITS,
  USER_PLANS,
  isUserPlan,
  REQUEST_ID_HEADER,
  ROOMS_PATH,
  SESSION_COOKIE_NAME,
  SESSION_REFRESHED_STATUS,
  currentUserSchema,
  parseCreateRoomRequest,
  parseDateOfBirth,
  roomSchema,
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
    /**
     * All three from the contract, for the reason the expose line below records —
     * this file had already learned it once and these three had not been converted.
     *
     * Story 2.1 declared a browser probe that would go red if `apps/api` dropped
     * `credentials: true`. It could not: this literal `'true'` kept answering the
     * browser correctly no matter what the real server did. A fake that is allowed
     * to be right on its own is a fake that makes a green run mean nothing.
     */
    'access-control-allow-credentials': String(CORS_ALLOW_CREDENTIALS),
    'access-control-allow-methods': CORS_ALLOWED_METHODS.join(', '),
    'access-control-allow-headers': CORS_ALLOWED_REQUEST_HEADERS.join(', '),
    /**
     * The line this file was MISSING, and the reason the E2E suite could not see
     * the bug it was best placed to catch.
     *
     * Without `Access-Control-Expose-Headers` the browser hands script only the
     * CORS-safelisted headers, so `response.headers.get('retry-after')` returned
     * `null` here for exactly the same reason it did against the real API — this
     * fake mirrored the production omission, and a green E2E run was therefore
     * evidence of nothing. Built from the shared contract so it cannot drift from
     * `apps/api` again: whichever of the two someone edits, they edit the array.
     */
    'access-control-expose-headers': BROWSER_READABLE_RESPONSE_HEADERS.join(', '),
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

/**
 * Every request goes through here, so a throw inside the dispatch becomes a READABLE
 * failure instead of a hung socket.
 *
 * `http.createServer(async …)` returns a promise nothing awaits: a throw inside it is
 * an unhandled rejection, no response is ever written, and the browser sits on an
 * open connection until Playwright's timeout fires. What the report then says is
 * "waiting for locator to be visible" on whichever assertion came next — a sentence
 * that points at the screen and not at this file.
 *
 * It is reachable with one typo. `scenario(page, { plan: 'campus_plus' })` puts an
 * unknown plan into the state, `PLAN_PARTICIPANT_LIMITS[state.plan]` is `undefined`,
 * and `roomSchema.parse` throws on `max_participants` — the schema doing exactly its
 * job, at a point where nothing can tell anybody about it. A 500 whose body names the
 * error is not a nicety here: this process is a TEST fixture, and the failure it
 * hides is a failure in the test that called it.
 *
 * The status is 500 and the body is the error, deliberately: no fixture answer is
 * ever the right one, so a spec that accidentally depends on this branch fails on the
 * status as well as on the message.
 */
const server = http.createServer((req, res) => {
  void dispatch(req, res).catch((error) => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`fake-api: unhandled ${req.method} ${req.url} — ${detail}\n`);
    if (res.headersSent) {
      // A handler that threw AFTER writing a head cannot be given a status any more.
      // Ending the response is still what keeps the browser from waiting for ever.
      res.end();
      return;
    }
    send(res, 500, { error: 'fake-api-loi', detail });
  });
});

async function dispatch(req, res) {
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
      // Story 2.1. The plan is scenario state rather than a fixed value because it
      // is the ONE input to the participant cap, and a fake that could only produce
      // the free plan would let the Campus row of the matrix go untested in a
      // browser. The CONTRACT's default, never a literal — three places have to
      // agree about which plan a new person is on.
      plan: next?.plan ?? DEFAULT_USER_PLAN,
      /**
       * Story 2.1, review round 2. What `POST /v1/rooms` answers.
       *
       * `201` is the default, so every existing spec is unchanged. A spec that sets
       * something else drives the screen's REFUSAL branches, which were unreachable
       * in a browser until this existed — `createRoomOutcomeFor` has six outcomes
       * and five of them were pinned by `renderToStaticMarkup` alone.
       */
      roomsStatus: next?.roomsStatus ?? 201,
      roomsRetryAfterSeconds: next?.roomsRetryAfterSeconds ?? null,
    };
    /**
     * Refused HERE, where the mistake is, rather than three hops later.
     *
     * An unknown plan is not a wrong answer from this fixture — it is a spec that
     * asked for a plan the contract does not have. Left to travel, it reaches
     * `PLAN_PARTICIPANT_LIMITS[plan]` as `undefined` and `roomSchema.parse` throws in
     * a request handler; the wrapper around the dispatch turns that into a readable
     * 500 rather than a hang, but the 500 arrives on `POST /v1/rooms` and names
     * `max_participants`, which is two rooms away from the `scenario(...)` call that
     * caused it. `isUserPlan` is the contract's own predicate — the one the review
     * found nobody calling.
     */
    if (!isUserPlan(state.plan)) {
      send(res, 400, {
        error: 'goi-khong-hop-le',
        detail: `unknown plan ${JSON.stringify(state.plan)} — expected one of ${USER_PLANS.join(', ')}`,
      });
      return;
    }
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

  /**
   * Story 2.1's endpoint, and it enforces the two things the browser probe is about:
   * a session has to have travelled cross-origin, and the participant cap comes from
   * the caller's plan rather than from the body.
   *
   * The body is judged by the REAL `parseCreateRoomRequest` and the answer is built
   * through the REAL `roomSchema`, so what this fake accepts and what it emits cannot
   * drift from `apps/api`. What it still cannot tell you is whether `apps/api` agrees
   * about the STATUS — that is read from the handler by eye, and `fake-api.cjs`
   * already records the one time that went wrong (a 204 where the product answers a
   * 200, which is exactly the class of thing a schema cannot see).
   */
  if (url.pathname === ROOMS_PATH) {
    if (req.method !== 'POST') {
      // There is no GET, no PATCH and above all no DELETE for a room. Answering 405
      // rather than falling through to 404 is what makes that visible to a spec.
      send(res, 405, { error: 'phuong-thuc-khong-dung' });
      return;
    }
    if (!state.signedIn) {
      send(res, 401, { error: 'chua-dang-nhap' });
      return;
    }
    const request = parseCreateRoomRequest(await readBody(req));
    if (request === null) {
      send(res, 400, { error: 'phong-khong-hop-le' });
      return;
    }
    /**
     * The scenario's refusal, AFTER the body has been judged by the real parser.
     *
     * Order matters and is not a detail: putting it first would let a spec asking
     * for a 429 also pass a body the product would have refused, so the case would
     * be green against a screen that never sent anything valid. A refusal here is
     * the server declining a request it understood — which is the only shape the
     * screen's `createRoomOutcomeFor` branches are about.
     *
     * `Retry-After` travels as a real header, so what the browser can READ of it is
     * exercised too: the header is only visible to script because
     * `BROWSER_READABLE_RESPONSE_HEADERS` puts it in `Access-Control-Expose-Headers`,
     * and that is the exact seam `Retry-After` shipped broken through in Epic 1.
     */
    if (state.roomsStatus !== 201) {
      send(
        res,
        state.roomsStatus,
        { error: 'khong-tao-duoc-phong' },
        state.roomsRetryAfterSeconds === null
          ? {}
          : { 'retry-after': String(state.roomsRetryAfterSeconds) },
      );
      return;
    }
    const now = new Date().toISOString();
    send(
      res,
      201,
      roomSchema.parse({
        id: randomUUID(),
        owner_user_id: baseUser().id,
        name: request.name,
        // The same `?? ''` bridge `rooms.service.ts` applies, for the same reason:
        // optional on the wire, `NOT NULL` in the column. A fake that defaulted
        // differently would let a body with no description pass here and fail there.
        description: request.description ?? '',
        topic: request.topic,
        visibility: request.visibility,
        // The whole capacity decision, from the plan and from nowhere else. A
        // `max_participants` in the body reached `parseCreateRoomRequest` and was
        // stripped by it, exactly as it is in `apps/api`.
        max_participants: PLAN_PARTICIPANT_LIMITS[state.plan],
        status: 'open',
        created_at: now,
        updated_at: now,
      }),
    );
    return;
  }

  send(res, 404, { error: 'khong-tim-thay' });
}

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fake-api listening on http://127.0.0.1:${PORT}\n`);
});
