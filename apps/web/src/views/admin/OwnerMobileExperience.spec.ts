import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8');
}

describe('OWNER mobile experience', () => {
  it('switches the fixed desktop shell to a mobile header and bottom navigation', () => {
    const shell = source('views/admin/AdminShellView.vue');

    expect(shell).toContain('class="mobile-brand"');
    expect(shell).toContain('class="mobile-nav"');
    expect(shell).toContain('aria-label="メインナビゲーション"');
    expect(shell).toContain('@media (max-width: 720px)');
    expect(shell).toMatch(/\.aside\s*\{\s*display:\s*none;/s);
    expect(shell).toMatch(/\.mobile-nav\s*\{\s*display:\s*grid;/s);
    expect(shell).toMatch(
      /@media \(max-width: 390px\)[\s\S]*?\.head-user\s*\{\s*display:\s*none;/,
    );
  });

  it('renders a table-free mobile daily report list with reachable edit actions', () => {
    const daily = source('views/admin/AdminDailyView.vue');

    expect(daily).toContain('class="summary-grid"');
    expect(daily).toContain('class="mobile-report-list"');
    expect(daily).toContain('class="mobile-day-button"');
    expect(daily).toContain('class="mobile-edit-button"');
    expect(daily).not.toContain('日報を編集');
    expect(daily).toMatch(/class="mobile-edit-button"[\s\S]*?>\s*\n\s*編集\s*\n\s*<\/el-button>/);
    expect(daily).toContain('@media (max-width: 720px)');
  });

  it('uses consistent Japanese copy throughout the OWNER experience', () => {
    const ownerExperience = [
      'views/admin/AdminShellView.vue',
      'views/admin/AdminDailyView.vue',
      'views/admin/AdminSettingsView.vue',
      'views/admin/AnalyticsView.vue',
      'views/admin/AdminReportFormView.vue',
      'components/daily-report/DailyReportConfirmSummary.vue',
      'components/daily-report/DailyReportSalesFields.vue',
      'utils/daily-report-form-validate.ts',
    ]
      .map(source)
      .join('\n');

    expect(ownerExperience).not.toMatch(
      /老板|网管餐|支付宝|权限不足|请重新|网络异常|分页读取|数据发生|未找到指定|补录/,
    );
    expect(ownerExperience).toContain('ユーザー');
    expect(ownerExperience).toContain('スタッフ食事代');
    expect(ownerExperience).toContain('日報を追加');
  });
});
