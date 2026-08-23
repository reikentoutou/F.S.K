import {
  Duration,
  Stack,
  Tags,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import type { StagingFoundationConfig } from './staging-config.js';

export interface StagingFoundation {
  readonly vpc: ec2.Vpc;
  readonly cluster: rds.DatabaseCluster;
  readonly clusterSecret: secretsmanager.ISecret;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly databaseName: string;
}

export function createStagingFoundation(
  scope: Construct,
  config: StagingFoundationConfig,
): StagingFoundation {
  const foundationScope = new Construct(scope, 'StagingFoundation');

  for (const [key, value] of Object.entries(config.tags)) {
    Tags.of(foundationScope).add(key, value);
  }

  const vpc = new ec2.Vpc(foundationScope, 'Vpc', {
    createInternetGateway: false,
    ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/16'),
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [
      {
        cidrMask: 24,
        name: 'application',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      {
        cidrMask: 24,
        name: 'database',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    ],
  });

  vpc.addGatewayEndpoint('S3Endpoint', {
    service: ec2.GatewayVpcEndpointAwsService.S3,
  });

  const databaseSecurityGroup = new ec2.SecurityGroup(
    foundationScope,
    'DatabaseSecurityGroup',
    {
      allowAllOutbound: true,
      description: 'Access to the private FSK staging Aurora cluster',
      vpc,
    },
  );

  const engine = rds.DatabaseClusterEngine.auroraPostgres({
    version: rds.AuroraPostgresEngineVersion.of(
      config.engineVersion,
      config.engineVersion.split('.')[0],
    ),
  });
  const parameterGroup = new rds.ParameterGroup(
    foundationScope,
    'DatabaseParameterGroup',
    {
      engine,
      parameters: {
        'rds.force_ssl': '1',
      },
    },
  );
  const cluster = new rds.DatabaseCluster(foundationScope, 'Database', {
    backup: { retention: Duration.days(14) },
    credentials: rds.Credentials.fromGeneratedSecret('fsk_admin'),
    defaultDatabaseName: config.databaseName,
    deletionProtection: true,
    enableDataApi: true,
    engine,
    parameterGroup,
    securityGroups: [databaseSecurityGroup],
    serverlessV2AutoPauseDuration: Duration.minutes(5),
    serverlessV2MaxCapacity: 1,
    serverlessV2MinCapacity: 0,
    storageEncrypted: true,
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    writer: rds.ClusterInstance.serverlessV2('Writer', {
      publiclyAccessible: false,
    }),
  });
  const clusterSecret = cluster.secret;

  if (!clusterSecret) {
    throw new Error('Generated Aurora credentials secret is missing');
  }
  if (Stack.of(scope).region !== config.region) {
    throw new Error(`Staging foundation requires region ${config.region}`);
  }

  return {
    vpc,
    cluster,
    clusterSecret,
    databaseSecurityGroup,
    databaseName: config.databaseName,
  };
}
