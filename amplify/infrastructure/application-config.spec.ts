import { beforeAll, describe, expect, it } from 'vitest';

interface ApplicationConfigModule {
  readonly APPLICATION_CONFIG: { readonly region: string };
  readonly APPLICATION_TAGS: Readonly<Record<string, string>>;
}

let configModule: ApplicationConfigModule | undefined;
let configLoadError: unknown;

beforeAll(async () => {
  try {
    configModule = (await import(
      './application-config.js'
    )) as ApplicationConfigModule;
  } catch (error) {
    configLoadError = error;
  }
});

describe('production application configuration', () => {
  it('pins the FSK application to Tokyo', () => {
    expect(configLoadError).toBeUndefined();
    expect(configModule?.APPLICATION_CONFIG).toEqual({
      region: 'ap-northeast-1',
    });
  });

  it('defines the complete production ownership tags', () => {
    expect(configLoadError).toBeUndefined();
    expect(configModule?.APPLICATION_TAGS).toEqual({
      Project: 'FSK',
      Environment: 'production',
      ManagedBy: 'AmplifyGen2',
      CostCenter: 'FSK',
    });
  });
});
