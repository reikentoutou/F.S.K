import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  confirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  signIn,
  signOut,
} from 'aws-amplify/auth';

export type AppRole = 'OWNER' | 'KITCHEN';

export interface AuthUser {
  subject: string;
  username: string;
  role: AppRole;
}

export type AuthStoreErrorCode =
  | 'CREDENTIALS_INVALID'
  | 'PASSWORD_UPDATE_FAILED'
  | 'NETWORK_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'ROLE_INVALID'
  | 'SIGN_IN_STEP_UNSUPPORTED';

export class AuthStoreError extends Error {
  constructor(
    readonly code: AuthStoreErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'AuthStoreError';
  }
}

export type LoginResult = 'SIGNED_IN' | 'NEW_PASSWORD_REQUIRED';

function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    return String(error.name);
  }
  return '';
}

function translateAuthError(
  error: unknown,
  operation: 'LOGIN' | 'PASSWORD_UPDATE' | 'SESSION',
): AuthStoreError {
  if (error instanceof AuthStoreError) return error;
  const name = errorName(error);
  if (name.includes('Config')) {
    return new AuthStoreError('CONFIGURATION_ERROR', { cause: error });
  }
  if (
    name === 'NetworkError' ||
    error instanceof TypeError ||
    (error instanceof Error && /network|failed to fetch/i.test(error.message))
  ) {
    return new AuthStoreError('NETWORK_ERROR', { cause: error });
  }
  if (
    operation === 'PASSWORD_UPDATE' ||
    name === 'InvalidPasswordException' ||
    name === 'InvalidParameterException'
  ) {
    return new AuthStoreError('PASSWORD_UPDATE_FAILED', { cause: error });
  }
  if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
    return new AuthStoreError('CREDENTIALS_INVALID', { cause: error });
  }
  return new AuthStoreError('CREDENTIALS_INVALID', { cause: error });
}

function businessRole(groups: unknown): AppRole {
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw new AuthStoreError('ROLE_INVALID');
  }
  const [role] = groups;
  if (role !== 'OWNER' && role !== 'KITCHEN') {
    throw new AuthStoreError('ROLE_INVALID');
  }
  return role;
}

export const useAuthStore = defineStore('auth', () => {
  const user = shallowRef<AuthUser | null>(null);
  const initialized = shallowRef(false);
  const newPasswordRequired = shallowRef(false);

  const isAuthenticated = computed(() => user.value !== null);
  const isOwner = computed(() => user.value?.role === 'OWNER');
  const isKitchen = computed(() => user.value?.role === 'KITCHEN');

  async function hydrateUser(): Promise<void> {
    const [session, currentUser] = await Promise.all([
      fetchAuthSession(),
      getCurrentUser(),
    ]);
    const role = businessRole(
      session.tokens?.idToken?.payload['cognito:groups'],
    );
    user.value = {
      subject: currentUser.userId,
      username: currentUser.username,
      role,
    };
    initialized.value = true;
  }

  async function rejectInvalidRole(error: AuthStoreError): Promise<never> {
    user.value = null;
    initialized.value = true;
    await signOut();
    throw error;
  }

  async function login(username: string, password: string): Promise<LoginResult> {
    try {
      const result = await signIn({ username, password });
      if (
        result.nextStep.signInStep ===
        'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
      ) {
        user.value = null;
        newPasswordRequired.value = true;
        return 'NEW_PASSWORD_REQUIRED';
      }
      if (!result.isSignedIn || result.nextStep.signInStep !== 'DONE') {
        throw new AuthStoreError('SIGN_IN_STEP_UNSUPPORTED');
      }
      await hydrateUser();
      newPasswordRequired.value = false;
      return 'SIGNED_IN';
    } catch (error) {
      const translated = translateAuthError(error, 'LOGIN');
      if (translated.code === 'ROLE_INVALID') {
        return rejectInvalidRole(translated);
      }
      throw translated;
    }
  }

  async function confirmNewPassword(password: string): Promise<void> {
    try {
      const result = await confirmSignIn({ challengeResponse: password });
      if (!result.isSignedIn || result.nextStep.signInStep !== 'DONE') {
        throw new AuthStoreError('SIGN_IN_STEP_UNSUPPORTED');
      }
      await hydrateUser();
      newPasswordRequired.value = false;
    } catch (error) {
      const translated = translateAuthError(error, 'PASSWORD_UPDATE');
      if (translated.code === 'ROLE_INVALID') {
        return rejectInvalidRole(translated);
      }
      throw translated;
    }
  }

  async function restoreSession(): Promise<boolean> {
    if (initialized.value) return user.value !== null;
    try {
      await hydrateUser();
      return true;
    } catch (error) {
      const translated = translateAuthError(error, 'SESSION');
      user.value = null;
      initialized.value = true;
      if (translated.code === 'ROLE_INVALID') {
        return rejectInvalidRole(translated);
      }
      if (translated.code === 'CREDENTIALS_INVALID') return false;
      throw translated;
    }
  }

  async function logout(): Promise<void> {
    try {
      await signOut();
    } finally {
      user.value = null;
      initialized.value = true;
      newPasswordRequired.value = false;
    }
  }

  return {
    user,
    initialized,
    newPasswordRequired,
    isAuthenticated,
    isOwner,
    isKitchen,
    login,
    confirmNewPassword,
    restoreSession,
    logout,
  };
});
