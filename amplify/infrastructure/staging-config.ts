export const AURORA_POSTGRES_ENGINE_VERSION = '18.4' as const;

export const STAGING_TAGS = {
  Project: 'FSK',
  Environment: 'staging',
  ManagedBy: 'AmplifyGen2',
  CostCenter: 'FSK',
} as const;

export interface StagingFoundationConfig {
  readonly region: 'ap-northeast-1';
  readonly databaseName: 'fsk_staging';
  readonly engineVersion: typeof AURORA_POSTGRES_ENGINE_VERSION;
  readonly tags: typeof STAGING_TAGS;
}

export const STAGING_CONFIG: StagingFoundationConfig = {
  region: 'ap-northeast-1',
  databaseName: 'fsk_staging',
  engineVersion: AURORA_POSTGRES_ENGINE_VERSION,
  tags: STAGING_TAGS,
};
