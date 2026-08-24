// @vitest-environment jsdom

import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue';
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
import { useEchartsBarChart } from '@/composables/useEchartsBarChart';

const chartMocks = vi.hoisted(() => {
  const instances: Array<{
    setOption: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    instances,
    init: vi.fn((_host: HTMLElement) => {
      const instance = {
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      };
      instances.push(instance);
      return instance;
    }),
  };
});

vi.mock('echarts', () => ({ init: chartMocks.init }));

const shiftSortOrders = new Map([['night', 1]]);

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

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 1; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && csv[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else {
      field += char;
    }
  }
  return rows;
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
    const analytics = buildReportAnalytics(
      [report()],
      5_000,
      shiftSortOrders,
    );
    const csv = buildReportCsv(analytics.rows);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(
      `\ufeff${REPORT_CSV_HEADERS.join(',')}\r\n` +
        '2026-08-24,夜班,20:00–08:00,佐藤,14000,20000,6000,2500,10000,5000,5000,300,"飲料, ""夜勤""\r\n補充分",200,800,1000,7300,1600\r\n',
    );
  });

  it('keeps CSV detail records in the explicit shift-master order', () => {
    const analytics = buildReportAnalytics(
      [
        report({
          reportKey: '2026-08-24#day',
          shiftId: 'day',
          shiftNameSnapshot: '白班',
          startMinuteOfDay: 8 * 60,
          endMinuteOfDay: 20 * 60,
          timeRangeLabelSnapshot: '08:00–20:00',
        }),
        report(),
      ],
      5_000,
      new Map([
        ['night', 10],
        ['day', 20],
      ]),
    );

    const parsed = parseCsv(buildReportCsv(analytics.rows));

    expect(parsed.slice(1).map((row) => [row[1], row[2]])).toEqual([
      ['夜班', '20:00–08:00'],
      ['白班', '08:00–20:00'],
    ]);
  });

  it.each([
    '=1+1',
    '+SUM(A1:A2)',
    '-2+3',
    '@command',
    ' \t=1+1',
    '\r=1+1',
    '\n=1+1',
    '\f=1+1',
    '\v=1+1',
    '\u00a0=1+1',
    '\u2003=1+1',
    '\u0000=1+1',
  ])(
    'makes apostrophe the first parsed cell character before a formula-like reason: %j',
    (expenseReason) => {
      const analytics = buildReportAnalytics(
        [report({ expenseReason })],
        5_000,
        shiftSortOrders,
      );

      const csv = buildReportCsv(analytics.rows);

      expect(parseCsv(csv)[1]?.[12]).toBe(`'${expenseReason}`);
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

describe('ECharts host lifecycle', () => {
  it('recreates the chart when the host ref changes while keeping one resize listener', async () => {
    chartMocks.instances.length = 0;
    chartMocks.init.mockClear();
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const HostHarness = defineComponent({
      setup(_props, { expose }) {
        const hostVersion = shallowRef(0);
        const chartEl = shallowRef<HTMLDivElement | null>(null);
        const { setBarData } = useEchartsBarChart(chartEl);
        async function draw(): Promise<void> {
          await nextTick();
          setBarData(['白班'], [{ name: '実際売上', data: [5_500] }]);
        }
        async function replaceHost(): Promise<void> {
          hostVersion.value += 1;
          await draw();
        }
        expose({ draw, replaceHost });
        return () =>
          h('div', {
            key: hostVersion.value,
            ref: (value) => {
              chartEl.value = value as HTMLDivElement | null;
            },
          });
      },
    });
    const root = document.createElement('div');
    const app = createApp(HostHarness);
    const harness = app.mount(root) as unknown as {
      draw(): Promise<void>;
      replaceHost(): Promise<void>;
    };

    await harness.draw();
    const firstHost = root.firstElementChild;
    await harness.replaceHost();
    const secondHost = root.firstElementChild;

    expect(firstHost).not.toBe(secondHost);
    expect(chartMocks.init.mock.calls.map(([host]) => host)).toEqual([
      firstHost,
      secondHost,
    ]);
    expect(chartMocks.instances[0]?.dispose).toHaveBeenCalledOnce();
    expect(
      addEventListener.mock.calls.filter(([type]) => type === 'resize'),
    ).toHaveLength(1);

    window.dispatchEvent(new Event('resize'));
    expect(chartMocks.instances[1]?.resize).toHaveBeenCalledOnce();

    app.unmount();
    expect(chartMocks.instances[1]?.dispose).toHaveBeenCalledOnce();
    expect(
      removeEventListener.mock.calls.filter(([type]) => type === 'resize'),
    ).toHaveLength(1);
  });
});
