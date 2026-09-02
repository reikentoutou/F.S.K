<script setup lang="ts">
import { Document, Setting, TrendCharts } from '@element-plus/icons-vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

function isActive(path: string): boolean {
  return route.path.startsWith(path);
}

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace('/login');
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="228px" class="aside">
      <div class="brand">
        <span class="brand-title">財務日報</span>
        <span class="brand-sub">管理</span>
      </div>
      <el-menu
        router
        class="nav"
        :default-active="$route.path"
        background-color="transparent"
        text-color="rgba(244, 239, 230, 0.78)"
        active-text-color="#f2e6c9"
      >
        <el-menu-item index="/owner/daily">
          <span class="nav-label">全日報</span>
        </el-menu-item>
        <el-menu-item index="/owner/settings">
          <span class="nav-label">マスタ・設定</span>
        </el-menu-item>
        <el-menu-item index="/owner/analytics">
          <span class="nav-label">集計・エクスポート</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container class="main-wrap">
      <el-header class="head">
        <span class="mobile-brand">財務日報</span>
        <div class="head-left">
          <span class="head-user">{{ auth.user?.username }}</span>
          <span class="head-role">ユーザー</span>
        </div>
        <el-button class="logout" link type="primary" @click="logout">ログアウト</el-button>
      </el-header>
      <el-main class="main">
        <div class="main-inner">
          <router-view />
        </div>
      </el-main>
    </el-container>
    <nav class="mobile-nav" aria-label="メインナビゲーション">
      <router-link
        to="/owner/daily"
        class="mobile-nav-item"
        :class="{ active: isActive('/owner/daily') }"
      >
        <el-icon><Document /></el-icon>
        <span>全日報</span>
      </router-link>
      <router-link
        to="/owner/settings"
        class="mobile-nav-item"
        :class="{ active: isActive('/owner/settings') }"
      >
        <el-icon><Setting /></el-icon>
        <span>マスタ・設定</span>
      </router-link>
      <router-link
        to="/owner/analytics"
        class="mobile-nav-item"
        :class="{ active: isActive('/owner/analytics') }"
      >
        <el-icon><TrendCharts /></el-icon>
        <span>集計・エクスポート</span>
      </router-link>
    </nav>
  </el-container>
</template>

<style scoped>
.layout {
  --el-color-primary: var(--fs-accent);
  --el-color-primary-rgb: 22, 95, 88;
  min-height: var(--fs-vh-100);
  height: var(--fs-vh-100);
  background: var(--fs-page);
}

.aside {
  display: flex;
  flex-direction: column;
  padding: 0 0 20px;
  background: linear-gradient(165deg, #2e2a25 0%, #1f1c18 52%, #181612 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.25);
}

.brand {
  padding: 22px 20px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.brand-title {
  display: block;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #f7f2ea;
}

.brand-sub {
  display: block;
  margin-top: 4px;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: rgba(244, 239, 230, 0.45);
}

.nav {
  flex: 1;
  border-right: none !important;
  padding-top: 8px;
}

.nav :deep(.el-menu-item) {
  height: 46px;
  line-height: 46px;
  margin: 2px 10px;
  border-radius: var(--fs-radius-sm);
  font-size: 0.92rem;
  transition: background-color 0.2s var(--fs-ease-out, ease),
    color 0.2s var(--fs-ease-out, ease);
}

.nav :deep(.el-menu-item.is-active) {
  background: rgba(255, 255, 255, 0.08) !important;
  font-weight: 600;
}

.nav :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.05) !important;
}

.nav-label {
  letter-spacing: 0.02em;
}

.main-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--fs-page);
}

.head {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px !important;
  padding: 0 22px 0 26px;
  background: var(--fs-surface-elevated);
  border-bottom: 1px solid var(--fs-border);
  box-shadow: 0 1px 0 rgba(28, 26, 22, 0.04);
}

.mobile-brand,
.mobile-nav {
  display: none;
}

.head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.head-user {
  font-weight: 600;
  color: var(--fs-ink);
}

.head-role {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--fs-muted);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--fs-surface);
  border: 1px solid var(--fs-border);
}

.logout {
  font-weight: 500;
}

.main {
  --el-main-padding: 0;
  flex: 1;
  min-height: 0;
  padding: 18px 22px 22px;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.main-inner {
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 720px) {
  .layout {
    width: 100%;
  }

  .aside {
    display: none;
  }

  .head {
    position: relative;
    z-index: 10;
    height: 58px !important;
    padding: 0 14px;
    gap: 10px;
  }

  .mobile-brand {
    display: block;
    margin-right: auto;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .head-left {
    gap: 6px;
  }

  .head-user {
    max-width: 72px;
    overflow: hidden;
    font-size: 0.82rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-role {
    padding: 2px 6px;
    font-size: 0.68rem;
  }

  .logout {
    padding: 4px 0;
    font-size: 0.76rem;
  }

  .main {
    padding: 14px 14px calc(84px + var(--fs-safe-area-bottom));
  }

  .mobile-nav {
    display: grid;
    position: fixed;
    right: var(--fs-safe-area-right);
    bottom: var(--fs-safe-area-bottom);
    left: var(--fs-safe-area-left);
    z-index: 20;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    min-height: 70px;
    padding: 6px 6px 8px;
    background: rgba(253, 252, 248, 0.98);
    border-top: 1px solid var(--fs-border);
    box-shadow: 0 -6px 20px rgba(28, 26, 22, 0.06);
  }

  .mobile-nav-item {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 54px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--fs-muted);
    font-size: 0.68rem;
    line-height: 1.2;
    text-align: center;
    text-decoration: none;
  }

  .mobile-nav-item::before {
    position: absolute;
    top: -6px;
    width: 42px;
    height: 3px;
    content: '';
    background: transparent;
    border-radius: 999px;
  }

  .mobile-nav-item .el-icon {
    font-size: 22px;
  }

  .mobile-nav-item.active {
    color: var(--fs-accent);
    font-weight: 700;
  }

  .mobile-nav-item.active::before {
    background: var(--fs-accent);
  }
}

@media (max-width: 390px) {
  .head-user {
    display: none;
  }
}
</style>
