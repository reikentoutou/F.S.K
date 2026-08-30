import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type RouterHistory,
} from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { authorizeNavigation } from './authorization';

export function createAppRouter(history: RouterHistory) {
  const router = createRouter({
    history,
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
        component: () => import('@/views/kitchen/KitchenHomeView.vue'),
        meta: { role: 'KITCHEN' },
      },
      {
        path: '/kitchen/report/:date/:shiftId',
        name: 'kitchen-report',
        component: () => import('@/views/kitchen/KitchenReportView.vue'),
        meta: { role: 'KITCHEN' },
      },
      {
        path: '/owner/report/new',
        name: 'owner-report-new',
        component: () => import('@/views/admin/AdminReportFormView.vue'),
        meta: { role: 'OWNER' },
      },
      {
        path: '/owner/report/:reportKey',
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
    if (!auth.initialized) {
      try {
        await auth.restoreSession();
      } catch {
        if (!to.meta.public) {
          return { name: 'login', query: { redirect: to.fullPath } };
        }
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

  return router;
}

const router = createAppRouter(
  typeof window === 'undefined'
    ? createMemoryHistory(import.meta.env.BASE_URL)
    : createWebHistory(import.meta.env.BASE_URL),
);

export default router;
