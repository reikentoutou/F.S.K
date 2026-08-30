<script setup lang="ts">
import { reactive, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { AuthStoreError, useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const loading = shallowRef(false);
const form = reactive({
  username: '',
  password: '',
  newPassword: '',
  confirmPassword: '',
});

function authErrorText(error: unknown): string {
  if (!(error instanceof AuthStoreError)) return 'ログインに失敗しました。';
  switch (error.code) {
    case 'CREDENTIALS_INVALID':
      return 'ユーザー名またはパスワードが正しくありません。';
    case 'PASSWORD_UPDATE_FAILED':
      return '新しいパスワードを更新できません。要件を確認してください。';
    case 'NETWORK_ERROR':
      return '通信できません。ネットワーク接続を確認してください。';
    case 'CONFIGURATION_ERROR':
      return 'アプリの認証設定に問題があります。管理者へ連絡してください。';
    case 'ROLE_INVALID':
      return 'このアカウントには利用可能な権限がありません。';
    default:
      return 'このログイン手順には対応していません。管理者へ連絡してください。';
  }
}

async function goToAuthorizedHome(): Promise<void> {
  const redirect = route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/')) {
    await router.replace(redirect);
    return;
  }
  await router.replace(auth.isOwner ? '/owner' : '/kitchen');
}

async function submitCredentials(): Promise<void> {
  loading.value = true;
  try {
    const result = await auth.login(form.username, form.password);
    if (result === 'SIGNED_IN') await goToAuthorizedHome();
  } catch (error) {
    ElMessage.error(authErrorText(error));
  } finally {
    loading.value = false;
  }
}

async function submitNewPassword(): Promise<void> {
  if (form.newPassword !== form.confirmPassword) {
    ElMessage.error('新しいパスワードが一致しません。');
    return;
  }
  loading.value = true;
  try {
    await auth.confirmNewPassword(form.newPassword);
    await goToAuthorizedHome();
  } catch (error) {
    ElMessage.error(authErrorText(error));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <div class="panel fs-anim-fade-lift">
      <p class="eyebrow">財務日報</p>
      <h1 class="title">
        {{ auth.newPasswordRequired ? 'パスワード更新' : 'ログイン' }}
      </h1>
      <p class="lede">
        {{
          auth.newPasswordRequired
            ? '初回ログイン用の新しいパスワードを設定してください。'
            : '業務用アカウントでサインインしてください。'
        }}
      </p>
      <el-card class="card" shadow="never">
        <el-form
          v-if="!auth.newPasswordRequired"
          @submit.prevent="submitCredentials"
        >
          <el-form-item label="ユーザー名">
            <el-input v-model="form.username" autocomplete="username" />
          </el-form-item>
          <el-form-item label="パスワード">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              autocomplete="current-password"
            />
          </el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            :loading="loading"
            class="submit"
          >
            ログイン
          </el-button>
        </el-form>
        <el-form v-else @submit.prevent="submitNewPassword">
          <el-form-item label="新しいパスワード">
            <el-input
              v-model="form.newPassword"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="新しいパスワード（確認）">
            <el-input
              v-model="form.confirmPassword"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            :loading="loading"
            class="submit"
          >
            パスワードを更新
          </el-button>
        </el-form>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: var(--fs-vh-100);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background:
    radial-gradient(1200px 600px at 12% -10%, rgba(22, 95, 88, 0.14), transparent 55%),
    radial-gradient(900px 480px at 88% 110%, rgba(139, 90, 43, 0.08), transparent 50%),
    var(--fs-page);
}

.panel {
  width: min(420px, 100%);
}

.eyebrow {
  margin: 0 0 6px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--fs-muted);
}

.title {
  margin: 0 0 8px;
  font-size: 1.65rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--fs-ink);
  line-height: 1.25;
}

.lede {
  margin: 0 0 18px;
  font-size: 0.9rem;
  color: var(--fs-muted);
  line-height: 1.5;
  max-width: 36ch;
}

.card {
  border-radius: var(--fs-radius-md);
  border: 1px solid var(--fs-border);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

@media (prefers-reduced-motion: no-preference) {
  .card {
    transition:
      border-color 0.22s var(--fs-ease-out, cubic-bezier(0.25, 1, 0.5, 1)),
      box-shadow 0.28s var(--fs-ease-out, cubic-bezier(0.25, 1, 0.5, 1));
  }
}

@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  .card:hover {
    border-color: var(--fs-border-strong);
    box-shadow:
      0 1px 2px rgba(28, 26, 22, 0.06),
      0 16px 40px rgba(28, 26, 22, 0.09);
  }
}

.card :deep(.el-card__body) {
  padding: 22px 22px 20px;
}

.card :deep(.el-form-item__label) {
  color: var(--fs-muted);
  font-weight: 500;
}

.submit {
  width: 100%;
  margin-top: 4px;
  height: 42px;
  font-weight: 600;
}

@media (prefers-reduced-motion: no-preference) {
  .submit:not(:disabled):active {
    transform: translateY(1px);
  }

  .submit {
    transition: transform 0.12s var(--fs-ease-out, cubic-bezier(0.25, 1, 0.5, 1));
  }
}
</style>
