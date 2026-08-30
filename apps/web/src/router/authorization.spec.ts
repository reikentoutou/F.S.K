import { describe, expect, it } from 'vitest';

import type { AuthUser } from '@/stores/auth';
import { authorizeNavigation } from './authorization';

const owner: AuthUser = {
  subject: 'owner-subject',
  username: 'boss',
  role: 'OWNER',
};

const kitchen: AuthUser = {
  subject: 'kitchen-subject',
  username: 'kitchen',
  role: 'KITCHEN',
};

describe('authorizeNavigation', () => {
  it('redirects an unauthenticated protected request to login with its original path', () => {
    expect(
      authorizeNavigation(
        { path: '/owner/daily', isPublic: false, requiredRole: 'OWNER' },
        null,
      ),
    ).toEqual({ name: 'login', query: { redirect: '/owner/daily' } });
  });

  it('allows OWNER to enter protected owner routes', () => {
    expect(
      authorizeNavigation(
        { path: '/owner/settings', isPublic: false, requiredRole: 'OWNER' },
        owner,
      ),
    ).toBe(true);
  });

  it.each(['/kitchen', '/kitchen/report/2026-08-24/night']) (
    'allows KITCHEN to enter the create-only route %s',
    (path) => {
      expect(
        authorizeNavigation(
          { path, isPublic: false, requiredRole: 'KITCHEN' },
          kitchen,
        ),
      ).toBe(true);
    },
  );

  it.each([
    '/kitchen/history',
    '/kitchen/analytics',
    '/kitchen/settings',
    '/owner/daily',
    '/protected/unknown',
  ])('returns KITCHEN to its home for forbidden protected path %s', (path) => {
    expect(
      authorizeNavigation(
        {
          path,
          isPublic: false,
          requiredRole: path.startsWith('/owner') ? 'OWNER' : undefined,
        },
        kitchen,
      ),
    ).toEqual({ name: 'kitchen-home' });
  });

  it('returns OWNER to its home instead of allowing a kitchen route', () => {
    expect(
      authorizeNavigation(
        { path: '/kitchen', isPublic: false, requiredRole: 'KITCHEN' },
        owner,
      ),
    ).toEqual({ name: 'owner-home' });
  });

  it('allows the public login route without a session', () => {
    expect(
      authorizeNavigation({ path: '/login', isPublic: true }, null),
    ).toBe(true);
  });

  it('returns an authenticated user away from login to the role home', () => {
    expect(
      authorizeNavigation({ path: '/login', isPublic: true }, owner),
    ).toEqual({ name: 'owner-home' });
    expect(
      authorizeNavigation({ path: '/login', isPublic: true }, kitchen),
    ).toEqual({ name: 'kitchen-home' });
  });
});
