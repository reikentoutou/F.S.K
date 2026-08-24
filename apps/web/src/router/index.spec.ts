import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';

const authSdk = vi.hoisted(() => ({
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('aws-amplify/auth', () => authSdk);

import { createAppRouter } from './index';

function sessionFor(role: 'OWNER' | 'KITCHEN') {
  return {
    tokens: {
      accessToken: { payload: {}, toString: () => 'access-token' },
      idToken: {
        payload: { sub: `${role.toLowerCase()}-subject`, 'cognito:groups': [role] },
        toString: () => 'id-token',
      },
    },
    credentials: undefined,
    identityId: undefined,
    userSub: `${role.toLowerCase()}-subject`,
  };
}

describe('application router session guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    authSdk.signOut.mockResolvedValue(undefined);
  });

  it('restores an OWNER session once on root and redirects past login to owner home', async () => {
    authSdk.fetchAuthSession.mockResolvedValue(sessionFor('OWNER'));
    authSdk.getCurrentUser.mockResolvedValue({
      userId: 'owner-subject',
      username: 'boss',
      signInDetails: undefined,
    });
    const router = createAppRouter(createMemoryHistory());

    await router.push('/');
    await router.isReady();

    expect(router.currentRoute.value.fullPath).toBe('/owner/daily');
    expect(authSdk.fetchAuthSession).toHaveBeenCalledOnce();
    expect(authSdk.getCurrentUser).toHaveBeenCalledOnce();
  });

  it('restores a KITCHEN session once when login is opened directly', async () => {
    authSdk.fetchAuthSession.mockResolvedValue(sessionFor('KITCHEN'));
    authSdk.getCurrentUser.mockResolvedValue({
      userId: 'kitchen-subject',
      username: 'kitchen',
      signInDetails: undefined,
    });
    const router = createAppRouter(createMemoryHistory());

    await router.push('/login');
    await router.isReady();

    expect(router.currentRoute.value.fullPath).toBe('/kitchen');
    expect(authSdk.fetchAuthSession).toHaveBeenCalledOnce();
    expect(authSdk.getCurrentUser).toHaveBeenCalledOnce();
  });

  it('settles on login after one unauthenticated restore attempt without redirecting in a loop', async () => {
    const noSession = Object.assign(new Error('No current user'), {
      name: 'NotAuthorizedException',
    });
    authSdk.fetchAuthSession.mockRejectedValue(noSession);
    authSdk.getCurrentUser.mockRejectedValue(noSession);
    const router = createAppRouter(createMemoryHistory());

    await router.push('/');
    await router.isReady();

    expect(router.currentRoute.value.fullPath).toBe('/login');
    expect(authSdk.fetchAuthSession).toHaveBeenCalledOnce();
  });

  it.each(['NetworkError', 'AuthTokenConfigException'])(
    'settles on login after one %s restore failure without redirecting in a loop',
    async (name) => {
      authSdk.fetchAuthSession.mockRejectedValue(
        Object.assign(new Error(name), { name }),
      );
      authSdk.getCurrentUser.mockResolvedValue({
        userId: 'unused-subject',
        username: 'unused',
        signInDetails: undefined,
      });
      const router = createAppRouter(createMemoryHistory());

      await router.push('/owner/daily');
      await router.isReady();

      expect(router.currentRoute.value.path).toBe('/login');
      expect(router.currentRoute.value.query).toEqual({
        redirect: '/owner/daily',
      });
      expect(authSdk.fetchAuthSession).toHaveBeenCalledOnce();
    },
  );
});
