// Run: ANSWER_TRACE_PLAYWRIGHT_MODULE=/path/to/installed/playwright node --test tests/answer_trace_ui.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, mkdir } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { chromium } = require(process.env.ANSWER_TRACE_PLAYWRIGHT_MODULE || 'playwright');

const runId = '11111111-1111-4111-8111-111111111111';
const assetRoot = join(__dirname, '../app/integrations/answer_trace_static');
const source = { url: 'https://example.org/article', title: '<img src=x onerror=alert(1)>' };
const trace = {
  run_id: runId, duration_ms: 8000, model: 'test/model',
  steps: [{ id: 'step-1', kind: 'web_search', label: 'Искал страницы',
    query: '<script>alert(1)</script>', status: 'completed', sources: [source] }],
  sources: [source], history_message_count: 12,
  memory_facts: [{ id: 'fact-1', text: '<b>Пишу по-русски</b>', version: 2 }],
};
let browser;
let server;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    const files = {
      '/telegram/answer-trace': ['index.html', 'text/html'],
      '/telegram/answer-trace/': ['index.html', 'text/html'],
      '/telegram/answer-trace/app.js': ['app.js', 'text/javascript'],
      '/telegram/answer-trace/style.css': ['style.css', 'text/css'],
    };
    const file = files[new URL(req.url, 'http://localhost').pathname];
    try {
      assert.ok(file);
      const body = await readFile(join(assetRoot, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Missing static asset');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openApp(t, { data = trace, status = 200, telegram = true,
  startParam = `run__${runId}`, suffix = '', offline = false, officialSdk = false,
  sdkGate = Promise.resolve(), sdkFailure = false, sdkCache, beforeSdk } = {}) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  const external = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sdk = officialSdk ? await readFile(process.env.ANSWER_TRACE_TELEGRAM_SDK, 'utf8') : '// SDK replaced by test fixture';
  await page.route('https://telegram.org/js/telegram-web-app.js*', async route => {
    await sdkGate;
    if (sdkFailure) return route.abort();
    await route.fulfill({ contentType: 'text/javascript', body: sdk });
  });
  await page.route('**/api/v1/telegram/answer-trace/**', async route => {
    requests.push({ url: route.request().url(), headers: route.request().headers() });
    if (offline) return route.abort();
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  page.on('request', request => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('https://telegram.org/js/')) {
      external.push(request.url());
    }
  });
  if (sdkCache) await page.addInitScript(cache => {
    sessionStorage.setItem('__telegram__initParams', JSON.stringify(cache));
  }, sdkCache);
  if (telegram && !officialSdk) await page.addInitScript(({ startParam }) => {
    const events = {};
    window.testTelegramEvents = events;
    window.Telegram = { WebApp: {
      initData: `auth_date=1&start_param=${startParam}&hash=fake-test-signature`,
      initDataUnsafe: { start_param: startParam }, colorScheme: 'dark',
      themeParams: { bg_color: '#17212b', text_color: '#ffffff', hint_color: '#a3b5c6' },
      ready() {}, expand() {},
      onEvent(name, callback) { events[name] = callback; },
      BackButton: { show() {}, hide() {}, onClick(callback) { window.testBack = callback; } },
    } };
  }, { startParam });
  await page.goto(`${origin}/telegram/answer-trace${suffix}`, { waitUntil: 'commit' });
  if (beforeSdk) await beforeSdk(page, requests);
  await page.locator('#loading').waitFor({ state: 'hidden' });
  return { page, requests, external, errors };
}

test('delayed official SDK leaves startup responsive and preserves launch authentication', {
  skip: !process.env.ANSWER_TRACE_TELEGRAM_SDK && 'Set ANSWER_TRACE_TELEGRAM_SDK to a locally downloaded official SDK',
}, async t => {
  let releaseSdk;
  const sdkGate = new Promise(resolve => { releaseSdk = resolve; });
  const initData = `auth_date=1&start_param=run__${runId}&hash=synthetic-delay-signature`;
  const launch = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: '8.0', tgWebAppPlatform: 'web' });
  const { page, requests, errors } = await openApp(t, { officialSdk: true, sdkGate, suffix: `#${launch}`,
    beforeSdk: async (page, requests) => {
      try {
        await page.waitForFunction(() => document.querySelector('#loading')?.textContent === 'Подключаю Telegram…', null, { timeout: 1500 });
        assert.equal(requests.length, 0);
        assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('tgWebAppData'), initData);
        assert.equal(await page.locator('#error').isVisible(), false);
      } finally {
        releaseSdk();
      }
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, `tma ${initData}`);
  assert.equal(await page.locator('#trace').isVisible(), true);
  assert.equal(new URL(page.url()).hash.includes('tgWebAppData'), false);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('__telegram__initParams')).tgWebAppData), undefined);
  assert.deepEqual(errors, []);
});

