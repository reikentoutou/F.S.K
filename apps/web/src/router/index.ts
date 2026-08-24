import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { authorizeNavigation } from './authorization';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/kitchen',
      name: 'kitchen-home',
      component: () => import('@/views/wm/WmHomeView.vue'),
      meta: { role: 'KITCHEN' },
    },
    {
      path: '/kitchen/report/:date/:shiftId',
      name: 'kitchen-report',
      component: () => import('@/views/wm/DailyFormView.vue'),
      meta: { role: 'KITCHEN' },
    },
    {
      path: '/owner/report/new',
      name: 'owner-report-new',
      component: () => import('@/views/admin/AdminReportFormView.vue'),
      meta: { role: 'OWNER' },
    },
    {
      path: '/owner/report/:id',
      name: 'owner-report-edit',
      component: () => import('@/views/admin/AdminReportFormView.vue'),
      meta: { role: 'OWNER' },
    },
    {
      path: '/owner',
      component: () => import('@/views/admin/AdminShellView.vue'),
      meta: { role: 'OWNER' },
      children: [
        { path: '', name: 'owner-home', redirect: '/owner/daily' },
        {
          path: 'daily',
          name: 'owner-daily',
          component: () => import('@/views/admin/AdminDailyView.vue'),
        },
        {
          path: 'settings',
          name: 'owner-settings',
          component: () => import('@/views/admin/AdminSettingsView.vue'),
        },
        {
          path: 'analytics',
          name: 'owner-analytics',
          component: () => import('@/views/admin/AnalyticsView.vue'),
        },
        {
          path: 'backup',
          name: 'owner-backup',
          component: () => import('@/views/admin/AdminBackupView.vue'),
        },
      ],
    },
    { path: '/', redirect: '/login' },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!to.meta.public) {
    try {
      await auth.restoreSession();
    } catch {
      return { name: 'login', query: { redirect: to.fullPath } };
    }
  }

  return authorizeNavigation(
    {
      path: to.fullPath,
      isPublic: to.meta.public === true,
      requiredRole: to.meta.role,
    },
    auth.user,
  );
});

export default router;
