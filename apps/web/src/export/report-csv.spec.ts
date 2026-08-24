// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REPORT_CSV_HEADERS,
  buildReportCsv,
  downloadCsvFile,
} from './report-csv';
import {
  buildReportAnalytics,
  type AnalyticsReport,
} from '@/analytics/report-analytics';

function report(
  overrides: Partial<AnalyticsReport> = {},
): AnalyticsReport {
  return {
    reportKey: '2026-08-24#night',
    businessDate: '2026-08-24',
    shiftId: 'night',
    shiftNameSnapshot: '夜班',
    responsiblePersonSnapshot: '佐藤',
    startMinuteOfDay: 20 * 60,
    endMinuteOfDay: 8 * 60,
    timeRangeLabelSnapshot: '20:00–08:00',
    previousImosBalanceYen: 14_000,
    currentImosBalanceYen: 20_000,
    newageYen: 2_500,
    cashTotalYen: 10_000,
    expenseYen: 300,
    expenseReason: '飲料, "夜勤"\r\n補充分',
    staffMealCashYen: 200,
    staffMealAlipayYen: 800,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('report CSV', () => {
  it('exports only the header record when the selected period has no reports', () => {
    expect(buildReportCsv([])).toBe(
      `\ufeff${REPORT_CSV_HEADERS.join(',')}\r\n`,
    );
  });

  it('uses a UTF-8 BOM, CRLF records and a stable Japanese column order', () => {
    const analytics = buildReportAnalytics([report()], 5_000);
    const csv = buildReportCsv(analytics.rows);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(
      `\ufeff${REPORT_CSV_HEADERS.join(',')}\r\n` +
        '2026-08-24,夜班,20:00–08:00,佐藤,14000,20000,6000,2500,10000,5000,5000,300,"飲料, ""夜勤""\r\n補充分",200,800,1000,7300,1600\r\n',
    );
  });

  it.each(['=1+1', '+SUM(A1:A2)', '-2+3', '@command'])(
    'prefixes a formula-like expense reason with an apostrophe: %s',
    (expenseReason) => {
      const analytics = buildReportAnalytics(
        [report({ expenseReason })],
        5_000,
      );

      const csv = buildReportCsv(analytics.rows);

      expect(csv).toContain(`,'${expenseReason},`);
    },
  );

  it('creates and revokes a browser object URL using the requested CSV filename', () => {
    const createdBlobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return 'blob:fsk-report';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let clickedDownload = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownload = this.download;
      });

    downloadCsvFile('\ufeff業務日\r\n', 'aggregate-week-2026-08-24.csv');

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createdBlobs[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('text/csv;charset=utf-8');
    expect(click).toHaveBeenCalledOnce();
    expect(clickedDownload).toBe('aggregate-week-2026-08-24.csv');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fsk-report');
  });
});
