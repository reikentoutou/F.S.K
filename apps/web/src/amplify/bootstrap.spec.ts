import { describe, expect, it, vi } from 'vitest';

import {
  AmplifyConfigurationError,
  bootstrapAmplifyApp,
} from './bootstrap';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validOutputs(): Record<string, unknown> {
  return {
    version: '1.4',
    auth: {
      aws_region: 'ap-northeast-1',
      user_pool_id: 'ap-northeast-1_example',
      user_pool_client_id: 'client-id',
      identity_pool_id: 'ap-northeast-1:identity-pool-id',
    },
    data: {
      aws_region: 'ap-northeast-1',
      url: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
      default_authorization_type: 'AMAZON_COGNITO_USER_POOLS',
      model_introspection: { version: 1 },
    },
    storage: {
      aws_region: 'ap-northeast-1',
      bucket_name: 'fsk-production-storage',
    },
  };
}

describe('bootstrapAmplifyApp', () => {
  it('configures Amplify exactly once before mounting the Vue application', async () => {
    const outputs = validOutputs();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(outputs));
    const configure = vi.fn();
    const mount = vi.fn();
    const showConfigurationError = vi.fn();

    const started = await bootstrapAmplifyApp({
      fetchImpl,
      configure,
      mount,
      showConfigurationError,
    });

    expect(started).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/amplify_outputs.json', {
      cache: 'no-store',
    });
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith(outputs);
    expect(configure.mock.invocationCallOrder[0]).toBeLessThan(
      mount.mock.invocationCallOrder[0]!,
    );
    expect(mount).toHaveBeenCalledOnce();
    expect(showConfigurationError).not.toHaveBeenCalled();
  });

  it('shows a retryable configuration error and never mounts when outputs are missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const configure = vi.fn();
    const mount = vi.fn();
    const showConfigurationError = vi.fn();

    const started = await bootstrapAmplifyApp({
      fetchImpl,
      configure,
      mount,
      showConfigurationError,
    });

    expect(started).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(showConfigurationError).toHaveBeenCalledOnce();
    expect(showConfigurationError.mock.calls[0]?.[0]).toMatchObject({
      code: 'OUTPUTS_NOT_FOUND',
    });
    expect(showConfigurationError.mock.calls[0]?.[0]).toBeInstanceOf(
      AmplifyConfigurationError,
    );
    expect(showConfigurationError.mock.calls[0]?.[1]).toBeTypeOf('function');
  });

  it('rejects a non-JSON response without mounting a half-configured application', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const configure = vi.fn();
    const mount = vi.fn();
    const showConfigurationError = vi.fn();

    const started = await bootstrapAmplifyApp({
      fetchImpl,
      configure,
      mount,
      showConfigurationError,
    });

    expect(started).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(showConfigurationError.mock.calls[0]?.[0]).toMatchObject({
      code: 'OUTPUTS_INVALID',
    });
  });

  it('rejects JSON that is not an Amplify outputs document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: '1.4' }));
    const configure = vi.fn();
    const mount = vi.fn();
    const showConfigurationError = vi.fn();

    const started = await bootstrapAmplifyApp({
      fetchImpl,
      configure,
      mount,
      showConfigurationError,
    });

    expect(started).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(showConfigurationError.mock.calls[0]?.[0]).toMatchObject({
      code: 'OUTPUTS_INVALID',
    });
  });

  it.each([
    ['aws_region', 'auth', 'aws_region', undefined],
    ['user_pool_id', 'auth', 'user_pool_id', undefined],
    ['user_pool_client_id', 'auth', 'user_pool_client_id', undefined],
    ['identity_pool_id', 'auth', 'identity_pool_id', undefined],
    ['data aws_region', 'data', 'aws_region', undefined],
    ['data url', 'data', 'url', undefined],
    [
      'data default_authorization_type',
      'data',
      'default_authorization_type',
      undefined,
    ],
    ['data model_introspection', 'data', 'model_introspection', undefined],
    ['storage aws_region', 'storage', 'aws_region', undefined],
    ['storage bucket_name', 'storage', 'bucket_name', undefined],
    [
      'blank aws_region',
      'auth',
      'aws_region',
      '   ',
    ],
    ['blank data url', 'data', 'url', '   '],
    ['blank storage bucket_name', 'storage', 'bucket_name', '   '],
    [
      'unsupported data default_authorization_type',
      'data',
      'default_authorization_type',
      'API_KEY',
    ],
    ['empty data model_introspection', 'data', 'model_introspection', {}],
    ['array data model_introspection', 'data', 'model_introspection', []],
  ] as const)(
    'rejects outputs with missing or invalid %s',
    async (_field, section, key, replacement) => {
      const outputs = validOutputs();
      const record = outputs[section] as Record<string, unknown>;
      if (replacement === undefined) delete record[key];
      else record[key] = replacement;
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(outputs),
      );
      const configure = vi.fn();
      const mount = vi.fn();
      const showConfigurationError = vi.fn();

      const started = await bootstrapAmplifyApp({
        fetchImpl,
        configure,
        mount,
        showConfigurationError,
      });

      expect(started).toBe(false);
      expect(configure).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(showConfigurationError.mock.calls[0]?.[0]).toMatchObject({
        code: 'OUTPUTS_INVALID',
      });
    },
  );

  it('can retry after a configuration failure and only mounts after configuration succeeds', async () => {
    const outputs = validOutputs();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(outputs));
    const configure = vi.fn();
    const mount = vi.fn();
    let retry: (() => Promise<boolean>) | undefined;
    const showConfigurationError = vi.fn(
      (_error: AmplifyConfigurationError, retryAction: () => Promise<boolean>) => {
        retry = retryAction;
      },
    );

    await bootstrapAmplifyApp({
      fetchImpl,
      configure,
      mount,
      showConfigurationError,
    });
    expect(retry).toBeTypeOf('function');
    const recovered = await retry!();

    expect(recovered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
  });
});