test('SDK network failure shows a safe retry without requesting protected data', async t => {
  const { page, requests, errors } = await openApp(t, { telegram: false, sdkFailure: true });
  assert.match(await page.locator('#error-title').innerText(), /подключить Telegram/);
  assert.equal(await page.locator('#diagnostics-log').isVisible(), true);
  assert.match(await page.locator('#diagnostics-log').innerText({ timeout: 1000 }), /SDK: нет.*ошибка загрузки/);
  assert.equal(await page.getByRole('button', { name: 'Повторить' }).isVisible(), true);
  assert.equal(requests.length, 0);
  assert.deepEqual(errors, []);
});

test('official SDK launch removes persisted credentials but preserves in-memory retry auth', {
  skip: !process.env.ANSWER_TRACE_TELEGRAM_SDK && 'Set ANSWER_TRACE_TELEGRAM_SDK to a locally downloaded official SDK',
}, async t => {
  const initData = `auth_date=1&start_param=run__${runId}&hash=synthetic-only-signature`;
  const launch = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: '8.0',
    tgWebAppPlatform: 'web', tgWebAppStartParam: `run__${runId}` });
  const { page, requests, errors } = await openApp(t, { officialSdk: true, offline: true, suffix: `#${launch}` });
  assert.equal(requests[0].headers.authorization, `tma ${initData}`);
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__telegram__initParams')));
  assert.equal(stored.tgWebAppData, undefined);
  assert.equal(stored.tgWebAppVersion, '8.0');
  assert.equal(new URL(page.url()).hash.includes('tgWebAppData'), false);
  assert.equal(await page.evaluate(() => Telegram.WebApp.initData), initData);
  await page.unroute('**/api/v1/telegram/answer-trace/**');
  await page.route('**/api/v1/telegram/answer-trace/**', route => {
    assert.equal(route.request().headers().authorization, `tma ${initData}`);
    return route.fulfill({ json: trace });
  });
  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.locator('#trace').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => Telegram.WebApp.initData), '');
  assert.match(await page.locator('#error').innerText(), /Telegram/);
  assert.deepEqual(errors, []);
});

for (const { name, cachedRun, explicitStart, rejected } of [
  { name: 'uses the SDK outer start parameter when the launch omits it', cachedRun: runId },
  { name: 'prefers the current launch over a different cached run',
    cachedRun: '22222222-2222-4222-8222-222222222222', explicitStart: `run__${runId}` },
  { name: 'rejects a malformed explicit start parameter despite a valid cached run',
    cachedRun: runId, explicitStart: 'run__invalid', rejected: true },
]) {
  test(`official SDK ${name}`, {
    skip: !process.env.ANSWER_TRACE_TELEGRAM_SDK && 'Set ANSWER_TRACE_TELEGRAM_SDK to a locally downloaded official SDK',
  }, async t => {
    const initData = 'auth_date=1&hash=synthetic-current-signature';
    const launch = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: '8.0', tgWebAppPlatform: 'web' });
    const query = explicitStart ? `?tgWebAppStartParam=${explicitStart}` : '';
    const cachedStart = `run__${cachedRun}`;
    const { page, requests, errors } = await openApp(t, {
      officialSdk: true, suffix: `${query}#${launch}`,
      sdkCache: { tgWebAppStartParam: cachedStart, tgWebAppData: 'auth_date=0&hash=synthetic-stale-signature' },
    });
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__telegram__initParams')));
    assert.equal(stored.tgWebAppData, undefined);
    assert.equal(stored.tgWebAppStartParam, cachedStart);
    assert.equal(await page.evaluate(() => Telegram.WebApp.initData), initData);
    assert.deepEqual(errors, []);
    if (rejected) {
      assert.equal(await page.locator('#error-title').innerText(), 'Нет ссылки на ответ');
      assert.equal(requests.length, 0);
      return;
    }
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error-title').textContent());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${origin}/api/v1/telegram/answer-trace/${runId}`);
    assert.equal(requests[0].headers.authorization, `tma ${initData}`);
    assert.equal(await page.locator('#trace').isVisible(), true);
  });
}

