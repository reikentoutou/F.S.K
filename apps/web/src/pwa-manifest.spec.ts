import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(webRoot, 'public');
const generatedDirectories: string[] = [];

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

interface WebAppManifest {
  name: string;
  short_name: string;
  start_url: string;
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

async function productionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (['dist', 'node_modules', '.git'].includes(entry.name)) continue;

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFiles(path)));
      continue;
    }

    if (entry.name.endsWith('.spec.ts')) continue;
    if (['.css', '.html', '.js', '.json', '.mjs', '.ts', '.vue'].includes(extname(entry.name))) {
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

  it('keeps an iOS 15 height fallback and safe-area padding below the dynamic viewport rule', async () => {
    const css = await readFile(join(webRoot, 'src/style.css'), 'utf8');
    const fallbackRule = css.match(/body,\s*#app\s*\{([^}]*)\}/)?.[1];
    const dynamicViewportSupportIndex = css.indexOf('@supports (height: 100dvh)');
    const dynamicViewportRule = css.slice(dynamicViewportSupportIndex);

    expect(css).toMatch(/html\s*\{[^}]*height:\s*-webkit-fill-available;/s);
    expect(fallbackRule).toContain('min-height: 100vh;');
    expect(fallbackRule).toContain('min-height: -webkit-fill-available;');
    expect(dynamicViewportSupportIndex).toBeGreaterThan(css.indexOf(fallbackRule ?? ''));
    expect(css.slice(0, dynamicViewportSupportIndex)).not.toContain('min-height: 100dvh;');
    expect(dynamicViewportRule).toMatch(/body,\s*#app\s*\{[^}]*min-height:\s*100dvh;/s);
    expect(css).toContain('padding-top: env(safe-area-inset-top, 0px);');
    expect(css).toContain('padding-right: env(safe-area-inset-right, 0px);');
    expect(css).toContain('padding-bottom: env(safe-area-inset-bottom, 0px);');
    expect(css).toContain('padding-left: env(safe-area-inset-left, 0px);');
  });

  it('does not add offline, worker, background-sync, Workbox, or fullscreen behavior', async () => {
    const manifest = JSON.parse(
      await readFile(join(publicRoot, 'manifest.json'), 'utf8'),
    ) as WebAppManifest;
    const files = await productionFiles(webRoot);
    const productionText = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');

    expect(manifest.display).not.toBe('fullscreen');
    expect(productionText).not.toMatch(/navigator\s*\.\s*serviceWorker|serviceWorker\s*\.\s*register/i);
    expect(productionText).not.toMatch(
      /workbox|BackgroundSync|background[ -]?sync|offline[ -]?(queue|cache)|vite-plugin-pwa|virtual:pwa-register|registerSW/i,
    );
  });
});
