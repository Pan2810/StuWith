import {
  CREATE_ROOM_INVALID_MESSAGE,
  DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  DATE_OF_BIRTH_INVALID_MESSAGE,
  MONEY_IN_FORBIDDEN_MESSAGE,
  RATE_LIMITED_MESSAGE,
  UNAUTHENTICATED_MESSAGE,
  type UserRole,
} from '@stuwith/contracts';
import { createElement, Fragment, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './locale';
import { EN_MESSAGES } from './messages.en';

/**
 * Every sentence this product puts on a screen, in Vietnamese, in one file.
 *
 * ## Why a catalogue and not an i18n library
 *
 * Decided by a human on 2026-09-07 (ISO, because `07/09` is two dates in two
 * countries and this file is written in English), and decided on a MEASUREMENT
 * rather than a preference: this catalogue holds 2 plural strings and 6
 * interpolation templates, and the product does no locale-based routing. A library
 * brings a runtime, an ICU parser and a loading model to serve those three facts,
 * and it brings its own answer to the one question that matters here —
 * what happens when a translation is missing. Its answer is a fallback at runtime.
 * This file's answer is a type error:
 *
 * Those two counts are COUNTED, not remembered: rule 5 of
 * `tests/gates/i18n-catalogue.test.ts` reads them out of this sentence and compares
 * them with the catalogue below. The sentence said "exactly ONE string that needs a
 * plural" for two stories after `createRoom.capacity` became the second one, which
 * is what a measurement nothing measures turns into — the argument for this whole
 * decision, quietly false.
 *
 * `MessageKey` is derived from the Vietnamese catalogue below, `Dictionary` is
 * `Record<MessageKey, string>`, and `DICTIONARIES` assigns the English catalogue to
 * one. Add a key here and forget `messages.en.ts` and `pnpm typecheck` fails,
 * naming the key. Nobody has to remember to run anything.
 *
 * What is NOT solved and is worth writing down before somebody discovers it in
 * Epic 3: number, currency and duration formatting. Epic 3 brings a clock, coins
 * and money, so `Intl.NumberFormat` and `Intl.DurationFormat` will be asked
 * questions this file does not answer. If they turn out not to be enough, this is
 * the decision to revisit — and revisiting it is a human's call, not a later
 * story's.
 *
 * ## Keys, not sentences, are what components hold
 *
 * A component names a key; the dictionary owns the words. That is why the scan in
 * `tests/gates/i18n-catalogue.test.ts` can be absolute about it — a Vietnamese
 * character anywhere under `apps/web/src/app` outside this file is a string that
 * escaped, and there is no second place it could legitimately be.
 */

/**
 * Vietnamese. The key set, and therefore the contract every other locale is held
 * to.
 *
 * Deliberately NOT annotated with a type: `MessageKey` is derived FROM this object,
 * so annotating it would be circular. The keys are dotted and grouped by screen so
 * that a reader looking for "what does the declaration screen say" finds it in one
 * block rather than by grepping.
 */
const VI_MESSAGES = {
  'app.description': 'Phòng học live, ẩn danh khi cần.',

  'home.frameReady': 'Khung dự án đã dựng.',
  'home.contractVersion': 'Hợp đồng API: {version}.',
  'home.signIn': 'Đăng nhập',

  'theme.legend': 'Giao diện',
  'theme.system': 'Theo hệ điều hành',
  'theme.light': 'Sáng',
  'theme.dark': 'Tối',
  /**
   * Two whole sentences rather than one sentence with a word slotted into it.
   *
   * `appliedThemeNote` used to build `Đang dùng giao diện ${'tối' | 'sáng'}.`, which
   * works in Vietnamese and breaks the moment a language inflects the rest of the
   * sentence around the word. A translator gets a sentence; a translator never gets
   * half of one.
   */
  'theme.applied.light': 'Đang dùng giao diện sáng.',
  'theme.applied.dark': 'Đang dùng giao diện tối.',

  /**
   * The FIRST of the product's two plurals — `createRoom.capacity` is the other.
   * Vietnamese has a single plural category, so both variants are the same sentence
   * here; English needs the two, and `Intl.PluralRules` is what chooses between them.
   */
  'countdown.retryIn.one': 'Thử lại sau {seconds} giây.',
  'countdown.retryIn.other': 'Thử lại sau {seconds} giây.',
  'countdown.done': 'Bạn có thể thử lại ngay bây giờ.',

  'signIn.heading': 'Đăng nhập',
  'signIn.checkingSession': 'Đang kiểm tra phiên…',
  'signIn.chooseProvider': 'Chọn tài khoản mạng xã hội để tiếp tục:',
  'signIn.providerDisabled':
    'Provider chưa được bật trên máy chủ này sẽ trả về “không tìm thấy”.',
  'signIn.continueWith': 'Tiếp tục với {provider}',
  'signIn.signedInAs': 'Đang đăng nhập: {name} (vai trò: {role})',
  'signIn.declarePrompt':
    'Hồ sơ của bạn còn thiếu ngày sinh. Hãy khai ngày sinh để dùng đầy đủ tính năng.',
  'signIn.declareLink': 'Khai ngày sinh',
  'signIn.signOut': 'Đăng xuất',
  'signIn.outcome.failed': 'Không đăng nhập được. Thử lại hoặc chọn cách khác.',
  'signIn.outcome.cancelled': 'Bạn đã huỷ ở bước cấp quyền. Chọn lại cách đăng nhập bên dưới.',

  'sessionExpiry.title': 'Phiên đăng nhập đã kết thúc',
  'sessionExpiry.message':
    'Đăng nhập lại để tiếp tục từ chỗ bạn đang đứng. Trang này vẫn ở đây trong lúc đó.',
  'sessionExpiry.dismiss': 'Để sau',

  'profile.unavailable': 'Chưa đọc được hồ sơ của bạn. Hãy thử lại sau ít phút.',
  'profile.retry': 'Thử lại',

  'dateOfBirth.heading': 'Khai ngày sinh',
  'dateOfBirth.label': 'Ngày sinh của bạn',
  'dateOfBirth.hint': 'Chỉ khai một lần, và sau đó không tự đổi lại được.',
  'dateOfBirth.submit': 'Lưu ngày sinh',
  'dateOfBirth.declaredHeading': 'Bạn đã khai ngày sinh',
  'dateOfBirth.backToAccount': 'Về trang tài khoản',
  'dateOfBirth.signedOut': 'Bạn cần đăng nhập trước khi khai ngày sinh.',
  'dateOfBirth.toSignIn': 'Tới trang đăng nhập',
  'dateOfBirth.sessionLost': 'Phiên đăng nhập đã kết thúc. Hãy đăng nhập lại rồi thử lại.',
  'dateOfBirth.tryAgain': 'Chưa lưu được. Hãy thử lại sau ít phút.',
  'dateOfBirth.requestNotSent': 'Không gửi được yêu cầu này. Hãy tải lại trang rồi thử lại.',

  /**
   * Story 2.1 — the create-room screen.
   *
   * The six topic labels are the WORDS for `ROOM_TOPICS`, which is a wire enum of
   * `snake_case` codes. The codes never reach a screen and the words never reach the
   * database: a CHECK constraint holding Vietnamese labels would be a translation
   * stored in Postgres, and renaming one on screen would be a migration.
   *
   * `createRoom.capacity` is the product's SECOND plural, and the first one that was
   * not written for a countdown. Vietnamese has one plural category so both variants
   * are the same sentence; English needs two, and `Intl.PluralRules` chooses.
   */
  'createRoom.link': 'Tạo phòng học',
  'createRoom.heading': 'Tạo phòng học',
  'createRoom.nameLabel': 'Tên phòng',
  'createRoom.nameHint': 'Người khác nhìn thấy tên này khi tìm phòng.',
  'createRoom.descriptionLabel': 'Mô tả (không bắt buộc)',
  'createRoom.descriptionHint': 'Nói ngắn gọn buổi học diễn ra thế nào.',
  'createRoom.topicLegend': 'Chủ đề',
  'createRoom.visibilityLegend': 'Ai vào được',
  'createRoom.visibilityPublic': 'Ai cũng có thể tìm thấy',
  'createRoom.visibilityPrivate': 'Chỉ người có liên kết',
  'createRoom.submit': 'Tạo phòng',
  'createRoom.createdHeading': 'Đã tạo phòng',
  'createRoom.createdName': 'Phòng của bạn: {name}',
  'createRoom.capacity.one': 'Phòng này nhận tối đa {count} người.',
  'createRoom.capacity.other': 'Phòng này nhận tối đa {count} người.',
  'createRoom.createAnother': 'Tạo phòng khác',
  'createRoom.signedOut': 'Bạn cần đăng nhập trước khi tạo phòng.',
  'createRoom.toSignIn': 'Tới trang đăng nhập',
  'createRoom.sessionLost': 'Phiên đăng nhập đã kết thúc. Hãy đăng nhập lại rồi thử lại.',
  'createRoom.tryAgain': 'Chưa tạo được phòng. Hãy thử lại sau ít phút.',
  'createRoom.requestNotSent': 'Không gửi được yêu cầu này. Hãy tải lại trang rồi thử lại.',
  'createRoom.topicNgoaiNgu': 'Ngoại ngữ',
  'createRoom.topicKhoaHocTuNhien': 'Khoa học tự nhiên',
  'createRoom.topicKhoaHocXaHoi': 'Khoa học xã hội',
  'createRoom.topicLapTrinhCongNghe': 'Lập trình và công nghệ',
  'createRoom.topicOnThi': 'Ôn thi',
  'createRoom.topicKhac': 'Khác',

  /**
   * Roles as words, which is a defect fixed rather than a feature added.
   *
   * `SignedInPanel` rendered `{user.role}` raw, so an organisation administrator
   * read "(vai trò: org_admin)" on their own account page. `USER_ROLES` is a wire
   * enum: it is the vocabulary two processes agree on, and it is not a label in any
   * language. {@link roleMessageKey} maps one to the other, and `ROLE_MESSAGE_KEYS`
   * below is a `Record<UserRole, MessageKey>` so a seventh role added to the
   * contract is a typecheck error here rather than a raw identifier on a screen.
   */
  'role.guest': 'Khách',
  'role.user': 'Thành viên',
  'role.host': 'Chủ phòng',
  'role.orgAdmin': 'Quản trị tổ chức',
  'role.moderator': 'Kiểm duyệt viên',
  'role.systemAdmin': 'Quản trị hệ thống',
  /** For a role this build does not recognise: a true, general word, never the raw value. */
  'role.unknown': 'Thành viên',

  /**
   * The six sentences `packages/contracts` owns, IMPORTED rather than retyped.
   *
   * One string, two consumers — `apps/api` puts it on the wire, this catalogue puts
   * it on a screen — and no copy for an edit to miss. Retyping any of them here is
   * the exact defect `tests/gates/i18n-catalogue.test.ts` refuses: it holds this
   * file's text against the contract's own constants.
   *
   * Two of the six (`unauthenticated`, `moneyInForbidden`) are not rendered by any
   * screen today. They are here because the rule is about the STRING having one
   * home, and because Epic 3 hides money controls behind the second of them.
   */
  'error.rateLimited': RATE_LIMITED_MESSAGE,
  'error.dateOfBirthInvalid': DATE_OF_BIRTH_INVALID_MESSAGE,
  'error.dateOfBirthAlreadySet': DATE_OF_BIRTH_ALREADY_SET_MESSAGE,
  'error.createRoomInvalid': CREATE_ROOM_INVALID_MESSAGE,
  'error.unauthenticated': UNAUTHENTICATED_MESSAGE,
  'error.moneyInForbidden': MONEY_IN_FORBIDDEN_MESSAGE,
};

/** Every key a component may name. Derived, so the catalogue is the only list. */
export type MessageKey = keyof typeof VI_MESSAGES;

/** One locale's complete catalogue. A missing key is a compile error, not a blank. */
export type Dictionary = Readonly<Record<MessageKey, string>>;

/**
 * The table both locales are held to, and the ONE line that makes a missing English
 * translation a build failure.
 *
 * `EN_MESSAGES` arrives untyped from a module that imports nothing (see the docblock
 * there for why the obvious `Record<MessageKey, string>` annotation would be a
 * dependency cycle). This assignment is where it meets the key set.
 */
const DICTIONARIES: Readonly<Record<Locale, Dictionary>> = {
  vi: VI_MESSAGES,
  en: EN_MESSAGES,
};

/** The catalogue for a locale. Total by construction — `Locale` has two members. */
export function messagesFor(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

/** What may be substituted into a sentence when the result has to be a string. */
export type MessageValues = Readonly<Record<string, string | number>>;

/** What may be substituted when a piece of the sentence is markup — see {@link Translate.nodes}. */
export type NodeValues = Readonly<Record<string, ReactNode>>;

/**
 * A translator bound to one locale.
 *
 * It is callable, because `t('signIn.heading')` is what a component wants to write,
 * and it carries three things on the side that a bare function could not:
 *
 * - `locale`, so a caller that needs `Intl` (a plural, a number, a date) asks the
 *   translator rather than re-deriving the answer;
 * - `plural`, which is `Intl.PluralRules` plus the `.one` / `.other` key
 *   convention, so a plural is never open-coded at its call site;
 * - `nodes`, for the sentences that contain MARKUP — a name in `<strong>`, a
 *   provider name that has to carry `lang="en"` inside a Vietnamese sentence. The
 *   alternative is splitting a sentence into fragments around the markup, which
 *   hands a translator half a sentence and gets a wrong word order in return.
 */
export interface Translate {
  (key: MessageKey, values?: MessageValues): string;
  readonly locale: Locale;
  readonly plural: (base: PluralMessageBase, count: number, values?: MessageValues) => string;
  readonly nodes: (key: MessageKey, values: NodeValues) => ReactNode[];
}

/**
 * The two plural categories this product's locales use.
 *
 * English selects between them; Vietnamese always selects `other`. A language with
 * `few` or `many` would need more rows in the catalogue, and
 * {@link Translate.plural} falls back to `.other` for exactly that case rather than
 * rendering nothing.
 */
type PluralCategory = 'one' | 'other';

/**
 * Every catalogue key that is one half of a plural pair, with the suffix removed.
 *
 * Derived from `MessageKey`, so a second plural added to the catalogue becomes
 * callable the moment both of its variants exist — and a base with only one variant
 * is not expressible.
 */
export type PluralMessageBase = {
  [K in MessageKey]: K extends `${infer Base}.${PluralCategory}` ? Base : never;
}[MessageKey];

/**
 * `{name}` — a letter, then letters, digits or underscores.
 *
 * Deliberately narrow. A pattern like `\{([^}]+)\}` would also match a stray brace
 * in prose and quietly delete it from the sentence.
 */
const PLACEHOLDER_SOURCE = '\\{([A-Za-z][A-Za-z0-9_]*)\\}';

/**
 * A placeholder with no value is LEFT ON THE SCREEN, not blanked.
 *
 * Blanking it produces "Thử lại sau  giây." — a sentence that reads as merely
 * clumsy, so nobody reports it and nothing fails. `{seconds}` in the middle of a
 * sentence is unmistakably a bug, which is what an unnoticeable failure should be
 * turned into.
 */
export function formatMessage(template: string, values?: MessageValues): string {
  if (values === undefined) {
    return template;
  }
  return template.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), (whole, name: string) => {
    const value = values[name];
    /**
     * `null` counts as absent as well as `undefined`, and that is what keeps this
     * function and {@link formatParts} telling the same story. `MessageValues` does
     * not admit `null`, so this branch is unreachable through the types — but the
     * values reaching here come from call sites, and `String(null)` is `'null'`,
     * which is the one substitution nobody could ever have meant.
     */
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * The same substitution, but the values may be markup.
 *
 * Returns the sentence as an array of React children — the literal text between
 * placeholders, and whatever node was supplied for each one. Each supplied node is
 * wrapped in a keyed `Fragment`: React warns about a keyless element in an array,
 * and a warning in a live region is a warning nobody reads.
 *
 * ## `undefined` and `null` are ABSENT, not empty
 *
 * `name in values` was the whole test, and it disagreed with {@link formatMessage}
 * on the one case that matters: `{ name: undefined }` HAS the key, so the slot was
 * filled with a value React renders as nothing — the placeholder vanished, the
 * sentence closed up around the hole, and the result read as merely clumsy rather
 * than as a bug. That is exactly the failure `formatMessage` refuses to ship, in
 * the same words, two functions apart. The two now behave identically: a slot with
 * nothing to put in it keeps its `{name}` on the screen.
 */
export function formatParts(template: string, values: NodeValues): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let slot = 0;

  for (const match of template.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    const name = match[1] ?? '';
    const value = values[name];
    if (value === undefined || value === null) {
      // Same rule as `formatMessage`: an unfilled placeholder stays visible.
      continue;
    }
    const at = match.index;
    if (at > cursor) {
      parts.push(template.slice(cursor, at));
    }
    slot += 1;
    parts.push(createElement(Fragment, { key: `${name}-${slot}` }, value));
    cursor = at + match[0].length;
  }

  if (cursor < template.length) {
    parts.push(template.slice(cursor));
  }
  return parts;
}

/** A translator over one locale's catalogue. The provider builds one; so does {@link translatorFor}. */
export function makeTranslate(locale: Locale, dictionary: Dictionary): Translate {
  const translate = (key: MessageKey, values?: MessageValues): string =>
    formatMessage(dictionary[key], values);

  return Object.assign(translate, {
    locale,
    plural: (base: PluralMessageBase, count: number, values?: MessageValues): string => {
      const selected = new Intl.PluralRules(locale).select(count);
      /**
       * Narrowed to the two categories the catalogue carries, rather than cast.
       * `select` can answer `few` or `many` for a language this product does not
       * have yet, and `other` is the row every plural set is required to have.
       */
      const category: PluralCategory = selected === 'one' ? 'one' : 'other';
      return formatMessage(dictionary[`${base}.${category}`], values);
    },
    nodes: (key: MessageKey, values: NodeValues): ReactNode[] =>
      formatParts(dictionary[key], values),
  });
}

/** A translator for a locale, catalogue included. */
export function translatorFor(locale: Locale): Translate {
  return makeTranslate(locale, messagesFor(locale));
}

/**
 * Vietnamese, ready to use without a provider.
 *
 * It is the React context's DEFAULT value, which is what makes "no locale falls back
 * to a raw key" true by construction rather than by care: a component rendered
 * outside the provider — including every component `renderToStaticMarkup` runs in
 * the DOM-less `web` Vitest project — gets real Vietnamese sentences.
 *
 * It is also the default argument of the pure functions that used to build a
 * sentence themselves (`countdownLabel`, `appliedThemeNote`, `unavailableMessage`),
 * so the ~40 unit assertions written against those keep asserting the same strings.
 */
export const VI_TRANSLATE: Translate = translatorFor(DEFAULT_LOCALE);

/**
 * Wire role -> label key. A `Record<UserRole, MessageKey>`, so a role added to
 * `packages/contracts` fails `pnpm typecheck` here instead of appearing raw on a
 * screen.
 */
const ROLE_MESSAGE_KEYS: Readonly<Record<UserRole, MessageKey>> = {
  guest: 'role.guest',
  user: 'role.user',
  host: 'role.host',
  org_admin: 'role.orgAdmin',
  moderator: 'role.moderator',
  system_admin: 'role.systemAdmin',
};

/**
 * The same table as a `Map`, so the lookup below takes a plain `string` without a
 * cast. The `Record` above is what the compiler checks; this is what runs.
 */
const ROLE_LOOKUP = new Map<string, MessageKey>(Object.entries(ROLE_MESSAGE_KEYS));

/**
 * The label key for a role, including one this build has never heard of.
 *
 * `parseCurrentUser` validates the role against the contract enum, so an unknown
 * value should be impossible — and the fallback is here anyway, because the failure
 * it prevents is a raw wire identifier on somebody's account page, and the cost of
 * preventing it is one `??`.
 */
export function roleMessageKey(role: string): MessageKey {
  return ROLE_LOOKUP.get(role) ?? 'role.unknown';
}