test('diagnostics snapshot exposes only allowlisted launch fields', {
  skip: !process.env.ANSWER_TRACE_TELEGRAM_SDK && 'Set ANSWER_TRACE_TELEGRAM_SDK to a locally downloaded official SDK',
}, async t => {
  const initData = `auth_date=1&start_param=run__${runId}&hash=SECRET_SIGNATURE&user=SECRET_USER`;
  const launch = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: 'SECRET_VERSION',
    tgWebAppPlatform: 'SECRETPLATFORM', tgWebAppStartParam: 'SECRET_HASH', SECRET_KEY: 'SECRET_VALUE' });
  const { page } = await openApp(t, { officialSdk: true, suffix: `?tgWebAppStartParam=SECRET_QUERY#${launch}` });
  const log = page.locator('#diagnostics-log');
  assert.equal(await log.isVisible(), false);
  await page.getByText('Диагностика запуска', { exact: true }).click({ timeout: 1000 });
  const output = await log.innerText();
  assert.doesNotMatch(output, /SECRET/);
  assert.match(output, /^\+\d+ мс · Сборка design-v1/m);
  assert.match(output, /SDK: да; платформа: unknown; версия: неизвестна/);
  assert.ok(output.includes(`initData: есть; длина ${initData.length}`));
  assert.ok(output.includes(`Подписанный start_param: строка; длина 41; UUID ${runId}`));
  assert.match(output, /URL query: строка; длина 12; неверный формат/);
  assert.match(output, /URL hash: строка; длина 11; неверный формат/);
  assert.match(output, /Источник: Подписанный start_param/);
  assert.match(output, /Запрос отправлен[\s\S]*HTTP 200[\s\S]*Загружено: шагов 1, источников 1/);
});

test('HTTP 200 with malformed JSON is diagnosed as an invalid response', async t => {
  const { page } = await openApp(t, { offline: true });
  await page.unroute('**/api/v1/telegram/answer-trace/**');
  await page.route('**/api/v1/telegram/answer-trace/**', route => route.fulfill({
    contentType: 'application/json', body: 'SECRET_RESPONSE',
  }));
  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.locator('#error').waitFor({ state: 'visible' });
  const output = await page.locator('#diagnostics-log').innerText({ timeout: 1000 });
  assert.match(output, /HTTP 200[\s\S]*Некорректный ответ/);
  assert.doesNotMatch(output.split('HTTP 200').at(-1), /Ошибка сети|SECRET_RESPONSE/);
});

test('sheet links remain visible in forward and reverse tab order on short enlarged viewport', async t => {
  const sources = Array.from({ length: 10 }, (_, n) => ({ url: `https://example.org/${n}`, title: `Source ${n}` }));
  const { page } = await openApp(t, { data: { ...trace, steps: [{ ...trace.steps[0],
    label: 'Искал страницы по запросу', query: 'Длинный поисковый запрос '.repeat(40), sources }] } });
  await page.setViewportSize({ width: 375, height: 380 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.documentElement.style.fontSize = '24px');
  await page.locator('#steps button').click();
  await page.locator('#close-detail').focus();
  for (const key of ['Tab', 'Shift+Tab']) {
    if (key === 'Shift+Tab') await page.locator('#detail-sources a').last().focus();
    for (let n = 0; n < 10; n++) {
      await page.keyboard.press(key);
      const result = await page.evaluate(() => {
        const active = document.activeElement;
        const rect = active.getBoundingClientRect();
        const header = document.querySelector('.sheet-header').getBoundingClientRect();
        return { link: active.matches('#detail-sources a'), top: rect.top, bottom: rect.bottom, headerBottom: header.bottom, height: innerHeight };
      });
      if (result.link) assert.ok(result.top >= result.headerBottom - 1 && result.bottom <= result.height + 1, JSON.stringify(result));
    }
  }
});

test('renders all backend-bounded memory facts and aggregate sources', async t => {
  const memory_facts = Array.from({ length: 200 }, (_, n) => ({ id: `fact-${n}`, text: `Fact ${n}`, version: 1 }));
  const sources = Array.from({ length: 1000 }, (_, n) => ({ url: `https://example.org/${n}`, title: `Source ${n}` }));
  const { page } = await openApp(t, { data: { ...trace, memory_facts, sources } });
  assert.equal(await page.locator('#memory-facts li').count(), 200);
  assert.equal(await page.locator('#sources a').count(), 1000);
  assert.equal(await page.locator('#source-count').innerText(), 'Источники 1000');
});

test('static entry uses absolute asset paths and accessible markup', async () => {
  const html = await readFile(join(assetRoot, 'index.html'), 'utf8');
  assert.match(html, /src="\/telegram\/answer-trace\/app\.js\?v=design-v1"/);
  assert.match(html, /href="\/telegram\/answer-trace\/style\.css\?v=design-v1"/);
  assert.match(html, /<dialog[^>]+aria-labelledby=/);
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('renders authenticated trace with safe text and no credential storage', async t => {
  const { page, requests, external, errors } = await openApp(t);
  assert.equal(await page.locator('#duration').innerText(), '8 с');
  assert.equal(await page.locator('#model').innerText(), 'test/model');
  assert.match(await page.locator('#history-count').innerText(), /12/);
  assert.equal(await page.locator('#memory-facts').innerText(), '<b>Пишу по-русски</b>');
  assert.equal(await page.locator('#source-count').innerText(), 'Источники 1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${origin}/api/v1/telegram/answer-trace/${runId}`);
  assert.match(requests[0].headers.authorization, /^tma auth_date=1&/);
  assert.equal(await page.locator('img, main script, #memory-facts b').count(), 0);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
});

test('step sheet has query, source title/domain/letter and keyboard close restores focus', async t => {
  const { page } = await openApp(t);
  const step = page.locator('#steps button').first();
  await step.click();
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator('#detail-query').innerText(), '<script>alert(1)</script>');
  const link = page.locator('#detail-sources a');
  assert.equal(await link.getAttribute('href'), source.url);
  assert.match(await link.innerText(), /example\.org/);
  assert.match(await link.innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await link.locator('.domain-letter').innerText(), 'E');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await step.evaluate(button => button === document.activeElement), true);
  await step.click();
  await page.getByRole('button', { name: 'Закрыть детали' }).click();
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), false);
  await step.click();
  await page.evaluate(() => window.testBack());
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#close-app').count(), 0);
});

