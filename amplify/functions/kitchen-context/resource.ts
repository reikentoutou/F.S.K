import { defineFunction } from '@aws-amplify/backend';

export const kitchenContext = defineFunction({
  name: 'kitchen-context',
  entry: './handler.ts',
  resourceGroupName: 'data',
  memoryMB: 256,
  runtime: 22,
  timeoutSeconds: 10,
});
