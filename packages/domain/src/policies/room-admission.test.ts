import { describe, expect, it } from 'vitest';
import { FixedClock } from '../ports/clock-port';
import { roomAdmission, type RoomAdmissionSubject } from './room-admission';

const TODAY = new FixedClock(new Date('2026-09-12T09:00:00.000Z'));

const person = (overrides: Partial<RoomAdmissionSubject> = {}): RoomAdmissionSubject => ({
  bannedAt: null,
  dateOfBirth: null,
  ...overrides,
});

describe('roomAdmission — the person half of the admission decision', () => {
  it('admits somebody who is not banned', () => {
    expect(roomAdmission(person(), TODAY)).toBe('admitted');
  });

  it('refuses somebody with a ban timestamp, whatever the instant', () => {
    expect(roomAdmission(person({ bannedAt: new Date('2026-09-01T00:00:00Z') }), TODAY)).toBe(
      'banned',
    );
    // A ban dated in the FUTURE is still a ban. There is no "scheduled ban" state
    // and reading one in would be a second rule on the column.
    expect(roomAdmission(person({ bannedAt: new Date('2099-01-01T00:00:00Z') }), TODAY)).toBe(
      'banned',
    );
  });

  it('fails CLOSED on a bannedAt that is undefined, the shape a lost column produces', () => {
    // `selectUserColumns` in `packages/db` names the column; drop it and the row
    // comes back with `banned_at` undefined and every type still satisfied. The
    // control must refuse, not admit, on its own ignorance.
    const lostColumn = { dateOfBirth: null } as unknown as RoomAdmissionSubject;
    expect(roomAdmission(lostColumn, TODAY)).toBe('banned');
  });

  it('has NO age floor: a minor, an undeclared profile and an adult are all admitted', () => {
    // PRD US-0.5 AC3. The `underage` branch exists in the type and is reached by
    // nothing today; this example is what turns red when somebody adds a floor
    // without a story that asked for one.
    expect(roomAdmission(person({ dateOfBirth: '2015-06-01' }), TODAY)).toBe('admitted');
    expect(roomAdmission(person({ dateOfBirth: null }), TODAY)).toBe('admitted');
    expect(roomAdmission(person({ dateOfBirth: '1990-01-01' }), TODAY)).toBe('admitted');
  });

  it('answers the same whatever the clock says, because no rule reads it yet', () => {
    const broken = { now: () => new Date('not-a-date') };
    expect(roomAdmission(person(), broken)).toBe('admitted');
    expect(roomAdmission(person({ bannedAt: new Date(0) }), broken)).toBe('banned');
  });
});
