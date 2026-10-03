// Prints a document's HTML to an A4 PDF with headless Chromium.
// Set CHROMIUM_PATH if Chromium isn't in Playwright's usual location.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const candidates = () => [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

let browserPromise;

async function browser() {
  if (!browserPromise) {
    const executablePath = candidates().find((p) => existsSync(p));
    browserPromise = chromium.launch(executablePath ? { executablePath } : {}).catch((e) => {
      browserPromise = undefined;
      throw new Error(`Couldn't start Chromium for PDFs. Set CHROMIUM_PATH. (${e.message.split('\n')[0]})`);
    });
  }
  return browserPromise;
}

export async function htmlToPdf(html) {
  const page = await (await browser()).newPage();
  try {
    // Fonts load from Google Fonts; if offline, the page falls back to Arial rather than failing.
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

export async function closePdf() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close();
  browserPromise = undefined;
}
