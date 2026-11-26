import { a, defineData, type ClientSchema } from '@aws-amplify/backend';

import { submitKitchenReport } from '../functions/submit-kitchen-report/resource.js';

import { kitchenContext } from '../functions/kitchen-context/resource.js';

const DailyReport = a
  .model({
    reportKey: a.id().required(),
    storeId: a.string().required(),
    registerFloatSnapshot: a.integer().required(),
    owner: a.string(),
    businessDate: a.string().required(),
    shiftId: a.id().required(),
    shiftNameSnapshot: a.string().required(),
    responsiblePersonId: a.id().required(),
    responsiblePersonSnapshot: a.string().required(),
    startMinuteOfDay: a.integer().required(),
    endMinuteOfDay: a.integer().required(),
    timeRangeLabelSnapshot: a.string().required(),
    previousImosBalanceYen: a.integer().required(),
    currentImosBalanceYen: a.integer().required(),
    newageYen: a.integer().required(),
    cashTotalYen: a.integer().required(),
    expenseYen: a.integer().required(),
    expenseReason: a.string(),
    staffMealCashYen: a.integer().required(),
    staffMealAlipayYen: a.integer().required(),
    attachmentKeys: a.string().array(),
    submittedAt: a.datetime().required(),
    legacySubmittedByUsername: a.string(),
  })
  .identifier(['reportKey'])
  .secondaryIndexes((index) => [
    index('businessDate')
      .sortKeys(['shiftId'])
      .queryField('dailyReportsByBusinessDate'),
  ])
  .authorization((allow) => [
    allow.group('OWNER'),
  ]);

const ShiftDefinition = a
  .model({
    id: a.id().required(),
    storeId: a.string().required(),
    name: a.string().required(),
    sortOrder: a.integer().required(),
    active: a.boolean().required(),
  })
  .authorization((allow) => [
    allow.group('OWNER'),
  ]);

const ResponsiblePerson = a
  .model({
    id: a.id().required(),
    storeId: a.string().required(),
    name: a.string().required(),
    active: a.boolean().required(),
  })
  .authorization((allow) => [
    allow.group('OWNER'),
  ]);

const AppSetting = a
  .model({
    id: a.id().required(),
    storeId: a.string().required(),
    registerFloatAmount: a.integer().required(),
    setupCompleted: a.boolean().required(),
  })
  .authorization((allow) => [allow.group('OWNER')]);

const KitchenShift = a.customType({
  id: a.id().required(),
  name: a.string().required(),
  sortOrder: a.integer().required(),
});

const KitchenResponsiblePerson = a.customType({
  id: a.id().required(),
  name: a.string().required(),
});

const KitchenContext = a.customType({
  registerFloatAmount: a.integer().required(),
  shifts: a.ref('KitchenShift').array().required(),
  responsiblePersons: a.ref('KitchenResponsiblePerson').array().required(),
  submittedShiftIds: a.id().array().required(),
});

const getKitchenContext = a
  .query()
  .arguments({ businessDate: a.string(), storeId: a.string() })
  .returns(a.ref('KitchenContext'))
  .authorization((allow) => [allow.groups(['OWNER', 'KITCHEN'])])
  .handler(a.handler.function(kitchenContext));

const KitchenSubmissionResult = a.customType({
  registerFloatSnapshot: a.integer().required(),
  shiftNameSnapshot: a.string().required(),
  responsiblePersonSnapshot: a.string().required(),
  reportKey: a.id().required(),
  submittedAt: a.datetime().required(),
});

export const schema = a.schema({
  KitchenSubmissionResult,
  submitKitchenReport: a.mutation()
    .arguments({ input: a.json().required() })
    .returns(a.ref('KitchenSubmissionResult'))
    .authorization((allow) => [allow.group('KITCHEN')])
    .handler(a.handler.function(submitKitchenReport)),
  DailyReport,
  ShiftDefinition,
  ResponsiblePerson,
  AppSetting,
  KitchenShift,
  KitchenResponsiblePerson,
  KitchenContext,
  getKitchenContext,
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
