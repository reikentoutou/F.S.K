import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia } from 'pinia';
import { createRenderer } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

const http = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/http', () => ({ http }));
vi.mock('aws-amplify/auth', () => ({
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import WmHomeView from './WmHomeView.vue';
import DailyFormView from './DailyFormView.vue';

interface TestNode {
  type: string;
  text: string;
  parent: TestNode | null;
  children: TestNode[];
}

function node(type: string, text = ''): TestNode {
  return { type, text, parent: null, children: [] };
}

const renderer = createRenderer<TestNode, TestNode>({
  patchProp() {},
  insert(child, parent, anchor) {
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child);
    else parent.children.push(child);
  },
  remove(child) {
    if (!child.parent) return;
    const index = child.parent.children.indexOf(child);
    if (index >= 0) child.parent.children.splice(index, 1);
    child.parent = null;
  },
  createElement(type) {
    return node(type);
  },
  createText(text) {
    return node('#text', text);
  },
  createComment(text) {
    return node('#comment', text);
  },
  setText(target, text) {
    target.text = text;
  },
  setElementText(target, text) {
    target.text = text;
    target.children = [];
  },
  parentNode(target) {
    return target.parent;
  },
  nextSibling(target) {
    if (!target.parent) return null;
    const index = target.parent.children.indexOf(target);
    return target.parent.children[index + 1] ?? null;
  },
});

describe('KITCHEN landing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('performs no report-history or legacy-metadata reads on mount', async () => {
    http.get.mockResolvedValue({ data: [] });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/kitchen', component: WmHomeView }],
    });
    await router.push('/kitchen');
    const root = node('root');
    const app = renderer.createApp({
      ...WmHomeView,
      render: () => null,
    });
    app.use(createPinia());
    app.use(router);
    app.provide(Symbol.for('v-scx'), { modules: new Set<string>() });

    app.mount(root);
    await Promise.resolve();
    await Promise.resolve();

    expect(http.get).not.toHaveBeenCalled();
  });

  it('keeps the kitchen report route on a zero-HTTP migration boundary', async () => {
    http.get.mockResolvedValue({ data: [] });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/kitchen/report/:date/:shiftId',
          name: 'kitchen-report',
          component: DailyFormView,
        },
      ],
    });
    await router.push('/kitchen/report/2026-08-24/night');
    const root = node('root');
    const app = renderer.createApp({
      ...DailyFormView,
      render: () => null,
    });
    app.use(createPinia());
    app.use(router);
    app.provide(Symbol.for('v-scx'), { modules: new Set<string>() });

    app.mount(root);
    await Promise.resolve();
    await Promise.resolve();

    expect(router.currentRoute.value.name).toBe('kitchen-report');
    expect(http.get).not.toHaveBeenCalled();
  });
});
