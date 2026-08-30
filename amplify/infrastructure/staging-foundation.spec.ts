import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { STAGING_CONFIG, STAGING_TAGS } from './staging-config.js';
import { createStagingFoundation } from './staging-foundation.js';

const app = new App();
const stack = new Stack(app, 'TestStack', {
  env: { region: 'ap-northeast-1' },
});
const foundation = createStagingFoundation(stack, STAGING_CONFIG);
const template = Template.fromStack(stack);

const hasTag = (tags: unknown, key: string, value: string): boolean =>
  Array.isArray(tags) &&
  tags.some(
    (tag) =>
      typeof tag === 'object' &&
      tag !== null &&
      'Key' in tag &&
      'Value' in tag &&
      tag.Key === key &&
      tag.Value === value,
  );

const EXPECTED_TAGGABLE_RESOURCE_COUNTS = {
  'AWS::EC2::VPC': 1,
  'AWS::EC2::Subnet': 4,
  'AWS::EC2::RouteTable': 4,
  'AWS::EC2::VPCEndpoint': 1,
  'AWS::EC2::SecurityGroup': 1,
  'AWS::RDS::DBClusterParameterGroup': 1,
  'AWS::RDS::DBSubnetGroup': 1,
  'AWS::SecretsManager::Secret': 1,
  'AWS::RDS::DBCluster': 1,
  'AWS::RDS::DBInstance': 1,
} as const;

describe('staging foundation', () => {
  it('spans exactly two AZs with application and isolated database subnets', () => {
    const subnets = template.findResources('AWS::EC2::Subnet');
    const availabilityZoneIndexes = new Set(
      Object.values(subnets).map(
        (subnet) => subnet.Properties.AvailabilityZone['Fn::Select'][0],
      ),
    );

    expect(availabilityZoneIndexes).toEqual(new Set([0, 1]));
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.resourcePropertiesCountIs(
      'AWS::EC2::Subnet',
      Match.objectLike({
        MapPublicIpOnLaunch: false,
        Tags: Match.arrayWith([
          { Key: 'aws-cdk:subnet-name', Value: 'application' },
          { Key: 'aws-cdk:subnet-type', Value: 'Private' },
        ]),
      }),
      2,
    );
    template.resourcePropertiesCountIs(
      'AWS::EC2::Subnet',
      Match.objectLike({
        MapPublicIpOnLaunch: false,
        Tags: Match.arrayWith([
          { Key: 'aws-cdk:subnet-name', Value: 'database' },
          { Key: 'aws-cdk:subnet-type', Value: 'Isolated' },
        ]),
      }),
      2,
    );
  });

  it('has no NAT gateway or internet gateway and provides the required VPC endpoints', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: {
        'Fn::Join': [
          '',
          ['com.amazonaws.', { Ref: 'AWS::Region' }, '.s3'],
        ],
      },
      VpcEndpointType: 'Gateway',
    });
    template.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', {
      PrivateDnsEnabled: true,
      ServiceName: 'com.amazonaws.ap-northeast-1.ssm',
      VpcEndpointType: 'Interface',
    }, 0);
  });

  it('creates a private Aurora Serverless v2 cluster with the required safeguards', () => {
    expect(foundation.databaseName).toBe('fsk_staging');
    expect(foundation.clusterSecret).toBeDefined();
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      BackupRetentionPeriod: 14,
      DatabaseName: 'fsk_staging',
      DBClusterParameterGroupName: Match.anyValue(),
      DeletionProtection: true,
      EnableHttpEndpoint: true,
      Engine: 'aurora-postgresql',
      EngineVersion: '18.4',
      ServerlessV2ScalingConfiguration: {
        MaxCapacity: 1,
        MinCapacity: 0,
        SecondsUntilAutoPause: Match.anyValue(),
      },
      StorageEncrypted: true,
    });
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.serverless',
      PubliclyAccessible: false,
    });
    template.resourceCountIs('AWS::RDS::DBProxy', 0);
  });

  it('uses TLS and has no public PostgreSQL ingress', () => {
    template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: Match.objectLike({
        'rds.force_ssl': '1',
      }),
    });

    const standaloneIngressRules = Object.values(
      template.findResources('AWS::EC2::SecurityGroupIngress'),
    ).map((resource) => resource.Properties);
    const inlineIngressRules = Object.values(
      template.findResources('AWS::EC2::SecurityGroup'),
    ).flatMap((resource) => resource.Properties.SecurityGroupIngress ?? []);
    const ingressRules = [...standaloneIngressRules, ...inlineIngressRules];

    for (const rule of ingressRules) {
      const exposesPostgres =
        rule.IpProtocol === '-1' ||
        (typeof rule.FromPort === 'number' &&
          typeof rule.ToPort === 'number' &&
          rule.FromPort <= 5432 &&
          rule.ToPort >= 5432);
      const isPublic =
        rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0';

      expect(exposesPostgres && isPublic).toBe(false);
    }
  });

  it('tags every taggable foundation resource for environment and cost ownership', () => {
    const requiredTags = Object.entries(STAGING_TAGS);

    for (const [resourceType, expectedCount] of Object.entries(
      EXPECTED_TAGGABLE_RESOURCE_COUNTS,
    )) {
      const resources = template.findResources(resourceType);

      expect(
        Object.keys(resources),
        `${resourceType} resource count changed`,
      ).toHaveLength(expectedCount);
      for (const [logicalId, resource] of Object.entries(resources)) {
        expect(
          resource.Properties.Tags,
          `${logicalId} is missing the Tags property`,
        ).toBeDefined();
        for (const [key, value] of requiredTags) {
          expect(
            hasTag(resource.Properties.Tags, key, value),
            `${logicalId} is missing ${key}=${value}`,
          ).toBe(true);
        }
      }
    }
  });
});
