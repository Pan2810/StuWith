import { SetMetadata } from '@nestjs/common';
import type { RateLimitAction } from '@stuwith/domain';

/**
 * The only way a route acquires a rate limit.
 *
 * The epic context asks for the same shape the age gate will use: "guard áp dụng
 * **tự động** qua decorator/metadata — endpoint mới chỉ cần đánh dấu". The
 * alternative — an `if` at the top of each handler — drifts the moment somebody
 * adds a sixth route and copies the fifth without its condition, and nothing says
 * so.
 *
 * A route with no decorator is not limited. That is the correct default here and
 * it is what keeps `POST /v1/auth/logout` safe from ever acquiring one by
 * accident: {@link RateLimitAction} has no name for logging out, so there is
 * nothing to write in the parentheses.
 */
export const RATE_LIMIT_ACTION_METADATA = 'stuwith:rate-limit-action';

/**
 * `MethodDecorator`, never `ClassDecorator`, and that is the enforcement rather
 * than a convention.
 *
 * It was typed `MethodDecorator & ClassDecorator` while the guard read class
 * metadata as a fallback, so a single decorator on `AuthController` would have
 * rate-limited every route in it — `POST /v1/auth/logout` included. That route is
 * on the spec's Never list and is called out in three docblocks as the one
 * endpoint that can never be limited, because limiting it keeps somebody inside a
 * session they are trying to leave.
 *
 * Narrowing the type makes writing it on a class a compile error, and the guard
 * reads only handler metadata, so it cannot arrive by reflection either.
 */
export const RateLimited = (action: RateLimitAction): MethodDecorator =>
  SetMetadata(RATE_LIMIT_ACTION_METADATA, action);
