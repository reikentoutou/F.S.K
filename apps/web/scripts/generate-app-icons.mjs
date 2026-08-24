import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(webRoot, 'public/app-icon.svg');
const outputDirectory = process.env.FSK_ICON_OUTPUT_DIR
  ? resolve(process.env.FSK_ICON_OUTPUT_DIR)
  : join(webRoot, 'public/icons');
const sizes = [180, 192, 512];

sharp.cache(false);
sharp.concurrency(1);

await mkdir(outputDirectory, { recursive: true });
const source = await readFile(sourcePath);

for (const size of sizes) {
  await sharp(source, { density: 96 })
    .resize(size, size, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .png({
      adaptiveFiltering: false,
      compressionLevel: 9,
      force: true,
      palette: false,
    })
    .toFile(join(outputDirectory, `icon-${size}.png`));
}
