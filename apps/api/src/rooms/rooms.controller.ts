import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requestIdOf } from '../request-id';
import { RoomsService } from './rooms.service';

/**
 * The Fastify-facing half. It contains no decisions: it reads the request, hands
 * the pieces to `RoomsService`, and writes whatever outcome comes back — the same
 * arrangement `AuthController` uses, deliberately rather than by coincidence.
 *
 * `'v1/rooms'` is written into the decorator because this application sets no
 * global prefix. That is the existing convention (`@Controller('v1/auth')`), and
 * changing it would move every route in the process at once.
 */
@Controller('v1/rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  /**
   * `POST /v1/rooms`.
   *
   * The body goes down as `unknown`, like the date-of-birth declaration and the
   * return-path proposal on `/start`, and for the same reason: `RoomsService` owns
   * the verdict through the shared `parseCreateRoomRequest`, and a controller that
   * pre-checked the shape would be a second place where "is this a room" is decided.
   *
   * `@Res()` turns off Nest's automatic response handling, which is what lets the
   * status be `201` on the way out. Returning a value would answer `201` for a
   * `@Post` by Nest's own default and `200` for everything else — so the refusals
   * would need `@HttpCode` or a thrown exception filter, and the four statuses this
   * route can answer would be decided in four different mechanisms.
   *
   * There is deliberately NO `@Delete` beside this, and no `@Patch`. The absence is
   * not "not yet": there is no hard-delete path for a room anywhere in this system
   * (Epic 2), and `tests/gates/no-hard-delete-rooms.test.ts` is red for a `@Delete`
   * on any controller that touches rooms.
   *
   * There is also no `@RateLimited(...)`, and that is the same kind of absence as
   * `logout`'s: `RateLimitAction` has no name for creating a room, so there is no
   * value that could be written in the parentheses. Unlike logout, this one is a
   * GAP rather than a decision — `deferred-work.md` records it with the evidence.
   */
  @Post()
  async create(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const outcome = await this.rooms.createRoom(request.headers.cookie, request.body);
    void reply.status(outcome.status).send(outcome.body);
  }

  /**
   * `POST /v1/rooms/:roomId/token` — Story 2.2.
   *
   * `request.params` goes down as `unknown`, for the reason the body does above:
   * whether `roomId` is a room id is `RoomsService`'s verdict (through the
   * contract's own `isRoomId`), and a `@Param('roomId')` with a pipe here would be
   * a second place deciding it — and one that answers `400` where the matrix says
   * `404` with the same body as "no such room".
   *
   * The request id is read the way `AuthController` reads it, through the one
   * shared `requestIdOf`, so the audit row this route writes joins its log lines.
   *
   * No `@RateLimited(...)`, and this absence is worth more than the one above:
   * every issuance writes a PERMANENT audit row, and nothing limits how often a
   * signed-in person can ask. `deferred-work.md` records that evidence under this
   * story; the fix is a `RateLimitAction` and that is an "Ask First" item.
   */
  @Post(':roomId/token')
  async issueToken(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const outcome = await this.rooms.issueRoomToken(
      request.headers.cookie,
      request.params,
      requestIdOf(request, reply),
    );
    void reply.status(outcome.status).send(outcome.body);
  }
}
