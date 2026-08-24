import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateClient = vi.hoisted(() =>
  vi.fn(() => ({ marker: 'generated-client' })),
);

vi.mock('aws-amplify/data', () => ({ generateClient }));

beforeEach(() => {
  generateClient.mockClear();
  vi.resetModules();
});

describe('Amplify Data client singleton', () => {
  it('does not generate on import and returns one client for repeated first access', async () => {
    const clientModule = await import('./client');

    expect(generateClient).not.toHaveBeenCalled();

    const first = clientModule.getDataClient();
    const second = clientModule.getDataClient();

    expect(first).toBe(second);
    expect(first).toEqual({ marker: 'generated-client' });
    expect(generateClient).toHaveBeenCalledOnce();
  });
});
