import { Amplify } from 'aws-amplify';

export type AmplifyConfigurationErrorCode =
  | 'OUTPUTS_NOT_FOUND'
  | 'OUTPUTS_INVALID'
  | 'CONFIGURE_FAILED';

export class AmplifyConfigurationError extends Error {
  constructor(
    readonly code: AmplifyConfigurationErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'AmplifyConfigurationError';
  }
}

interface BootstrapDependencies {
  fetchImpl?: typeof fetch;
  configure?: (outputs: Record<string, unknown>) => void;
  mount: () => void;
  showConfigurationError: (
    error: AmplifyConfigurationError,
    retry: () => Promise<boolean>,
  ) => void;
}

function isOutputs(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const outputs = value as Record<string, unknown>;
  const auth = outputs.auth;
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
    return false;
  }
  const authOutputs = auth as Record<string, unknown>;
  const requiredAuthFields = [
    authOutputs.aws_region,
    authOutputs.user_pool_id,
    authOutputs.user_pool_client_id,
  ];
  return (
    typeof outputs.version === 'string' &&
    requiredAuthFields.every(
      (field) => typeof field === 'string' && field.trim().length > 0,
    )
  );
}

async function loadOutputs(fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl('/amplify_outputs.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new AmplifyConfigurationError('OUTPUTS_NOT_FOUND');
  }

  let outputs: unknown;
  try {
    outputs = await response.json();
  } catch (cause) {
    throw new AmplifyConfigurationError('OUTPUTS_INVALID', { cause });
  }
  if (!isOutputs(outputs)) {
    throw new AmplifyConfigurationError('OUTPUTS_INVALID');
  }
  return outputs;
}

function normalizeConfigurationError(error: unknown): AmplifyConfigurationError {
  if (error instanceof AmplifyConfigurationError) return error;
  return new AmplifyConfigurationError('CONFIGURE_FAILED', { cause: error });
}

export async function bootstrapAmplifyApp(
  dependencies: BootstrapDependencies,
): Promise<boolean> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const configure =
    dependencies.configure ??
    ((outputs: Record<string, unknown>) => {
      Amplify.configure(outputs as Parameters<typeof Amplify.configure>[0]);
    });

  try {
    const outputs = await loadOutputs(fetchImpl);
    configure(outputs);
  } catch (error) {
    dependencies.showConfigurationError(
      normalizeConfigurationError(error),
      () => bootstrapAmplifyApp(dependencies),
    );
    return false;
  }

  dependencies.mount();
  return true;
}
