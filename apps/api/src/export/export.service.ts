import { Injectable, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import puppeteer from 'puppeteer';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { Period } from '../analytics/period-range';
import { deviationYenFromStoredFields } from '../calc/daily-report-calc';

function periodLabelJa(p: Period): string {
  switch (p) {
    case 'day':
      return '単日（業務日）';
    case 'week':
      return '週';
    case 'month':
      return '月';
    case 'quarter':
      return '四半期';
    case 'year':
      return '年';
    default:
      return p;
  }
}

function formatJaDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return iso;
  return `${y}年${m}月${d}日`;
}

type SummaryRow = Awaited<
  ReturnType<AnalyticsService['summary']>
>['rows'][number];

type GrandTotalsAgg = {
  imosSalesYen: number;
  newageYen: number;
  cashDepositYen: number;
  expenseYen: number;
  totalSalesYen: number;
  deviationYen: number;
};

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async exportDailyXlsx(id: string, res: Response) {
    const row = await this.prisma.dailyReport.findUnique({
      where: { id },
      include: { shift: true, createdBy: { select: { username: true } } },
    });
    if (!row) throw new NotFoundException();

    const registerFloat = await this.getRegisterFloatAmount();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('日報');
    ws.columns = [
      { header: '項目', key: 'k', width: 28 },
      { header: '値', key: 'v', width: 40 },
    ];
    this.shiftDetailPairs(row, registerFloat).forEach(([k, v]) =>
      ws.addRow({ k, v }),
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      attachmentHeader(
        `daily-${row.reportDate}.xlsx`,
        `daily-${row.reportDate}-${row.shiftNameSnapshot}.xlsx`,
      ),
    );
    await wb.xlsx.write(res);
  }

  async exportDailyPdf(id: string, res: Response) {
    const row = await this.prisma.dailyReport.findUnique({
      where: { id },
      include: { shift: true, createdBy: { select: { username: true } } },
    });
    if (!row) throw new NotFoundException();

    const registerFloat = await this.getRegisterFloatAmount();
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>body{font-family:sans-serif} table{border-collapse:collapse;width:100%} td{border:1px solid #333;padding:6px}</style>
</head><body><h2>日報</h2><table>
${this.shiftDetailPairs(row, registerFloat)
  .map(
    ([k, v]) =>
      `<tr><td>${escapeHtml(String(k))}</td><td>${escapeHtml(String(v))}</td></tr>`,
  )
  .join('')}
</table></body></html>`;

    const buf = await this.renderPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="daily-${row.reportDate}.pdf"`,
    );
    res.send(buf);
  }

  async exportAggregateXlsx(
    period: Period,
    anchorDate: string,
    res: Response,
  ) {
    const data = await this.analytics.summary(period, anchorDate);
    const registerFloat = await this.getRegisterFloatAmount();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(period === 'day' ? '業務日日報' : '集計');
    const gt = this.aggregateGrandTotalsFromRows(data.rows);

    ws.addRow([
      period === 'day' ? '業務日（当日）' : '期間',
      period === 'day' ? data.range.start : `${data.range.start} – ${data.range.end}`,
    ]);
    ws.addRow(['— 合計 —', '']);
    for (const [k, v] of this.grandTotalPairs(gt)) {
      ws.addRow([k, v]);
    }
    ws.addRow([]);

    if (period !== 'day') {
      ws.addRow(['集計種別', periodLabelJa(period)]);
      ws.addRow([]);
    }

    const groups =
      period === 'day'
        ? [[data.range.start, this.sortRowsByShift(data.rows)] as [string, SummaryRow[]]]
        : this.groupRowsByReportDate(data.rows);
    if (groups.length === 0) {
      ws.addRow(['（該当期間の日報がありません）', '']);
    } else {
      for (const [date, list] of groups) {
        ws.addRow([`業務日 ${date}`, '']);
        for (const r of this.sortRowsByShift(list)) {
          ws.addRow([`  【${r.shiftNameSnapshot}】`, '']);
          for (const [k, v] of this.shiftDetailPairs(r, registerFloat)) {
            ws.addRow([`    ${k}`, v]);
          }
          ws.addRow([]);
        }
      }
    }

    ws.addRow(['— シフト別合算 —', '']);
    for (const b of data.byShift) {
      ws.addRow([`【${b.shiftName}】`, '']);
      ws.addRow(['  件数', b.count]);
      ws.addRow(['  Imos売上合計', b.imosSalesYen]);
      ws.addRow(['  実際売上', b.totalSalesYen]);
      ws.addRow(['  現金入金金額', b.cashDepositYen]);
      ws.addRow(['  支出', b.expenseYen]);
      ws.addRow(['  偏差', b.deviationYen]);
      ws.addRow([]);
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="aggregate-${period}-${anchorDate}.xlsx"`,
    );
    await wb.xlsx.write(res);
  }

  async exportAggregatePdf(
    period: Period,
    anchorDate: string,
    res: Response,
  ) {
    const data = await this.analytics.summary(period, anchorDate);
    const registerFloat = await this.getRegisterFloatAmount();
    const gt = this.aggregateGrandTotalsFromRows(data.rows);
    const groups = this.groupRowsByReportDate(data.rows);
    const detailBlocks =
      groups.length === 0
        ? '<p>（該当期間の日報がありません）</p>'
        : groups
            .map(([date, list]) => {
              const inner = this.sortRowsByShift(list)
                .map((r) => this.businessDayShiftSectionHtml(r, registerFloat))
                .join('');
              return `<h2 class="bizday">業務日 ${escapeHtml(date)}</h2>${inner}`;
            })
            .join('');
    const title =
      data.range.start === data.range.end
        ? formatJaDate(data.range.start)
        : `${formatJaDate(data.range.start)} ～ ${formatJaDate(data.range.end)}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
body{font-family:sans-serif;padding:12px}
h1{font-size:1.25rem}
h2.sub{margin:18px 0 8px;font-size:1.05rem}
h2.bizday{font-size:1.05rem;margin:20px 0 8px;border-bottom:2px solid #333;padding-bottom:4px}
h3{font-size:1rem;margin:16px 0 8px;border-bottom:1px solid #333;padding-bottom:4px}
table.vtot,table.shift{border-collapse:collapse;width:100%;max-width:560px;margin-bottom:12px}
table.vtot th,table.vtot td,table.shift td{border:1px solid #333;padding:8px}
table.vtot th{width:42%;text-align:left;background:#f0f0f0;font-weight:600}
table.shift td:first-child{width:38%;background:#f5f5f5}
</style></head><body>
<h1>集計レポート（${escapeHtml(periodLabelJa(period))}）</h1>
<p><strong>期間</strong> ${escapeHtml(data.range.start)} ～ ${escapeHtml(data.range.end)}</p>
<p style="font-size:1.05rem">${escapeHtml(title)}</p>
<h2 class="sub">合計</h2>
${this.verticalGrandTotalsTableHtml(gt)}
${detailBlocks}
<h2 class="sub">シフト別合算</h2>
${this.verticalByShiftSummaryHtml(data.byShift)}
</body></html>`;

    const buf = await this.renderPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="aggregate-${period}-${anchorDate}.pdf"`,
    );
    res.send(buf);
  }

  private async getRegisterFloatAmount(): Promise<number> {
    const s = await this.prisma.appSettings.findUnique({
      where: { id: 'default' },
    });
    return s?.registerFloatAmount ?? 0;
  }

  private sortRowsByShift(rows: SummaryRow[]): SummaryRow[] {
    return [...rows].sort((a, b) => a.shift.sortOrder - b.shift.sortOrder);
  }

  private groupRowsByReportDate(rows: SummaryRow[]): [string, SummaryRow[]][] {
    const m = new Map<string, SummaryRow[]>();
    for (const r of rows) {
      const d = r.reportDate;
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  private aggregateGrandTotalsFromRows(rows: SummaryRow[]): GrandTotalsAgg {
    let imosSalesYen = 0;
    let newageYen = 0;
    let cashDepositYen = 0;
    let expenseYen = 0;
    let totalSalesYen = 0;
    let deviationYen = 0;
    for (const r of rows) {
      imosSalesYen += r.imosSalesYen;
      newageYen += r.newageYen;
      cashDepositYen += r.cashDepositYen;
      expenseYen += r.expenseYen;
      totalSalesYen += r.totalSalesYen;
      deviationYen += deviationYenFromStoredFields(r);
    }
    return {
      imosSalesYen,
      newageYen,
      cashDepositYen,
      expenseYen,
      totalSalesYen,
      deviationYen,
    };
  }

  private grandTotalPairs(t: GrandTotalsAgg): [string, string | number][] {
    return [
      ['Imos売上合計', `${t.imosSalesYen} 円`],
      ['Newage売上', `${t.newageYen} 円`],
      ['現金入金金額', `${t.cashDepositYen} 円`],
      ['支出', `${t.expenseYen} 円`],
      ['実際売上', `${t.totalSalesYen} 円`],
      ['偏差', `${t.deviationYen} 円`],
    ];
  }

  private verticalGrandTotalsTableHtml(t: GrandTotalsAgg): string {
    const rows = this.grandTotalPairs(t)
      .map(
        ([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`,
      )
      .join('');
    return `<table class="vtot">${rows}</table>`;
  }

  private verticalByShiftSummaryHtml(
    byShift: {
      shiftName: string;
      count: number;
      imosSalesYen: number;
      expenseYen: number;
      cashDepositYen: number;
      totalSalesYen: number;
      deviationYen: number;
    }[],
  ): string {
    if (!byShift.length) return '<p>（シフトデータなし）</p>';
    return byShift
      .map((b) => {
        const rows = [
          ['件数', String(b.count)],
          ['Imos売上合計', `${b.imosSalesYen} 円`],
          ['実際売上', `${b.totalSalesYen} 円`],
          ['現金入金金額', `${b.cashDepositYen} 円`],
          ['支出', `${b.expenseYen} 円`],
          ['偏差', `${b.deviationYen} 円`],
        ]
          .map(
            ([k, v]) =>
              `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
          )
          .join('');
        return `<h3>${escapeHtml(b.shiftName)}</h3><table class="vtot">${rows}</table>`;
      })
      .join('');
  }

  private shiftDetailPairs(
    r: SummaryRow,
    registerFloat: number,
  ): [string, string | number][] {
    return [
      ['日付', r.reportDate],
      ['シフト', r.shiftNameSnapshot],
      ['責任者', r.responsiblePersonSnapshot],
      ['Newage時間', r.timeRangeLabelSnapshot],
      ['前期Imos残高', `${r.previousImosBalanceYen} 円`],
      ['現在Imos残高', `${r.currentImosBalanceYen} 円`],
      ['Imos売上合計', `${r.imosSalesYen} 円`],
      ['Newage売上', `${r.newageYen} 円`],
      ['お手元残高', `${r.cashTotalYen} 円`],
      ['レジ底銭（設定）', `${registerFloat} 円`],
      ['支出', `${r.expenseYen} 円`],
      ['支出理由', r.expenseReason?.trim() || '—'],
      ['実際売上', `${r.totalSalesYen} 円`],
      ['現金入金金額', `${r.cashDepositYen} 円`],
      ['偏差', `${deviationYenFromStoredFields(r)} 円`],
      ['提出者', r.createdBy.username],
    ];
  }

  private businessDayShiftSectionHtml(
    r: SummaryRow,
    registerFloat: number,
  ): string {
    const rows = this.shiftDetailPairs(r, registerFloat)
      .map(
        ([k, v]) =>
          `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`,
      )
      .join('');
    return `<h3>${escapeHtml(r.shiftNameSnapshot)}</h3><table class="shift">${rows}</table>`;
  }

  private async renderPdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const buf = await page.pdf({ format: 'A4', printBackground: true });
      return Buffer.from(buf);
    } finally {
      await browser.close();
    }
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attachmentHeader(asciiFilename: string, utf8Filename: string): string {
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(
    utf8Filename,
  )}`;
}
