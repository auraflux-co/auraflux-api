'use strict';
/**
 * test/account_members.test.js — CPD-130: RBAC unit tests
 */

const { MEMBER_ROLES, ROLE_LEVEL, PERMISSIONS, roleAtLeast, can } = require('../lib/services/account_members');

describe('account_members service — pure helpers', () => {

  describe('MEMBER_ROLES', () => {
    test('contains the four expected roles', () => {
      expect(MEMBER_ROLES).toEqual(['owner', 'admin', 'member', 'billing']);
    });
  });

  describe('ROLE_LEVEL', () => {
    test('owner has highest level', () => {
      expect(ROLE_LEVEL.owner).toBeGreaterThan(ROLE_LEVEL.admin);
      expect(ROLE_LEVEL.admin).toBeGreaterThan(ROLE_LEVEL.member);
      expect(ROLE_LEVEL.member).toBeGreaterThan(ROLE_LEVEL.billing);
    });
  });

  describe('roleAtLeast()', () => {
    test('owner satisfies all min levels', () => {
      for (const r of MEMBER_ROLES) {
        expect(roleAtLeast('owner', r)).toBe(true);
      }
    });

    test('billing only satisfies itself', () => {
      expect(roleAtLeast('billing', 'billing')).toBe(true);
      expect(roleAtLeast('billing', 'member')).toBe(false);
      expect(roleAtLeast('billing', 'admin')).toBe(false);
      expect(roleAtLeast('billing', 'owner')).toBe(false);
    });

    test('member satisfies member and billing', () => {
      expect(roleAtLeast('member', 'member')).toBe(true);
      expect(roleAtLeast('member', 'billing')).toBe(true);
      expect(roleAtLeast('member', 'admin')).toBe(false);
    });

    test('unknown role returns false', () => {
      expect(roleAtLeast('unknown', 'billing')).toBe(false);
    });
  });

  describe('can()', () => {
    test('owner can do everything', () => {
      for (const perm of Object.keys(PERMISSIONS)) {
        expect(can('owner', perm)).toBe(true);
      }
    });

    test('member cannot manage billing', () => {
      expect(can('member', 'manage_billing')).toBe(false);
    });

    test('billing can view jobs but not submit', () => {
      expect(can('billing', 'view_jobs')).toBe(true);
      expect(can('billing', 'submit_jobs')).toBe(false);
    });

    test('admin can invite but not change roles', () => {
      expect(can('admin', 'invite_members')).toBe(true);
      expect(can('admin', 'change_roles')).toBe(false);
    });

    test('unknown permission returns false', () => {
      expect(can('owner', 'does_not_exist')).toBe(false);
    });
  });
});
