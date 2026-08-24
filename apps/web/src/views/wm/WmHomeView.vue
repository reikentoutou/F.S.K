<script setup lang="ts">
import { useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="page">
    <header class="bar">
      <div class="bar-titles">
        <p class="eyebrow">財務日報</p>
        <h1 class="title">厨房端末</h1>
      </div>
      <div class="right">
        <span class="user">{{ auth.user?.username }}</span>
        <el-button link type="primary" class="logout" @click="logout">
          ログアウト
        </el-button>
      </div>
    </header>

    <main class="main">
      <section class="panel" aria-labelledby="migration-heading">
        <h2 id="migration-heading" class="panel-title">帳務入力</h2>
        <p class="panel-notice">
          帳務入力機能は次の移行ステップで接続されます。
        </p>
        <p class="panel-detail">
          現在、この端末から履歴、集計、設定を参照することはできません。
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: var(--fs-vh-100);
  display: flex;
  flex-direction: column;
  background: var(--fs-page);
}

.bar {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 22px 14px 26px;
  background: var(--fs-surface-elevated);
  border-bottom: 1px solid var(--fs-border);
}

.bar-titles {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 2px;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: var(--fs-muted);
}

.title {
  margin: 0;
  font-size: 1.25rem;
  color: var(--fs-ink);
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user {
  font-size: 0.86rem;
  color: var(--fs-muted);
}

.main {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 20px;
}

.panel {
  padding: 24px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.panel-title {
  margin: 0 0 12px;
  font-size: 1.1rem;
  color: var(--fs-ink);
}

.panel-notice {
  margin: 0 0 8px;
  font-weight: 600;
  color: var(--fs-ink);
}

.panel-detail {
  margin: 0;
  line-height: 1.6;
  color: var(--fs-muted);
}

@media (max-width: 640px) {
  .bar {
    padding: 12px 16px;
  }

  .main {
    padding: 20px 16px;
  }
}
</style>
