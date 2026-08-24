import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const authSdk = vi.hoisted(() => ({
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('aws-amplify/auth', () => authSdk);

import { AuthStoreError, useAuthStore } from './auth';

function signedInSession(groups: unknown) {
  return {
    tokens: {
      accessToken: {
        payload: {},
        toString: () => 'access-token',
      },
      idToken: {
        payload: {
          sub: 'subject-1',
          'cognito:groups': groups,
        },
        toString: () => 'id-token',
      },
    },
    credentials: undefined,
    identityId: undefined,
    userSub: 'subject-1',
  };
}

function completeSignIn() {
  return {
    isSignedIn: true,
    nextStep: { signInStep: 'DONE' },
  };
}

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    authSdk.signOut.mockResolvedValue(undefined);
    authSdk.getCurrentUser.mockResolvedValue({
      userId: 'subject-1',
      username: 'boss',
      signInDetails: undefined,
    });
  });

  it('signs in with Cognito and derives the OWNER user from the ID-token group', async () => {
    authSdk.signIn.mockResolvedValue(completeSignIn());
    authSdk.fetchAuthSession.mockResolvedValue(signedInSession(['OWNER']));
    const store = useAuthStore();

    const result = await store.login('boss', 'temporary-password');

    expect(result).toBe('SIGNED_IN');
    expect(authSdk.signIn).toHaveBeenCalledWith({
      username: 'boss',
      password: 'temporary-password',
    });
    expect(store.user).toEqual({
      subject: 'subject-1',
      username: 'boss',
      role: 'OWNER',
    });
    expect(store.isAuthenticated).toBe(true);
    expect(store.isOwner).toBe(true);
  });

  it('pauses sign-in for the required first-password change without creating a user session', async () => {
    authSdk.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
        missingAttributes: [],
      },
    });
    const store = useAuthStore();

    const result = await store.login('kitchen', 'temporary-password');

    expect(result).toBe('NEW_PASSWORD_REQUIRED');
    expect(store.user).toBeNull();
    expect(store.newPasswordRequired).toBe(true);
    expect(authSdk.fetchAuthSession).not.toHaveBeenCalled();
  });

  it('confirms the new password and hydrates the KITCHEN session', async () => {
    authSdk.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
        missingAttributes: [],
      },
    });
    authSdk.confirmSignIn.mockResolvedValue(completeSignIn());
    authSdk.fetchAuthSession.mockResolvedValue(signedInSession(['KITCHEN']));
    authSdk.getCurrentUser.mockResolvedValue({
      userId: 'subject-2',
      username: 'kitchen',
      signInDetails: undefined,
    });
    const store = useAuthStore();
    await store.login('kitchen', 'temporary-password');

    await store.confirmNewPassword('new-secure-password');

    expect(authSdk.confirmSignIn).toHaveBeenCalledWith({
      challengeResponse: 'new-secure-password',
    });
    expect(store.newPasswordRequired).toBe(false);
    expect(store.user).toEqual({
      subject: 'subject-2',
      username: 'kitchen',
      role: 'KITCHEN',
    });
  });

  it('classifies a rejected first-password challenge as a password-update failure', async () => {
    authSdk.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
        missingAttributes: [],
      },
    });
    authSdk.confirmSignIn.mockRejectedValue(
      Object.assign(new Error('Challenge rejected'), {
        name: 'NotAuthorizedException',
      }),
    );
    const store = useAuthStore();
    await store.login('kitchen', 'temporary-password');

    await expect(
      store.confirmNewPassword('rejected-password'),
    ).rejects.toMatchObject({ code: 'PASSWORD_UPDATE_FAILED' });

    expect(store.user).toBeNull();
    expect(store.newPasswordRequired).toBe(true);
  });

  it.each([
    ['no group', undefined],
    ['multiple groups', ['OWNER', 'KITCHEN']],
    ['legacy ADMIN group', ['ADMIN']],
    ['legacy WEBMASTER group', ['WEBMASTER']],
  ])('fails closed for %s', async (_label, groups) => {
    authSdk.fetchAuthSession.mockResolvedValue(signedInSession(groups));
    const store = useAuthStore();

    await expect(store.restoreSession()).rejects.toMatchObject({
      code: 'ROLE_INVALID',
    });

    expect(store.user).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(authSdk.signOut).toHaveBeenCalledOnce();
  });

  it('restores the Cognito session without reading or writing application localStorage', async () => {
    authSdk.fetchAuthSession.mockResolvedValue(signedInSession(['OWNER']));
    const store = useAuthStore();

    const restored = await store.restoreSession();

    expect(restored).toBe(true);
    expect(authSdk.getCurrentUser).toHaveBeenCalledOnce();
    expect(store.user?.role).toBe('OWNER');
  });

  it('uses Cognito signOut and clears local auth state', async () => {
    authSdk.fetchAuthSession.mockResolvedValue(signedInSession(['OWNER']));
    const store = useAuthStore();
    await store.restoreSession();

    await store.logout();

    expect(authSdk.signOut).toHaveBeenCalledOnce();
    expect(store.user).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it.each([
    ['NotAuthorizedException', 'CREDENTIALS_INVALID'],
    ['InvalidPasswordException', 'PASSWORD_UPDATE_FAILED'],
    ['AuthTokenConfigException', 'CONFIGURATION_ERROR'],
    ['NetworkError', 'NETWORK_ERROR'],
  ] as const)(
    'maps %s to a stable login failure category',
    async (name, expectedCode) => {
      authSdk.signIn.mockRejectedValue(Object.assign(new Error(name), { name }));
      const store = useAuthStore();

      const error = await store.login('boss', 'bad-password').catch((caught) => caught);

      expect(error).toBeInstanceOf(AuthStoreError);
      expect(error).toMatchObject({ code: expectedCode });
    },
  );
});
