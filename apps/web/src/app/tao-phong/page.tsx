'use client';

import { AUTH_ME_PATH, ROOMS_PATH, parseCurrentUser, roomSchema } from '@stuwith/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useT } from '../i18n/use-t';
import { useApiBaseUrl, useAuthorizedFetch } from '../session-expiry-provider';
import {
  CREATE_ROOM_HEADING_KEY,
  CreateRoomPanel,
  TRY_AGAIN_KEY,
  createRoomOutcomeFor,
  createRoomRequestBody,
  createRoomStateFor,
  createRoomSubmissionFrom,
  type CreateRoomNotice,
  type CreateRoomScreenState,
} from './create-room-form';

/**
 * The create-room screen.
 *
 * Everything left in this file needs a browser and nothing else: two calls through
 * `authorizedFetch`, `setState`, and reading the submitted form. Every DECISION —
 * which of the five states this is, whether what was filled in is worth sending,
 * what a status code means — is an exported function in `create-room-form.tsx`,
 * because the `web` Vitest project has no DOM and a decision left here is a decision
 * no test can run (`AGENTS.md` §6).
 *
 * `apps/web` stays a pure client: there is no plan arithmetic anywhere in this
 * package. How many people a room holds is decided by `apps/api` from the owner's
 * plan and arrives on the created room as a number this screen renders.
 */
export default function TaoPhongPage() {
  const t = useT();
  const [state, setState] = useState<CreateRoomScreenState>({ kind: 'loading' });
  const [notice, setNotice] = useState<CreateRoomNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * The shared seam, not a bare `fetch`.
   *
   * This screen is only ever reached by somebody who is supposed to have a session,
   * so a 401 here IS a session that ended rather than an ordinary signed-out answer
   * — which is exactly the case the seam exists for: it renews once before
   * disturbing anybody, and raises the expiry dialog if the renewal did not help.
   * `credentials: 'include'` lives inside the seam, not at this call site.
   */
  const authorizedFetch = useAuthorizedFetch();
  /** From the provider, never from `process.env` — the layout reads it once. */
  const apiBaseUrl = useApiBaseUrl();

  const load = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${apiBaseUrl}${AUTH_ME_PATH}`);
      const retryAfter = response.headers.get('retry-after');
      if (response.status !== 200) {
        // `status !== 200` rather than `!response.ok`: the only shape this page can
        // read is the `CurrentUser` body a 200 carries, and a 204 would be parsed as
        // JSON and throw. What each other status MEANS is `createRoomStateFor`'s
        // decision, not this file's.
        setState(createRoomStateFor(response.status, null, retryAfter));
        return;
      }
      // Parsed, never cast: a body that is not a `CurrentUser` is not a profile this
      // screen can act on, so it lands on `unavailable` rather than on a guess.
      setState(createRoomStateFor(200, parseCurrentUser(await response.json()), retryAfter));
    } catch {
      // Nothing came back at all, so there is no status to interpret. `0` is the
      // convention these screens share for that, and there is no header to read.
      setState(createRoomStateFor(0, null, null));
    }
  }, [authorizedFetch, apiBaseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The create, sent once.
   *
   * `preventDefault` first: the form has no `action`, so a native submit would
   * navigate to the same URL and lose the session state on the way. The values are
   * read out of the submitted form rather than out of controlled inputs, which is
   * what keeps this component free of a `useState` per keystroke — and the FIELD
   * NAMES stay in `create-room-form.tsx`, which is also the module that writes them
   * onto the inputs.
   *
   * `submitting` guards a double tap on this side, and it is a courtesy rather than
   * a control: two rooms created by a double tap are two rooms, which is a real
   * outcome rather than a corrupted one. Nothing in the database prevents it,
   * deliberately — a room name is a label, not a key.
   */
  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      const form = new FormData(event.currentTarget);
      const submission = createRoomSubmissionFrom((field) => form.get(field));
      if (submission.kind === 'invalid') {
        // Refused here, so nothing is sent and nothing is written. The sentence is
        // the same one the server would have answered with — one message for one
        // mistake, whether or not the network was involved.
        setNotice({ messageKey: submission.messageKey, retryAfterSeconds: null });
        return;
      }

      setSubmitting(true);
      try {
        const response = await authorizedFetch(`${apiBaseUrl}${ROOMS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: createRoomRequestBody(submission.value),
        });
        const outcome = createRoomOutcomeFor(
          response.status,
          response.headers.get('retry-after'),
        );
        if (outcome.kind === 'created') {
          /**
           * The 201 carries the stored room, and the screen renders THAT.
           *
           * Not the values that were typed: the name was trimmed on the way through
           * and the cap was decided by the server from a plan this client never
           * sees. Echoing the submission would tell somebody their room is called
           * something it is not, and would need a copy of the plan table in the
           * browser to say how many people it holds.
           *
           * A body that will not parse means this screen does not know what was
           * created, so it says so rather than claiming success — the same
           * cautious direction `createRoomOutcomeFor`'s `default` takes.
           */
          const created = roomSchema.safeParse(await response.json().catch(() => null));
          if (!created.success) {
            setNotice({ messageKey: TRY_AGAIN_KEY, retryAfterSeconds: null });
            return;
          }
          setNotice(null);
          setState({ kind: 'created', room: created.data });
          return;
        }
        setNotice(outcome.notice);
      } catch {
        // Nothing came back at all, so there is no status to interpret. Same
        // sentence as an unrecognised one: "we do not know that it worked" is the
        // only honest thing to say, and it is never "it worked".
        setNotice({ messageKey: TRY_AGAIN_KEY, retryAfterSeconds: null });
      } finally {
        setSubmitting(false);
      }
    },
    [authorizedFetch, apiBaseUrl, submitting],
  );

  return (
    <main className="page-shell">
      <h1>{t(CREATE_ROOM_HEADING_KEY)}</h1>
      {/*
        The panel owns the `<form>`, because whether there is one at all is one of
        its five decisions. Wrapping it in a second form here would nest one inside
        another on the branches that render no form of their own — invalid markup
        that nothing in a DOM-less project would notice.
      */}
      <CreateRoomPanel
        state={state}
        notice={notice}
        submitting={submitting}
        onRetry={() => void load()}
        // The rate-limit wait on the PROFILE read is over: drop it so the retry
        // button works again.
        onWaitFinished={() => setState({ kind: 'unavailable', retryAfterSeconds: null })}
        /*
          The wait on a SUBMIT is over. The NOTICE goes, not just its clock: leaving
          "bạn đã thử quá nhiều lần, hãy chờ một lát" on screen beside a button that
          now works says the opposite of what the button does, and there is no clock
          left to explain the sentence. Dropping only `retryAfterSeconds` was the
          first version and review round 2 caught it.

          The screen STATE is untouched, which is the whole reason this is not
          `onWaitFinished`: that one moves the state, correct on the `unavailable`
          branch and wrong here — the form would vanish mid-typing and take whatever
          had been entered with it. `tao-phong.spec.ts` holds the difference in a
          browser, because the two produce identical markup.
        */
        onSubmitWaitFinished={() => setNotice(null)}
        onSubmit={(event) => void submit(event)}
        // Back to an empty form. The state goes to `ready` directly rather than
        // through `load()`: the session was live one round trip ago, and re-reading
        // the profile would spend another rate-limited `/v1/auth/me` to learn what
        // this screen already knows.
        onCreateAnother={() => {
          setNotice(null);
          setState({ kind: 'ready' });
        }}
      />
    </main>
  );
}
