'use client';

import {
  AUTH_DATE_OF_BIRTH_PATH,
  DATE_OF_BIRTH_FIELD,
  type CurrentUser,
} from '@stuwith/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useApiBaseUrl, useAuthorizedFetch } from '../session-expiry-provider';
import {
  DateOfBirthPanel,
  dateOfBirthRequestBody,
  dateOfBirthSubmission,
  declarationOutcomeFor,
  profileLoadStateFor,
  TRY_AGAIN_MESSAGE,
  type DateOfBirthScreenState,
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
  const [notice, setNotice] = useState<string | null>(null);
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
      const response = await authorizedFetch(`${apiBaseUrl}/v1/auth/me`);
      if (response.status !== 200) {
        // `status !== 200` rather than `!response.ok`: the only shape this page
        // can read is the `CurrentUser` body a 200 carries, and a 204 would be
        // parsed as JSON and throw. What each of the other statuses MEANS is
        // `profileLoadStateFor`'s decision, not this file's — a 429 is not a
        // signed-out visitor, and telling one they need to log in sends them to a
        // page where every click makes the wait longer.
        setState(profileLoadStateFor(response.status, null));
        return;
      }
      setState(profileLoadStateFor(200, (await response.json()) as CurrentUser));
    } catch {
      // Nothing came back at all, so there is no status to interpret. `0` is the
      // convention this page and its tests share for that.
      setState(profileLoadStateFor(0, null));
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

      const raw = new FormData(event.currentTarget).get(DATE_OF_BIRTH_FIELD);
      const submission = dateOfBirthSubmission(raw, new Date());
      if (submission.kind === 'invalid') {
        // Refused here, so nothing is sent and nothing is written. The sentence is
        // the same one the server would have answered with — one message for one
        // mistake, whether or not the network was involved.
        setNotice(submission.message);
        return;
      }

      setSubmitting(true);
      try {
        const response = await authorizedFetch(`${apiBaseUrl}${AUTH_DATE_OF_BIRTH_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: dateOfBirthRequestBody(submission.value),
        });
        const outcome = declarationOutcomeFor(response.status);
        if (outcome.kind === 'declared') {
          // Re-read rather than trusting the body: the profile flags are the
          // server's answer, and reloading them is what keeps this screen from
          // ever showing a state it inferred for itself.
          setNotice(null);
          await load();
          return;
        }
        setNotice(outcome.message);
      } catch {
        // Nothing came back at all, so there is no status to interpret. Same
        // sentence as an unrecognised one: "we do not know that it worked" is the
        // only honest thing to say, and it is never "it worked".
        setNotice(TRY_AGAIN_MESSAGE);
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
        inputName={DATE_OF_BIRTH_FIELD}
        onSubmit={(event) => void submit(event)}
      />
    </main>
  );
}
