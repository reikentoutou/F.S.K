import { defineAuth } from '@aws-amplify/backend';

import { COGNITO_GROUPS } from './overrides';

export const auth = defineAuth({
  // Amplify currently requires email or phone here; the entrypoint L1 override
  // replaces this placeholder with immutable Cognito username-only login.
  loginWith: {
    email: true,
  },
  accountRecovery: 'NONE',
  groups: [...COGNITO_GROUPS],
  multifactor: {
    mode: 'OFF',
  },
});
