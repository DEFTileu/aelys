/* The server authenticates initData and owns all access checks. This page is read-only. */
(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  let telegram;
  const dialog = byId('step-dialog');
  let returnFocus = null;
  let fetching = false;
  let runId;
  const diagnostics = byId('diagnostics');
  const diagnosticsLog = byId('diagnostics-log');
  const diagnosticEntries = [];
  const startedAt = performance.now();
  const platforms = new Set(['ios', 'android', 'tdesktop', 'macos', 'web', 'weba', 'webk', 'unigram', 'unknown']);

  function recordDiagnostic(entry) {
    diagnosticEntries.push(`+${Math.round(performance.now() - startedAt)} мс · ${entry}`);
    if (diagnosticEntries.length > 20) diagnosticEntries.shift();
    diagnosticsLog.textContent = diagnosticEntries.join('\n');
  }

  function parseRunId(value) {
    return typeof value === 'string'
      ? /^run__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value)?.[1]
      : undefined;
  }

  function describeCandidate(value) {
    if (value == null) return 'отсутствует';
    if (typeof value !== 'string') return `тип ${typeof value}`;
    const id = parseRunId(value);
    return `строка; длина ${value.length}; ${id ? `UUID ${id}` : 'неверный формат'}`;
  }

  function snapshotLaunch(sdkStatus = '') {
    const { platform, version, initData, initDataUnsafe } = telegram || {};
    const safePlatform = platforms.has(platform) ? platform : 'unknown';
    const safeVersion = typeof version === 'string' && version.length <= 11
      && /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/.test(version) ? version : 'неизвестна';
    recordDiagnostic(telegram
      ? `SDK: да; платформа: ${safePlatform}; версия: ${safeVersion}`
      : `SDK: нет${sdkStatus ? `; ${sdkStatus}` : ''}`);
    const authLength = typeof initData === 'string' ? initData.length : 0;
    recordDiagnostic(`initData: ${authLength ? 'есть' : 'нет'}; длина ${authLength}`);
    const candidates = [
      ['Подписанный start_param', new URLSearchParams(authLength ? initData : '').get('start_param')],
      ['Непроверенный start_param', initDataUnsafe?.start_param],
      ['URL query', new URLSearchParams(window.location.search).get('tgWebAppStartParam')],
      ['URL hash', new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppStartParam')],
      ['Параметр SDK', window.Telegram?.WebView?.initParams?.tgWebAppStartParam],
    ];
    for (const [label, value] of candidates) recordDiagnostic(`${label}: ${describeCandidate(value)}`);
    // Select by launch precedence before validating the UUID. Only the server verifies access.
    const selected = candidates.find(([, value]) => value);
    recordDiagnostic(`Источник: ${selected?.[0] ?? 'отсутствует'}`);
    return parseRunId(selected?.[1]);
  }

  function clearLaunchCopies() {
    // Run only after the official SDK has copied launch data into WebApp.initData.
    // Keep authentication in memory, but remove its SDK cache and URL copy.
    try {
      const key = '__telegram__initParams';
      const cached = window.sessionStorage.getItem(key);
      if (cached) {
        try {
          const params = JSON.parse(cached);
          delete params.tgWebAppData;
          window.sessionStorage.setItem(key, JSON.stringify(params));
        } catch {
          window.sessionStorage.removeItem(key);
        }
      }
    } catch {
      // Storage can be unavailable in restricted WebViews; auth remains in memory.
    }
    const launchUrl = new URL(window.location.href);
    const launchHash = new URLSearchParams(launchUrl.hash.slice(1));
    if (launchHash.has('tgWebAppData') || launchUrl.searchParams.has('tgWebAppData')) {
      launchHash.delete('tgWebAppData');
      launchUrl.searchParams.delete('tgWebAppData');
      launchUrl.hash = launchHash.toString();
      window.history.replaceState(window.history.state, '', launchUrl);
    }
  }

  const text = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const items = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
  const element = (tag, content, className) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  };

  function applyTheme() {
    if (telegram) document.documentElement.dataset.theme = telegram.colorScheme === 'dark' ? 'dark' : 'light';
    document.documentElement.style.colorScheme = telegram?.colorScheme === 'dark' ? 'dark' : 'light';
    for (const name of ['bg_color', 'text_color', 'hint_color', 'link_color',
      'button_color', 'button_text_color', 'secondary_bg_color', 'section_bg_color']) {
      const color = telegram?.themeParams?.[name];
      const property = `--tg-theme-${name.replaceAll('_', '-')}`;
      // Only color values enter CSS; custom Telegram themes remain supported.
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
        document.documentElement.style.setProperty(property, color);
      } else {
        document.documentElement.style.removeProperty(property);
      }
    }
  }

  function safeSources(value, limit = 10) {
    const result = [];
    const seen = new Set();
    for (const source of items(value, 1000)) {
      if (!source || typeof source.url !== 'string' || source.url.length > 2048) continue;
      try {
        const url = new URL(source.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        result.push({ url: url.href, domain: url.hostname.replace(/^www\./, ''), title: text(source.title, 300) });
        if (result.length === limit) break;
      } catch {
        // Malformed URLs never become links.
      }
    }
    return result;
  }

  function renderSources(target, sources, emptyMessage) {
    target.replaceChildren();
    if (!sources.length) {
      target.append(element('li', emptyMessage, 'empty secondary'));
      return;
    }
    for (const source of sources) {
      const row = element('li');
      const link = element('a', undefined, 'source-link');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      const letter = element('span', source.domain.charAt(0).toLocaleUpperCase('ru'), 'domain-letter');
      letter.setAttribute('aria-hidden', 'true');
      const copy = element('span', undefined, 'source-copy');
      copy.append(element('span', source.title || source.domain, 'source-title'),
        element('span', source.domain, 'source-domain secondary'));
      link.append(letter, copy);
      row.append(link);
      target.append(row);
    }
  }

  function statusLabel(status) {
    return ({ completed: 'Завершено', succeeded: 'Завершено', success: 'Завершено',
      failed: 'Ошибка', error: 'Ошибка', denied: 'Не разрешено', cancelled: 'Отменено',
      skipped: 'Пропущено', running: 'Выполняется', pending: 'В ожидании',
      requested: 'Запрошено', approved: 'Разрешено' })[status] || 'Статус не указан';
  }

  function stepLabel(step) {
    return text(step.label, 300) || ({ web_search: 'Поиск в интернете',
      read_chat_history: 'Чтение истории чата' })[step.kind] || 'Шаг ответа';
  }

  function closeDetails() {
    if (dialog.open) dialog.close();
  }

  function showDetails(step, button) {
    returnFocus = button;
    byId('detail-title').textContent = stepLabel(step);
    byId('detail-status').textContent = statusLabel(step.status);
    const query = text(step.query);
    byId('query-section').hidden = !query;
    byId('detail-query').textContent = query;
    renderSources(byId('detail-sources'), safeSources(step.sources), 'Источники для этого шага не сохранены.');
    dialog.showModal();
    byId('detail-title').focus();
    telegram?.BackButton?.show();
  }

  function renderTrace(data) {
    byId('duration').textContent = typeof data.duration_ms === 'number' && Number.isFinite(data.duration_ms) && data.duration_ms >= 0
      ? `Работал ${new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(data.duration_ms / 1000)} с`
      : 'Время работы не указано';
    byId('model').textContent = text(data.model, 160) || 'Модель не указана';
    const steps = byId('steps');
    steps.replaceChildren();
    for (const step of items(data.steps, 100)) {
      if (!step || typeof step !== 'object') continue;
      const row = element('li');
      const button = element('button', undefined, 'step-button');
      button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'step-dialog');
      const copy = element('span', undefined, 'step-copy');
      copy.append(element('span', stepLabel(step), 'step-label'),
        element('span', statusLabel(step.status), 'step-status secondary'));
      const arrow = element('span', '›', 'step-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      button.append(copy, arrow);
      button.addEventListener('click', () => showDetails(step, button));
      row.append(button);
      steps.append(row);
    }
    if (!steps.children.length) steps.append(element('li', 'Шаги этого ответа не сохранены.', 'empty secondary'));
    const count = data.history_message_count;
    byId('history-count').textContent = Number.isSafeInteger(count) && count >= 0
      ? `Сообщений истории в контексте: ${count}`
      : 'Число сообщений истории не сохранено для этого ответа.';
    const memory = byId('memory-facts');
    memory.replaceChildren();
    for (const fact of items(data.memory_facts, 200)) {
      if (!fact || !text(fact.text)) continue;
      const row = element('li', text(fact.text));
      if (Number.isSafeInteger(fact.version) && fact.version > 0) row.title = `Версия ${fact.version}`;
      memory.append(row);
    }
    if (!memory.children.length) memory.append(element('li', 'Актуальные факты памяти не использовались.', 'empty secondary'));
    const sources = safeSources(data.sources, 1000);
    byId('source-count').textContent = `Источники ${sources.length}`;
    renderSources(byId('sources'), sources, 'Источники для этого ответа не сохранены.');
    byId('trace').hidden = false;
  }

  function showError(title, message, retry = false) {
    byId('trace').hidden = true;
    byId('error-title').textContent = title;
    byId('error-message').textContent = message;
    byId('retry').hidden = !retry;
    byId('error').hidden = false;
    diagnostics.open = true;
  }

  function showLoadError() {
    showError('Не удалось загрузить шаги', 'Проверьте подключение к интернету и повторите попытку.', true);
  }

  async function load() {
    if (fetching) return;
    fetching = true;
    byId('error').hidden = true;
    byId('loading').hidden = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let readingResponse = false;
    try {
      const initData = telegram?.initData;
      if (typeof initData !== 'string' || !initData) {
        showError('Откройте из Telegram', 'Откройте ссылку под ответом бота в Telegram.');
        return;
      }
      if (!runId) {
        showError('Нет ссылки на ответ', 'Откройте ссылку под конкретным ответом бота в Telegram.');
        return;
      }
      recordDiagnostic('Запрос отправлен');
      const response = await fetch(`/api/v1/telegram/answer-trace/${runId}`, {
        method: 'GET', headers: { Authorization: `tma ${initData}`, Accept: 'application/json' },
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      recordDiagnostic(`HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) {
        showError('Вход через Telegram истёк или недоступен', 'Закройте окно и откройте ссылку заново в Telegram из чата владельца с ботом.');
        return;
      }
      if (response.status === 404) {
        showError('Ответ не найден', 'Проверьте, что открыли ссылку из своего чата с ботом.');
        return;
      }
      if (!response.ok) {
        showLoadError();
        return;
      }
      readingResponse = true;
      const data = await response.json();
      if (!data || typeof data !== 'object' || typeof data.run_id !== 'string' || data.run_id.toLowerCase() !== runId.toLowerCase()
        || !Array.isArray(data.steps) || !Array.isArray(data.sources) || !Array.isArray(data.memory_facts)) {
        throw new Error('Invalid trace');
      }
      renderTrace(data);
      recordDiagnostic(`Загружено: шагов ${data.steps.length}, источников ${data.sources.length}`);
    } catch {
      recordDiagnostic(controller.signal.aborted ? 'Время ожидания запроса истекло'
        : readingResponse ? 'Некорректный ответ' : 'Ошибка сети');
      showLoadError();
    } finally {
      clearTimeout(timeout);
      fetching = false;
      byId('loading').hidden = true;
    }
  }

  byId('retry').addEventListener('click', () => telegram ? load() : window.location.reload());
  byId('close-detail').addEventListener('click', closeDetails);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetails();
  });
  dialog.addEventListener('close', () => {
    telegram?.BackButton?.hide();
    returnFocus?.focus();
  });
  function start() {
    if (telegram) return;
    telegram = window.Telegram?.WebApp;
    runId = snapshotLaunch();
    if (!telegram) {
      showError('Откройте из Telegram', 'Откройте ссылку под ответом бота в Telegram.');
      byId('loading').hidden = true;
      return;
    }
    clearLaunchCopies();
    telegram.BackButton?.onClick(closeDetails);
    telegram.BackButton?.hide();
    telegram.onEvent?.('themeChanged', applyTheme);
    applyTheme();
    telegram.ready();
    telegram.expand();
    byId('loading').textContent = 'Загружаю шаги ответа…';
    load();
  }
  applyTheme();
  recordDiagnostic('Сборка launch-v2');
  const sdk = byId('telegram-sdk');
  byId('loading').textContent = 'Подключаю Telegram…';
  if (window.Telegram?.WebApp) {
    start();
  } else {
    const unavailable = (status) => {
      snapshotLaunch(status);
      byId('loading').hidden = true;
      showError('Не удалось подключить Telegram', 'Проверьте подключение и откройте ссылку заново в Telegram.', true);
    };
    const timeout = setTimeout(() => unavailable('время ожидания истекло'), 15000);
    sdk.addEventListener('load', () => {
      clearTimeout(timeout);
      start();
    }, { once: true });
    sdk.addEventListener('error', () => {
      clearTimeout(timeout);
      unavailable('ошибка загрузки');
    }, { once: true });
  }
})();
