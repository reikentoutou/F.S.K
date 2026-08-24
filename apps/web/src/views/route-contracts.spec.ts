import { describe, expect, it } from 'vitest';

import {
  kitchenHomePath,
  kitchenReportMode,
} from './wm/DailyFormView.vue';
import {
  ownerDailyPath,
  ownerReportMode,
} from './admin/AdminReportFormView.vue';

describe('migrated report route contracts', () => {
  it('loads the kitchen report for the current create-only route name', () => {
    expect(kitchenReportMode('kitchen-report')).toBe('create');
    expect(kitchenReportMode('wm-report')).toBeNull();
    expect(kitchenReportMode('wm-report-edit')).toBeNull();
    expect(kitchenHomePath).toBe('/kitchen');
  });

  it('loads OWNER create and edit reports from the current route names', () => {
    expect(ownerReportMode('owner-report-new')).toBe('create');
    expect(ownerReportMode('owner-report-edit')).toBe('edit');
    expect(ownerReportMode('admin-report-new')).toBeNull();
    expect(ownerReportMode('admin-report-edit')).toBeNull();
    expect(ownerDailyPath).toBe('/owner/daily');
  });
});
