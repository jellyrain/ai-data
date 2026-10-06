import { createRequire } from 'node:module';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(path.join(root, 'ai-data/apps/web/package.json'));
const { chromium } = require('@playwright/test');
const names = ['03-文字生成中.png', '04-工具执行中.png', '05-工具后的说明.png', '06-最终正文持续输出.png', '07-最终完成.png', '08-展开分析过程.png'];
const images = await Promise.all(names.map(async name => {
  const data = await readFile(path.join(directory, name));
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width !== 1920 || height !== 1080) throw new Error(`截图尺寸异常：${name}`);
  return { name, width, height };
}));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(directory, '审核.html')).href);
  await page.waitForFunction(() => document.querySelector('video').videoWidth > 0);
  const video = await page.locator('video').evaluate(element => ({ width: element.videoWidth, height: element.videoHeight, duration_seconds: element.duration }));
  if (video.width !== 1920 || video.height !== 1080) throw new Error('录屏尺寸异常');
  const links = await page.locator('a').evaluateAll(elements => elements.map(element => element.href));
  for (const link of links) await stat(fileURLToPath(link));
  if (errors.length) throw new Error(errors.join('\n'));
  const result = { images, video, checked_links: links.length, errors };
  await writeFile(path.join(directory, '文件检查.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
