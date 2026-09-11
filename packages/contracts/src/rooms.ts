import { z } from 'zod';

/**
 * AD-13 — the vocabulary of `/v1/rooms`, and of the plan a participant cap is
 * derived from. Nothing here may be redeclared in `apps/*`: the six topics, the
 * two visibilities, the three statuses and the three plan ceilings are the
 * contract a future mobile client reads, and `packages/db`'s migration derives its
 * CHECK constraints from the same lists (through `rooms-migration.test.ts`, because
 * a migration runs as plain JavaScript and cannot import this file).
 */

/**
 * The three plans, and the ONLY place the set is written down.
 *
 * A plan is a property of a PERSON, not of a room: `users.plan` is what the
 * migration adds, and the room stores the NUMBER the plan resolved to rather than
 * the plan itself. That split is the whole of Story 2.1's cap decision — see
 * {@link PLAN_PARTICIPANT_LIMITS}.
 *
 * There is no payment and no upgrade path yet (Epic 5 owns both), so every person
 * created today is on `study_buddy` by the column's default. The list is complete
 * from day one anyway, for the same reason `USER_ROLES` holds six roles before any
 * of them has a screen: a set that grows later is a CHECK constraint edited later,
 * on a table that already has rows.
 */
export const USER_PLANS = ['study_buddy', 'study_circle', 'campus'] as const;

export const userPlanSchema = z.enum(USER_PLANS);
export type UserPlan = z.infer<typeof userPlanSchema>;

export function isUserPlan(value: unknown): value is UserPlan {
  return typeof value === 'string' && (USER_PLANS as readonly string[]).includes(value);
}

/**
 * The plan a brand-new person is on, spelled once.
 *
 * Three places have to agree about it and none of them can import from the other
 * two directly: the `DEFAULT` on `users.plan` (plain JavaScript in a migration),
 * the in-memory identity adapter (which has no column to inherit a default from),
 * and any fixture that builds a person. `rooms-migration.test.ts` holds the
 * migration against this constant; the shared contract suite holds both adapters
 * against it. Without one name, the free plan is a literal in three files and the
 * one that decides a room's capacity is whichever the code path happened to touch.
 */
export const DEFAULT_USER_PLAN: UserPlan = 'study_buddy';

/**
 * How many people a room created by somebody on each plan may hold.
 *
 * ## The number is decided ONCE, at creation, and never recomputed
 *
 * Epic 2's context is explicit about it: "trần gói lưu cùng phòng lúc tạo, không
 * tính lại mỗi lần có người vào". The alternative — reading the owner's plan every
 * time somebody joins — makes a room's capacity change under the people already in
 * it, silently, on a billing event nobody in the room can see. Story 2.2 issues
 * tokens against `rooms.max_participants`; it must never ask a plan again.
 *
 * ## Campus is 45, not 100
 *
 * The epic writes the Campus band as "45–100". 45 is the DEFAULT a Campus room
 * gets; 100 is {@link MAX_PARTICIPANTS_CEILING}, the technical ceiling the schema
 * refuses to store past. Treating the top of the band as the default would give
 * every Campus room a cap more than twice what the plan promises, which is a
 * capacity decision made by reading a range from the wrong end.
 *
 * A `Record<UserPlan, number>` rather than a lookup with a fallback: a fourth plan
 * added to {@link USER_PLANS} is a typecheck error here, which is the one place it
 * has to be answered.
 */
export const PLAN_PARTICIPANT_LIMITS: Readonly<Record<UserPlan, number>> = {
  study_buddy: 6,
  study_circle: 25,
  campus: 45,
};

/**
 * The largest cap the schema will store, whatever a plan says.
 *
 * It is a FLOOR under the storage rather than a default anybody gets: no value in
 * {@link PLAN_PARTICIPANT_LIMITS} reaches it today, and the reason to write it down
 * is that a plan table edited later must not be able to put an unbounded number in
 * a column that Story 2.2 will count reservations against.
 */
export const MAX_PARTICIPANTS_CEILING = 100;

/**
 * The six topics, with code-owned identifiers rather than labels.
 *
 * They are `snake_case` ASCII and they are NOT sentences: the words a person reads
 * live in `apps/web/src/app/i18n`, one key per topic in each locale, so a topic can
 * be renamed on screen in either language without a migration. A CHECK constraint
 * holding Vietnamese labels would be a translation stored in the database.
 *
 * ## `on_thi` overlaps the other five, deliberately
 *
 * It is a PURPOSE, not a subject: somebody revising for an exam is also revising a
 * subject. Keeping it is a decision rather than an oversight — a person looking for
 * a room to revise in searches with that word, and a taxonomy that is clean and
 * unsearchable helps nobody.
 *
 * `khac` is the escape hatch. Without one, the first person whose subject is not on
 * the list cannot create a room at all, and a closed list plus a required field is
 * how a taxonomy becomes a wall.
 */
