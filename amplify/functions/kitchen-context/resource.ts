import { defineFunction } from '@aws-amplify/backend';

export const kitchenContext = defineFunction({
  name: 'kitchen-context',
  entry: './handler.ts',
  memoryMB: 256,
  runtime: 22,
  timeoutSeconds: 10,
});
