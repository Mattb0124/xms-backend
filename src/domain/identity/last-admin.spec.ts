import { describe, expect, it } from 'vitest';
import { assertNotLastAdmin, LastAdministratorError } from './last-admin.js';

describe('the last administrator rule', () => {
  it('allows a change that leaves at least one active administrator', () => {
    expect(() =>
      assertNotLastAdmin([
        { userId: 'a', active: true, isAdministrator: true },
        { userId: 'b', active: false, isAdministrator: true },
      ]),
    ).not.toThrow();
  });

  it('refuses a change that leaves only inactive or non-administrator users', () => {
    expect(() =>
      assertNotLastAdmin([
        { userId: 'a', active: false, isAdministrator: true },
        { userId: 'b', active: true, isAdministrator: false },
      ]),
    ).toThrow(LastAdministratorError);
    expect(() => assertNotLastAdmin([])).toThrow(/last active administrator/);
  });
});