export const ROOM_TOPICS = [
  'ngoai_ngu',
  'khoa_hoc_tu_nhien',
  'khoa_hoc_xa_hoi',
  'lap_trinh_cong_nghe',
  'on_thi',
  'khac',
] as const;

export const roomTopicSchema = z.enum(ROOM_TOPICS);
export type RoomTopic = z.infer<typeof roomTopicSchema>;

/**
 * Who may find the room.
 *
 * Two values, and no third: a room is either listed or it is reached by whoever the
 * owner told. There is deliberately no `secret` — a third value that behaves like
 * `private` but sounds stronger is a promise the product cannot keep, and Story 2.1
 * ships no listing or search for either value to differ on yet. What `private`
 * means operationally is Story 2.2's question (it is the token issuer that decides
 * who gets in); what it means here is the value the owner chose, stored once.
 */
export const ROOM_VISIBILITIES = ['public', 'private'] as const;

export const roomVisibilitySchema = z.enum(ROOM_VISIBILITIES);
export type RoomVisibility = z.infer<typeof roomVisibilitySchema>;

/**
 * The lifecycle, with `closing` present from the first migration.
 *
 * Epic 2's context: "Không tồn tại đường xoá cứng một phòng. Phòng có trạng thái
 * tường minh gồm `closing`; giao thức đóng phòng đầy đủ thuộc epic sau, epic này
 * chỉ có nghĩa vụ không mở cửa hậu."
 *
 * So `closing` is declared here and written by nobody in this story. That is the
 * point: the state a graceful shutdown needs has to EXIST before the protocol that
 * uses it, or the first implementation of that protocol reaches for a DELETE
 * because the schema offers nothing else. A CHECK constraint added later is a
 * migration on a populated table; a value declared early costs nothing.
 */
export const ROOM_STATUSES = ['open', 'closing', 'closed'] as const;

export const roomStatusSchema = z.enum(ROOM_STATUSES);
export type RoomStatus = z.infer<typeof roomStatusSchema>;

/** The first status every room is created in. Spelled once, read by both processes. */
export const INITIAL_ROOM_STATUS: RoomStatus = 'open';

/**
 * `POST /v1/rooms`, spelled once.
 *
 * English, like every other `/v1` path: the wire surface is the contract a future
 * mobile client reads. The Vietnamese half of the pair is
 * {@link CREATE_ROOM_PATHNAME}, which is the URL a person actually sees.
 */
export const ROOMS_PATH = '/v1/rooms';

/**
 * The route the create-room screen lives at, in `apps/web`.
 *
 * Here rather than in `apps/web` for the reason {@link SIGN_IN_PATHNAME} and
 * `DATE_OF_BIRTH_PATHNAME` are: it crosses the process boundary — `apps/api`
 * publishes it in the OpenAPI description of the endpoint behind it — and
 * `apps/web/src/app/routes.test.ts` holds every `*_PATHNAME` against the App Router
 * directory tree, which it can only do for constants that live here.
 */
export const CREATE_ROOM_PATHNAME = '/tao-phong';

/** The longest a room name may be, on the wire and in the column. */
export const MAX_ROOM_NAME_LENGTH = 120;

/** The longest a room description may be, on the wire and in the column. */
export const MAX_ROOM_DESCRIPTION_LENGTH = 2_000;

/**
 * The room as it leaves `/v1`.
 *
 * `owner_user_id` is here and the owner's NAME is not: the client already knows who
 * it is (it just created the room), and a display name on this body would be a
 * second copy of a field `/v1/auth/me` owns. Nothing about the owner's PLAN travels
 * either — `max_participants` is the whole of what the plan decided, and publishing
 * the plan itself would put a billing fact in a body that Story 2.2 hands to
 * everybody who joins.
 */
