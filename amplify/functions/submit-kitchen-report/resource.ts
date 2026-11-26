import { defineFunction } from '@aws-amplify/backend';
export const submitKitchenReport = defineFunction({
  name: 'submit-kitchen-report',
  entry: './handler.ts',
  resourceGroupName: 'data',
  memoryMB: 256,
  runtime: 22,
  timeoutSeconds: 30,
});