test('rejects unsafe links and caps step sources at ten', async t => {
  const unsafe = ['javascript:alert(1)', 'data:text/html,hi', 'file:///tmp/test', 'https://user:password@example.org/'];
  const sources = [...unsafe.map(url => ({ url, title: 'unsafe' })),
    ...Array.from({ length: 14 }, (_, n) => ({ url: `https://example.org/${n}`, title: `Page ${n}` }))];
  const { page } = await openApp(t, { data: { ...trace, sources,
    steps: [{ ...trace.steps[0], sources }] } });
  await page.locator('#steps button').first().click();
  assert.equal(await page.locator('#detail-sources a').count(), 10);
  assert.equal(await page.locator('a[href^="javascript:"], a[href^="data:"], a[href*="password"]').count(), 0);
});

test('shows unknown history, empty steps/sources/memory without inventing data', async t => {
  const { page } = await openApp(t, { data: { ...trace, duration_ms: null, model: null,
    steps: [], sources: [], history_message_count: null, memory_facts: [] } });
  assert.match(await page.locator('#duration').innerText(), /не указано/);
  assert.match(await page.locator('#history-count').innerText(), /не сохранено/);
  assert.match(await page.locator('#steps').innerText(), /не сохранены/);
  assert.match(await page.locator('#memory-facts').innerText(), /не использовались/);
  assert.equal(await page.locator('#source-count').innerText(), 'Источники 0');
});

for (const status of [401, 403, 404, 500]) {
  test(`handles HTTP ${status} without exposing response content`, async t => {
    const { page } = await openApp(t, { status, data: { detail: 'sensitive-server-diagnostic' } });
    assert.equal(await page.locator('#error').isVisible(), true);
    assert.equal(await page.locator('#trace').isVisible(), false);
    assert.doesNotMatch(await page.locator('body').innerText(), /sensitive-server-diagnostic/);
    assert.equal(await page.locator('#diagnostics-log').isVisible(), true);
    assert.match(await page.locator('#diagnostics-log').innerText({ timeout: 1000 }), new RegExp(`HTTP ${status}`));
    assert.match(await page.locator('#error').innerText(), status === 404 ? /не найден/ : status < 500 ? /Telegram/ : /загрузить/);
  });
}

test('missing Telegram authentication and invalid start parameters never fetch data', async t => {
  for (const options of [{ telegram: false }, { startParam: 'run__../../secrets' }, { startParam: '' }]) {
    const { page, requests } = await openApp(t, options);
    assert.equal(await page.locator('#error').isVisible(), true);
    assert.equal(requests.length, 0);
  }
});

test('URL start parameter fallback works without putting initData in the request URL', async t => {
  const { requests } = await openApp(t, { startParam: '', suffix: `?tgWebAppStartParam=run__${runId}` });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.includes('auth_date'), false);
});

