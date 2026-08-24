import type { DailyReportRawAmounts, DailyReportTotals } from '@fsk/domain';

export interface ShiftDefinitionRecord {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface ResponsiblePersonRecord {
  id: string;
  name: string;
  active: boolean;
}

export interface AppSettingRecord {
  id: string;
  registerFloatAmount: number;
  setupCompleted: boolean;
}

export interface DailyReportRecord extends DailyReportRawAmounts {
  reportKey: string;
  businessDate: string;
  shiftId: string;
  shiftNameSnapshot: string;
  responsiblePersonId: string;
  responsiblePersonSnapshot: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timeRangeLabelSnapshot: string;
  expenseReason: string | null;
  attachmentKeys: string[];
  submittedAt: string;
  legacySubmittedByUsername?: string;
}

export interface AttachmentManifestEntry {
  sourceRelativeKey: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
  reportKey: string;
}

export interface SourceUploadEvidence {
  sourceRelativeKey: string;
  byteSize: number;
  sha256: string;
  linkedReportKeys: string[];
}

export interface UploadInventory {
  sourceFiles: SourceUploadEvidence[];
  targetAttachments: AttachmentManifestEntry[];
}

export interface MigrationConflict {
  reportKey: string;
  sourceIds: string[];
}

export interface MigrationWarning {
  code: 'LEGACY_SUBMITTED_AT_FROM_UPDATED_AT';
  sourceId: string;
}

export interface ReconciliationAmounts {
  raw: DailyReportRawAmounts;
  derived: DailyReportTotals;
}

export interface MigrationSummary {
  modelCounts: {
    shifts: number;
    responsiblePersons: number;
    appSettings: number;
    dailyReports: number;
    attachments: number;
  };
  amounts: {
    byBusinessDate: Record<string, ReconciliationAmounts>;
    global: ReconciliationAmounts;
  };
  sourceUploadSummary: {
    count: number;
    totalBytes: number;
    hashes: Array<{ sourceRelativeKey: string; sha256: string }>;
  };
  targetAttachmentSummary: {
    count: number;
    totalBytes: number;
    hashes: Array<{ objectKey: string; sha256: string }>;
  };
  warnings: MigrationWarning[];
  conflicts: MigrationConflict[];
  orphans: Array<Omit<SourceUploadEvidence, 'linkedReportKeys'>>;
}

export interface MigrationBundle {
  shifts: ShiftDefinitionRecord[];
  responsiblePersons: ResponsiblePersonRecord[];
  appSetting: AppSettingRecord;
  dailyReports: DailyReportRecord[];
  attachments: AttachmentManifestEntry[];
  sourceSummary: MigrationSummary;
}

export interface LegacyReportAttachmentHint {
  legacyReportId: string;
  reportKey: string;
}
