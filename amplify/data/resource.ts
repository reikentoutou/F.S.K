import { a, defineData, type ClientSchema } from '@aws-amplify/backend';

const DailyReport = a
  .model({
    reportKey: a.id().required(),
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
    allow.owner().to(['create']),
  ]);

const ShiftDefinition = a
  .model({
    id: a.id().required(),
    name: a.string().required(),
    sortOrder: a.integer().required(),
    active: a.boolean().required(),
  })
  .authorization((allow) => [
    allow.group('OWNER'),
    allow.group('KITCHEN').to(['read']),
  ]);

const ResponsiblePerson = a
  .model({
    id: a.id().required(),
    name: a.string().required(),
    active: a.boolean().required(),
  })
  .authorization((allow) => [
    allow.group('OWNER'),
    allow.group('KITCHEN').to(['read']),
  ]);

const AppSetting = a
  .model({
    id: a.id().required(),
    registerFloatAmount: a.integer().required(),
    setupCompleted: a.boolean().required(),
  })
  .authorization((allow) => [allow.group('OWNER')]);

export const schema = a.schema({
  DailyReport,
  ShiftDefinition,
  ResponsiblePerson,
  AppSetting,
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});