test('network failure is actionable and retry succeeds', async t => {
  const { page } = await openApp(t, { offline: true });
  assert.match(await page.locator('#error').innerText(), /загрузить/);
  assert.match(await page.locator('#diagnostics-log').innerText({ timeout: 1000 }), /Ошибка сети/);
  await page.unroute('**/api/v1/telegram/answer-trace/**');
  await page.route('**/api/v1/telegram/answer-trace/**', route => route.fulfill({ json: trace }));
  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.locator('#trace').waitFor({ state: 'visible' });
});

test('Telegram theme changes, narrow/landscape layout and modal focus confinement', async t => {
  const { page, errors } = await openApp(t, { suffix: '/' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(23, 33, 43)');
  assert.equal(await page.locator('#steps .source-stack').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(35, 47, 59)');
  if (process.env.ANSWER_TRACE_SCREENSHOTS) {
    await mkdir(process.env.ANSWER_TRACE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.ANSWER_TRACE_SCREENSHOTS, 'dark.png'), fullPage: true });
    await page.locator('#steps button').first().click();
    await page.screenshot({ path: join(process.env.ANSWER_TRACE_SCREENSHOTS, 'sheet.png'), fullPage: true });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => {
    window.Telegram.WebApp.themeParams.bg_color = '#ffffff';
    window.Telegram.WebApp.colorScheme = 'light';
    window.testTelegramEvents.themeChanged();
  });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await page.locator('#steps .source-stack').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(240, 242, 244)');
  for (const viewport of [{ width: 320, height: 640 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.documentElement.style.fontSize = '32px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#steps button').first().click();
  for (let n = 0; n < 5; n++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector('dialog').contains(document.activeElement)), true);
  }
  assert.deepEqual(errors, []);
});

test('modal backdrop dismisses the sheet and preserves trigger focus', async t => {
  const { page } = await openApp(t);
  const step = page.locator('#steps button').first();
  await step.click();
  await page.mouse.click(8, 8);
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), false);
  assert.equal(await step.evaluate(button => button === document.activeElement), true);
});

test('malformed or wrong-run responses fail safely', async t => {
  for (const data of [null, {}, { ...trace, run_id: 'another-run' }, { ...trace, steps: null }]) {
    const { page, errors } = await openApp(t, { data });
    assert.equal(await page.locator('#error').isVisible(), true);
    assert.equal(await page.locator('#trace').isVisible(), false);
    assert.match(await page.locator('#diagnostics-log').innerText({ timeout: 1000 }), /Некорректный ответ/);
    assert.deepEqual(errors, []);
  }
});

test('source links fall back to domain titles and deduplicate URLs', async t => {
  const sources = [{ url: 'https://www.example.org/page', title: '' },
    { url: 'https://www.example.org/page', title: 'duplicate' }, { url: 'not a URL', title: 'bad' }];
  const { page } = await openApp(t, { data: { ...trace, sources } });
  assert.equal(await page.locator('#sources a').count(), 1);
  assert.equal(await page.locator('#sources .source-title').innerText(), 'example.org');
  assert.equal(await page.locator('#sources .domain-letter').innerText(), 'E');
  assert.equal(await page.locator('#source-count').innerText(), 'Источники 1');
});

test('start page shows question, quote and a safely rendered answer with sources popover', async t => {
  const { page, errors } = await openApp(t, { data: { ...trace, question: 'Что он имеет в виду?', quote: 'Цитата <i>x</i>',
    asked_at: '2026-11-19T07:12:00Z',
    answer: 'Речь об **энергетике** <img src=x onerror=alert(1)>\n\n- Первый `пункт`\n- [ссылка](javascript:alert(1))' } });
  assert.equal(await page.locator('#question').innerText(), 'Что он имеет в виду?');
  assert.equal(await page.locator('#quote').innerText(), 'Цитата <i>x</i>');
  assert.equal(await page.locator('#summary-title').innerText(), 'Проверил 1 источник');
  assert.equal(await page.locator('#answer b').innerText(), 'энергетике');
  assert.equal(await page.locator('#answer li').count(), 2);
  assert.equal(await page.locator('#answer img, #answer a, #answer i').count(), 0);
  assert.match(await page.locator('#answer').innerText(), /<img src=x/);
  assert.equal(await page.locator('#sources-popover').isVisible(), false);
  await page.locator('#sources-toggle').click();
  assert.equal(await page.locator('#sources-popover a').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sources-popover').isVisible(), false);
  await page.locator('#summary-toggle').click();
  assert.equal(await page.locator('#steps').isVisible(), false);
  assert.deepEqual(errors, []);
});
