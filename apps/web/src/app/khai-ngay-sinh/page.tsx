'use client';

import {
  AUTH_DATE_OF_BIRTH_PATH,
  AUTH_ME_PATH,
  DATE_OF_BIRTH_FIELD,
  parseCurrentUser,
} from '@stuwith/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApiBaseUrl, useAuthorizedFetch } from '../session-expiry-provider';
import {
  DateOfBirthPanel,
  dateOfBirthRequestBody,
  dateOfBirthSubmission,
  declarationOutcomeFor,
  profileLoadStateFor,
  screenStateFor,
  TRY_AGAIN_MESSAGE,
  type DateOfBirthScreenState,
  type DeclarationNotice,
} from './date-of-birth-form';

/**
 * The first-login declaration screen.
 *
 * Deliberately unstyled. The design system — tokens, light/dark, the "Cắm trại"
 * identity — is Story 1.6, and provisional styling here would only have to be
 * deleted. What this page proves now is what Story 1.4 owns: a person who has not
 * declared a date of birth is offered exactly one chance to, through the shared
 * seam, and everything the screen decides is in a function a test can execute.
 *
 * Everything left in this file needs a browser and nothing else: two calls
 * through `authorizedFetch`, `setState`, and reading the submitted form. Every
 * DECISION — which of the four states this is, whether the typed value is worth
 * sending, what a status code means — is an exported function in
 * `date-of-birth-form.tsx`, because the `web` Vitest project has no DOM and a
 * decision left here is a decision no test can run (`AGENTS.md`, section 6).
 *
 * `apps/web` stays a pure client: there is no age arithmetic anywhere in this
 * package. Whether somebody is over 18 arrives as a boolean from `/v1/auth/me`,
 * computed by `packages/domain`, and this screen never recomputes it.
 */
