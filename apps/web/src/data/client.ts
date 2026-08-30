import { generateClient } from 'aws-amplify/data';

import type { Schema } from '@amplify/data/resource';

export type FskDataClient = ReturnType<typeof generateClient<Schema>>;

let singletonClient: FskDataClient | undefined;

export function getDataClient(): FskDataClient {
  singletonClient ??= generateClient<Schema>();
  return singletonClient;
}
