import { CfnUserPool, CfnUserPoolClient } from 'aws-cdk-lib/aws-cognito';

export const COGNITO_GROUPS = ['ADMIN', 'KITCHEN'] as const;

export function applyStagingAuthOverrides(
  pool: CfnUserPool,
  client: CfnUserPoolClient,
): void {
  pool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
  pool.aliasAttributes = undefined;
  pool.autoVerifiedAttributes = undefined;
  pool.usernameAttributes = [];
  pool.accountRecoverySetting = {
    recoveryMechanisms: [{ name: 'admin_only', priority: 1 }],
  };
  pool.schema = undefined;
  pool.userAttributeUpdateSettings = undefined;

  client.explicitAuthFlows = [
    'ALLOW_USER_PASSWORD_AUTH',
    'ALLOW_USER_SRP_AUTH',
    'ALLOW_REFRESH_TOKEN_AUTH',
  ];
}
