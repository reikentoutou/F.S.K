<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

function goHome() {
  if (auth.user?.role === 'OWNER') {
    void router.replace('/owner');
    return;
  }
  if (auth.user?.role === 'KITCHEN') {
    void router.replace('/kitchen');
    return;
  }
  void router.replace('/login');
}
</script>

<template>
  <div class="wrap">
    <h1 class="title">ページが見つかりません</h1>
    <p class="lead">URL をご確認ください。</p>
    <el-button type="primary" @click="goHome">トップへ</el-button>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 520px;
  margin: 48px auto;
  padding: 0 16px;
}
.title {
  font-size: 1.35rem;
  font-weight: 700;
  margin: 0 0 12px;
  color: var(--fs-ink, var(--el-text-color-primary));
}
.lead {
  line-height: 1.55;
  color: var(--fs-muted, var(--el-text-color-secondary));
  margin: 0 0 20px;
}
</style>