export default function KhaiNgaySinhPage() {
  const [state, setState] = useState<DateOfBirthScreenState>({ kind: 'loading' });
  const [notice, setNotice] = useState<DeclarationNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * The shared seam, not a bare `fetch`.
   *
   * This screen is only ever reached by somebody who is supposed to have a
   * session, so a 401 here IS a session that ended rather than an ordinary
   * signed-out answer — which is exactly the case the seam exists for: it renews
   * once before disturbing anybody, and raises the expiry dialog if the renewal
   * did not help. (`/dang-nhap` is the opposite case and the seam knows to stay
   * quiet there.)
   */
  const authorizedFetch = useAuthorizedFetch();
  /** From the provider, never from `process.env` — the layout reads it once. */
  const apiBaseUrl = useApiBaseUrl();

  const load = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${apiBaseUrl}${AUTH_ME_PATH}`);
      const retryAfter = response.headers.get('retry-after');
      if (response.status !== 200) {
        // `status !== 200` rather than `!response.ok`: the only shape this page
        // can read is the `CurrentUser` body a 200 carries, and a 204 would be
        // parsed as JSON and throw. What each of the other statuses MEANS is
        // `profileLoadStateFor`'s decision, not this file's — a 429 is not a
        // signed-out visitor, and telling one they need to log in sends them to a
        // page where every click makes the wait longer.
        //
        // The `Retry-After` header travels with it. This branch used to pass
        // nothing at all, so the one screen that knew a rate limit is not a login
        // problem still could not say how long it would last, and its retry button
        // called straight back into the limit.
        setState(profileLoadStateFor(response.status, null, retryAfter));
        return;
      }
      // Parsed, never cast. The whole argument this story rests on is that
      // `toCurrentUser` parses the projection on the way OUT so a drift cannot
      // publish itself; casting a 200 body on the way in would trust exactly what
      // that parse refuses to. A body that is not a `CurrentUser` is not a profile
      // this screen can act on, so it lands on `unavailable` — never on a guess.
      setState(profileLoadStateFor(200, parseCurrentUser(await response.json()), retryAfter));
    } catch {
      // Nothing came back at all, so there is no status to interpret. `0` is the
      // convention this page and its tests share for that, and there is no header
      // to read either.
      setState(profileLoadStateFor(0, null, null));
    }
  }, [authorizedFetch, apiBaseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The one write this person is allowed, sent once.
   *
   * `preventDefault` first: the form has no `action`, so a native submit would
   * navigate to the same URL and lose the session state on the way. The value is
   * read out of the submitted form rather than out of a controlled input, which
   * is what keeps this component free of a `useState` per keystroke.
   *
   * `submitting` guards a double tap on this side. It is a courtesy and not the
   * control: the real one is `UPDATE ... WHERE date_of_birth IS NULL` in the
   * adapter, which is what decides the winner when two requests genuinely race.
   * A flag in a React component cannot do that, and this comment exists so nobody
   * later mistakes it for the thing that does.
   */
  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      // `DATE_OF_BIRTH_FIELD` on both halves, and the panel writes the `name`
      // attribute from the same constant rather than from a prop this file passes
      // in — so the reader and the writer cannot name the field differently.
      const raw = new FormData(event.currentTarget).get(DATE_OF_BIRTH_FIELD);
      const submission = dateOfBirthSubmission(raw);
      if (submission.kind === 'invalid') {
        // Refused here, so nothing is sent and nothing is written. The sentence is
        // the same one the server would have answered with — one message for one
        // mistake, whether or not the network was involved. "In the future" is not
        // decided here: see `dateOfBirthSubmission` on why the browser's clock is
        // not allowed to refuse anybody.
        setNotice({ message: submission.message, retryAfterSeconds: null });
        return;
      }

      setSubmitting(true);
      try {
        const response = await authorizedFetch(`${apiBaseUrl}${AUTH_DATE_OF_BIRTH_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: dateOfBirthRequestBody(submission.value),
        });
        const outcome = declarationOutcomeFor(
          response.status,
          response.headers.get('retry-after'),
        );
        if (outcome.kind === 'written') {
          setNotice(null);
          /**
           * The 200 carries the updated projection, and the endpoint's own
           * docblock says why: "so the client gets the new flags without a second
           * round trip". This used to throw that body away and call `load()`,
           * which spent one more rate-limited `/v1/auth/me` on every declaration
           * — and the state it landed on was still the server's, just fetched
           * twice. It is still the server's answer, parsed through the same
           * schema; nothing is inferred here.
           *
           * A body that will not parse means this screen does not know the new
           * flags, so it falls back to re-reading — the old path, now reached only
           * by the case that actually needs it.
           */
          const declared = parseCurrentUser(await response.json().catch(() => null));
          if (declared === null) {
            await load();
            return;
          }
          setState(screenStateFor(declared));
          return;
        }
        if (outcome.kind === 'already-declared') {
          /**
           * A 409 goes STRAIGHT to the terminal state, and does not re-read.
           *
           * It used to share a branch with the 200, find no profile in the body (a
           * 409 names no value, deliberately) and fall back to `load()`. That works
           * for the ordinary case — a second tab got there first — and loops for
           * ever in the one that matters: a profile whose stored value this product
           * no longer accepts reads as "not declared", so `load()` put the form
           * back, the submit was refused with another 409, and round it went.
           *
           * The status is the whole answer. The profile HAS a date of birth, this
           * screen's job is over either way, and the sentence it then shows says so
           * without claiming to know what was stored.
           */
          setNotice(null);
          setState({ kind: 'declared' });
          return;
        }
        setNotice(outcome.notice);
      } catch {
        // Nothing came back at all, so there is no status to interpret. Same
        // sentence as an unrecognised one: "we do not know that it worked" is the
        // only honest thing to say, and it is never "it worked".
        setNotice({ message: TRY_AGAIN_MESSAGE, retryAfterSeconds: null });
      } finally {
        setSubmitting(false);
      }
    },
    [authorizedFetch, apiBaseUrl, load, submitting],
  );

  return (
    <main>
      <h1>Khai ngày sinh</h1>
      {/*
        The panel owns the `<form>`, because whether there is one at all is one of
        its four decisions. Wrapping it in a second form here would nest one inside
        another on the two branches that render no form of their own — invalid
        markup that nothing in a DOM-less project would notice.
      */}
      <DateOfBirthPanel
        state={state}
        notice={notice}
        submitting={submitting}
        onRetry={() => void load()}
        // The rate-limit wait is over: drop it so the retry button works again.
        // REQUIRED on the panel, so a branch that renders a disabled button cannot
        // lose the one thing that re-enables it.
        onWaitFinished={() => setState({ kind: 'unavailable', retryAfterSeconds: null })}
        onSubmit={(event) => void submit(event)}
      />
    </main>
  );
}
