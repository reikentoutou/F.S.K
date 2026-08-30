import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CfnUserPool, CfnUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { describe, expect, it } from 'vitest';

import { applyProductionAuthOverrides, COGNITO_GROUPS } from './overrides.js';

describe('production Cognito overrides', () => {
  it('keeps the authorized groups limited to OWNER and KITCHEN', () => {
    expect(COGNITO_GROUPS).toEqual(['OWNER', 'KITCHEN']);
    expect(COGNITO_GROUPS).not.toContain('ADMIN');
    expect(COGNITO_GROUPS).not.toContain('WEBMASTER');
  });

  it('enforces username-only administrator-managed accounts and required client flows', () => {
    const stack = new Stack();
    const pool = new CfnUserPool(stack, 'Pool', {
      aliasAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      usernameAttributes: ['email'],
      accountRecoverySetting: {
        recoveryMechanisms: [{ name: 'verified_email', priority: 1 }],
      },
      schema: [{ name: 'email', required: true }],
      userAttributeUpdateSettings: {
        attributesRequireVerificationBeforeUpdate: ['email'],
      },
    });
    const client = new CfnUserPoolClient(stack, 'Client', {
      userPoolId: pool.ref,
    });

    applyProductionAuthOverrides(pool, client);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AliasAttributes: Match.absent(),
      AutoVerifiedAttributes: Match.absent(),
      UsernameAttributes: [],
      Schema: Match.absent(),
      UserAttributeUpdateSettings: Match.absent(),
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }],
      },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: [
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ],
    });
  });
});
