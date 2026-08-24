import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');
const publicRoot = join(webRoot, 'public');
const generatedDirectories: string[] = [];
const prohibitedPwaPattern =
  /navigator\s*\.\s*serviceWorker|serviceWorker\s*\.\s*register|self\s*\.\s*addEventListener\s*\(\s*['"]install['"]|skipWaiting\s*\(|clients\s*\.\s*claim\s*\(|caches\s*\.\s*open\s*\(|workbox|BackgroundSync|background[ -]?sync|offline[ -]?(queue|cache)|vite-plugin-pwa|virtual:pwa-register|registerSW|["']?display["']?\s*:\s*["']fullscreen["']/i;

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

interface WebAppManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: ManifestIcon[];
}

function htmlTagWithAttributes(
  html: string,
  tagName: 'link' | 'meta',
  attributes: Record<string, string>,
): string | undefined {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];

  return tags.find((tag) =>
    Object.entries(attributes).every(([name, value]) => {
      const match = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
      return match?.[1] === value;
    }),
  );
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(buffer.subarray(0, signature.length)).toEqual(signature);
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function cssDeclarationBlock(source: string, selector: string): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 's'))?.[1];
}

async function expectNoProhibitedPwaBehavior(files: string[]): Promise<void> {
  const productionText = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
  expect(files.some((path) => /(?:^|\/)(?:sw|service-worker)\.[cm]?[jt]s$/i.test(path))).toBe(false);
  expect(productionText).not.toMatch(prohibitedPwaPattern);
}

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (
      [
        '.amplify',
        '.git',
        '.superpowers',
        'coverage',
        'dist',
        'docs',
        'fixtures',
        'node_modules',
        'test',
        'tests',
      ].includes(entry.name)
    ) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(path)));
      continue;
    }

    if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (/\.(?:[cm]?[jt]sx?|css|html|json|vue|ya?ml)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

afterEach(async () => {
  await Promise.all(generatedDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Home Screen Web App shell', () => {
  it('publishes a standalone manifest with installable PNG icons', async () => {
    const manifest = JSON.parse(
      await readFile(join(publicRoot, 'manifest.json'), 'utf8'),
    ) as WebAppManifest;

    expect(manifest).toMatchObject({
      name: 'FSK財務',
      short_name: 'FSK財務',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('declares the iOS 15 standalone metadata and 180px PNG touch icon', async () => {
    const html = await readFile(join(webRoot, 'index.html'), 'utf8');

    expect(htmlTagWithAttributes(html, 'link', { rel: 'manifest', href: '/manifest.json' })).toBeDefined();
    expect(
      htmlTagWithAttributes(html, 'meta', {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      }),
    ).toBeDefined();
    expect(
      htmlTagWithAttributes(html, 'meta', {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'default',
      }),
    ).toBeDefined();
    expect(
      htmlTagWithAttributes(html, 'meta', {
        name: 'apple-mobile-web-app-title',
        content: 'FSK財務',
      }),
    ).toBeDefined();
    expect(
      htmlTagWithAttributes(html, 'link', {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/icons/icon-180.png',
      }),
    ).toBeDefined();
    expect(htmlTagWithAttributes(html, 'meta', { name: 'viewport' })).toContain('viewport-fit=cover');
  });

  it.each([180, 192, 512])('commits a real square %dpx PNG icon', async (size) => {
    const icon = await readFile(join(publicRoot, 'icons', `icon-${size}.png`));

    expect(pngDimensions(icon)).toEqual({ width: size, height: size });
  });

  it.each([180, 192, 512])('keeps every %dpx icon pixel opaque and the FSK finance mark readable', async (size) => {
    const { data, info } = await sharp(join(publicRoot, 'icons', `icon-${size}.png`))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = info.width * info.height;
    let lightPixels = 0;
    let goldPixels = 0;
    let everyPixelIsOpaque = true;

    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      if (data[offset + 3] !== 255) everyPixelIsOpaque = false;
      if (red > 235 && green > 230 && blue > 215) lightPixels += 1;
      if (red > 220 && green > 145 && green < 220 && blue < 120) goldPixels += 1;
    }

    const cornerOffsets = [
      0,
      (info.width - 1) * info.channels,
      (info.height - 1) * info.width * info.channels,
      (pixels - 1) * info.channels,
    ];
    for (const offset of cornerOffsets) {
      expect([...data.subarray(offset, offset + 4)]).toEqual([22, 95, 88, 255]);
    }
    expect(everyPixelIsOpaque).toBe(true);
    expect(lightPixels / pixels).toBeGreaterThan(0.1);
    expect(goldPixels / pixels).toBeGreaterThan(0.025);
  });

  it('reproduces the committed PNG icons byte for byte', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'fsk-pwa-icons-'));
    generatedDirectories.push(outputDirectory);

    await execFileAsync(process.execPath, [join(webRoot, 'scripts/generate-app-icons.mjs')], {
      env: { ...process.env, FSK_ICON_OUTPUT_DIR: outputDirectory },
    });

    for (const size of [180, 192, 512]) {
      const [committed, generated] = await Promise.all([
        readFile(join(publicRoot, 'icons', `icon-${size}.png`)),
        readFile(join(outputDirectory, `icon-${size}.png`)),
      ]);
      expect(generated).toEqual(committed);
    }
  });

  it('uses one safe-area-adjusted viewport model in the app root and all four real route shells', async () => {
    const css = await readFile(join(webRoot, 'src/style.css'), 'utf8');
    const rootRule = cssDeclarationBlock(css, ':root');
    const bodyRule = cssDeclarationBlock(css, 'body');
    const appRule = cssDeclarationBlock(css, '#app');
    const dynamicViewportSupportIndex = css.indexOf('@supports (height: 100dvh)');
    const dynamicViewportRule = css.slice(dynamicViewportSupportIndex);

    expect(rootRule).toContain('--fs-safe-area-top: env(safe-area-inset-top, 0px);');
    expect(rootRule).toContain('--fs-safe-area-bottom: env(safe-area-inset-bottom, 0px);');
    expect(rootRule).toMatch(
      /--fs-vh-100:\s*calc\(100vh\s*-\s*var\(--fs-safe-area-top\)\s*-\s*var\(--fs-safe-area-bottom\)\);/,
    );
    expect(css).toMatch(/html\s*\{[^}]*height:\s*-webkit-fill-available;/s);
    expect(bodyRule).toContain('box-sizing: border-box;');
    expect(bodyRule).toContain('min-height: 100vh;');
    expect(bodyRule).toContain('min-height: -webkit-fill-available;');
    expect(bodyRule).not.toContain('var(--fs-vh-100)');
    expect(appRule).toContain('min-height: var(--fs-vh-100);');
    expect(appRule).not.toMatch(/100vh|100dvh|-webkit-fill-available/);
    expect(css.slice(0, dynamicViewportSupportIndex)).not.toContain('min-height: 100dvh;');
    expect(dynamicViewportRule).toMatch(
      /--fs-vh-100:\s*calc\(100dvh\s*-\s*var\(--fs-safe-area-top\)\s*-\s*var\(--fs-safe-area-bottom\)\);/,
    );
    expect(dynamicViewportRule).toMatch(/body\s*\{[^}]*min-height:\s*100dvh;/s);
    expect(dynamicViewportRule).not.toMatch(/#app\s*\{[^}]*100dvh/s);
    expect(bodyRule).toContain('padding-top: var(--fs-safe-area-top);');
    expect(bodyRule).toContain('padding-bottom: var(--fs-safe-area-bottom);');

    const shells = [
      ['src/views/LoginView.vue', '.wrap'],
      ['src/views/kitchen/KitchenHomeView.vue', '.page'],
      ['src/views/kitchen/KitchenReportView.vue', '.page'],
      ['src/views/admin/AdminShellView.vue', '.layout'],
    ] as const;
    for (const [relativePath, selector] of shells) {
      const source = await readFile(join(webRoot, relativePath), 'utf8');
      expect(cssDeclarationBlock(source, selector), `${relativePath} ${selector}`).toContain(
        'min-height: var(--fs-vh-100);',
      );
    }
  });

  it('scans repository production and build configuration for prohibited PWA behavior', async () => {
    const manifest = JSON.parse(
      await readFile(join(publicRoot, 'manifest.json'), 'utf8'),
    ) as WebAppManifest;
    const files = await productionFiles(repoRoot);
    const relativePaths = files.map((path) => path.slice(repoRoot.length + 1));

    expect(manifest.display).not.toBe('fullscreen');
    expect(relativePaths).toEqual(
      expect.arrayContaining([
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'apps/web/package.json',
        'apps/web/vite.config.ts',
        'apps/web/scripts/generate-app-icons.mjs',
        'amplify/backend.ts',
        'scripts/update-skills-usage-doc.cjs',
      ]),
    );
    await expectNoProhibitedPwaBehavior(files);
  });

  it(
    'keeps an actual temporary Vite production build free of prohibited PWA behavior',
    async () => {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'fsk-pwa-build-'));
      generatedDirectories.push(outputDirectory);

      await execFileAsync(
        process.execPath,
        [join(webRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outputDirectory, '--emptyOutDir'],
        { cwd: webRoot },
      );

      const files = await productionFiles(outputDirectory);
      expect(files.map((path) => path.slice(outputDirectory.length + 1))).toEqual(
        expect.arrayContaining(['index.html', 'manifest.json']),
      );
      await expectNoProhibitedPwaBehavior(files);
    },
    30_000,
  );
});
