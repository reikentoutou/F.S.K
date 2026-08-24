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

describe('bootstrapAmplifyApp', () => {
  it('configures Amplify exactly once before mounting the Vue application', async () => {
    const outputs = {
      version: '1.4',
      auth: {
        aws_region: 'ap-northeast-1',
        user_pool_id: 'ap-northeast-1_example',
        user_pool_client_id: 'client-id',
      },
    };
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

  it('can retry after a configuration failure and only mounts after configuration succeeds', async () => {
    const outputs = { version: '1.4', auth: { aws_region: 'ap-northeast-1' } };
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