export const roomSchema = z.object({
  id: z.uuid(),
  owner_user_id: z.uuid(),
  name: z.string().min(1).max(MAX_ROOM_NAME_LENGTH),
  description: z.string().max(MAX_ROOM_DESCRIPTION_LENGTH),
  topic: roomTopicSchema,
  visibility: roomVisibilitySchema,
  max_participants: z.number().int().min(1).max(MAX_PARTICIPANTS_CEILING),
  status: roomStatusSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type Room = z.infer<typeof roomSchema>;

/**
 * The four fields a create request carries, and the cap is NOT one of them.
 *
 * `max_participants` is absent from this schema on purpose, and its absence is the
 * enforcement rather than a validation rule. A client that sends one is not
 * refused — zod strips a key the object does not declare — because refusing would
 * make the field part of the contract in the negative, and a `400` there tells a
 * caller exactly which lever exists to look for. The cap comes from the owner's
 * plan, in `apps/api`, and there is no spelling of this body that can influence it.
 *
 * `status` and `owner_user_id` are absent for the same reason: one is decided by
 * the schema's default, the other by the session.
 */
export const createRoomRequestSchema = z.object({
  name: z.string().min(1).max(MAX_ROOM_NAME_LENGTH),
  description: z.string().max(MAX_ROOM_DESCRIPTION_LENGTH),
  topic: roomTopicSchema,
  visibility: roomVisibilitySchema,
});

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/**
 * The four field names, spelled once for the form that WRITES them and the code
 * that READS them back.
 *
 * `DATE_OF_BIRTH_FIELD` exists for the same reason and its docblock records what it
 * cost: the field name was a prop the page passed into the panel, the page then
 * read the submitted form back with the constant, and the two halves had to agree
 * with nothing holding them together — every test still green if they stopped.
 * There are four names here rather than one, so the same mistake is four times as
 * available.
 *
 * snake_case is not an accident either: these are wire field names, and the browser
 * form's `name` attribute is what produces the object that is sent.
 */
export const CREATE_ROOM_FIELDS = {
  name: 'name',
  description: 'description',
  topic: 'topic',
  visibility: 'visibility',
} as const;

/**
 * The one place a create-room body from the outside world is judged, used by BOTH
 * processes (AD-13) — `apps/api` before it writes a row, `apps/web` before it
 * offers to send one.
 *
 * Same shape as `parseDateOfBirth` and `parseInternalReturnPath`: everything that
 * is not valid is `null`, nothing throws, and the caller decides what a `null`
 * means. Testing it by CLASS rather than by a list of examples is the point —
 * `AGENTS.md` records the examples-first approach as having cost four review rounds
 * on the trusted-proxy list.
 *
 * The classes it refuses, stated as rules over the whole input:
 *
 * - anything that is not a plain object — `null`, an array, a string, a number.
 *   A JSON body is whatever the caller sent, and `body.name` on a `null` throws;
 *   this function is total over `unknown` for exactly that reason;
 * - a name that is blank once trimmed, which is what `'   '` is;
 * - a name over {@link MAX_ROOM_NAME_LENGTH} or a description over
 *   {@link MAX_ROOM_DESCRIPTION_LENGTH}, measured AFTER trimming;
 * - a topic or a visibility outside the closed lists above.
 *
 * ## Trimming happens here, not in the adapter
 *
 * `'  Ôn thi cuối kỳ  '` and `'Ôn thi cuối kỳ'` are one room name written two ways,
 * and a column that stores both is a column two rooms can look identical in. The
 * trim is applied BEFORE the length checks so that `120` means 120 characters of
 * name rather than 120 characters of whatever the client's textarea left behind.
 */
export function parseCreateRoomRequest(body: unknown): CreateRoomRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const candidate = {
    name: typeof raw['name'] === 'string' ? raw['name'].trim() : raw['name'],
    description: typeof raw['description'] === 'string' ? raw['description'].trim() : raw['description'],
    topic: raw['topic'],
    visibility: raw['visibility'],
  };
  const parsed = createRoomRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The sentence somebody reads when a create-room form is refused, declared ONCE.
 *
 * It crosses the process boundary exactly as `DATE_OF_BIRTH_INVALID_MESSAGE` does:
 * `apps/api` puts it in the `validation_failed` envelope and `apps/web` shows it
 * beside the form without waiting for a round trip.
 *
 * It says what to do and nothing else. No field name, no length, no list of the
 * topics that would have been accepted — a refusal that enumerates the valid set is
 * a refusal that has published the schema to anybody who sends rubbish, and the
 * form on screen already shows every choice a person can make.
 */
export const CREATE_ROOM_INVALID_MESSAGE =
  'Chưa tạo được phòng. Hãy kiểm tra lại tên, chủ đề và quyền xem rồi thử lại.';
