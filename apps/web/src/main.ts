import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import ja from 'element-plus/es/locale/lang/ja';
import 'element-plus/dist/index.css';

import App from './App.vue';
import { bootstrapAmplifyApp } from './amplify/bootstrap';
import router from './router';
import './style.css';

function mountVueApp(): void {
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(ElementPlus, { locale: ja });
  app.mount('#app');
}

function showConfigurationError(
  _error: Error,
  retry: () => Promise<boolean>,
): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) return;

  const panel = document.createElement('section');
  panel.className = 'runtime-error';
  panel.setAttribute('role', 'alert');

  const title = document.createElement('h1');
  title.textContent = 'アプリ設定を読み込めません';
  const message = document.createElement('p');
  message.textContent =
    '設定ファイルを確認できませんでした。通信を確認してから再試行してください。';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '再試行';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = '再試行中…';
    void retry();
  });

  panel.append(title, message, button);
  root.replaceChildren(panel);
}

void bootstrapAmplifyApp({
  mount: mountVueApp,
  showConfigurationError,
});
