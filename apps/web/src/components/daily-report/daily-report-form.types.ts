export type DailyReportFormFieldsModel = {
  responsiblePersonId: string;
  startStr: string;
  endStr: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashInDrawerYen: number;
  expenseYen: number;
  expenseReason: string;
  expenseReceiptStored: boolean;
};

export type ResponsiblePersonOption = {
  id: string;
  name: string;
};

export type WebmasterOption = {
  id: string;
  username: string;
};
