import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

/**
 * 路由表与导航守卫。
 *
 * 守卫规则（需求 2 的首次登录流程）：
 *   1. 系统未初始化 -> 只允许进入 /setup；
 *   2. 系统已初始化但未登录 -> 只允许进入 /login；
 *   3. 已登录 -> /login 与 /setup 自动跳转仪表盘。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
    meta: { public: true, title: '初始化' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '仪表盘' },
      },
      {
        path: 'tunnels',
        name: 'tunnels',
        component: () => import('@/views/TunnelsView.vue'),
        meta: { title: '隧道管理' },
      },
      {
        path: 'routes',
        name: 'routes',
        component: () => import('@/views/RoutesView.vue'),
        meta: { title: '路由管理' },
      },
      {
        path: 'agents',
        name: 'agents',
        component: () => import('@/views/AgentsView.vue'),
        meta: { title: '主机端' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '系统设置' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (!auth.ready) {
    try {
      await auth.refresh();
    } catch {
      // 后端不可用时放行到登录页，由页面提示具体错误。
      return to.meta.public ? true : { name: 'login' };
    }
  }

  // 未初始化：强制进入初始化页。
  if (!auth.initialized) {
    return to.name === 'setup' ? true : { name: 'setup' };
  }

  // 已初始化：初始化页不再可达。
  if (to.name === 'setup') {
    return auth.admin === undefined ? { name: 'login' } : { name: 'dashboard' };
  }

  const isPublic = to.meta.public === true;
  if (!isPublic && auth.admin === undefined) {
    return { name: 'login' };
  }

  if (isPublic && auth.admin !== undefined) {
    return { name: 'dashboard' };
  }

  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title === '' ? 'NodeTunnel 管理后台' : `${title} · NodeTunnel`;
});
