# Telegram Business: бот-секретарь

**Статус: Phase 3 personal + Business, live acceptance требуется**, задача Phase 3 «Telegram commands and verified binding». Backend и интерфейс реализованы и проверены автоматическими тестами; подключение к Telegram с настоящим токеном и бизнес-перепиской ещё не проверено. Владелец подтвердил Business read/reply и расширенный личный scope (ADR-027/028). Выполнены этапы 0–6: sync, reminders, текстовый AI, ephemeral media, explicit memory и task matrix/time; Google остаётся следующим этапом (см. `PERSONAL_OS_BOT_REPORT.md`).

## Подключение

### Команды владельца в переписке: `/ask` и `/search` (2026-11-13)

В разрешённом личном Business-чате владелец может отправить:

- `/ask что такое Elasticsearch` — краткое объяснение простыми словами;
- `/ask` в ответ на сообщение собеседника — объяснение его текста;
- `/ask` с выделенной цитатой «Proxmox» — объяснение только выделенного фрагмента;
- `/search Proxmox` или `/search` с reply/цитатой — ответ с реальным поиском
  настроенного Claude/OpenRouter и 1–2 ссылками из результатов провайдера.

Допускаются `ask`, `search`, `/ ask`, `/ search` в начале сообщения, регистр не
важен. Предпочтительнее slash-команды, чтобы обычная реплика случайно не стала
запросом. Явный вопрос после команды — инструкция владельца, цитата — только
недоверенные данные. Выделенная цитата имеет приоритет перед полным reply.

Бот **редактирует исходную команду владельца**: сохраняет весь вопрос сверху,
добавляет пустую строку, короткий ответ и для поиска ссылки. Новое сообщение в
чат не отправляется; исходный reply/выделенная цитата сохраняются, сообщение
собеседника не редактируется. Удаление/редактирование команды до публикации
отменяет ожидающий ответ. Команды из сообщений контактов, ботов, пересылок и
групп не исполняются; личная память/задачи/почта не передаются модели.

Команды используют отдельную **сессию своего чата**: в течение 60 минут между
принятыми запросами владельца новый `/ask` или `/search` видит до восьми последних
успешных вопросов/ответов (до 12 000 символов). Можно написать `/ask а чем он
отличается от Solr?` после вопроса про Elasticsearch. После часа без запросов
владельца начинается новая сессия; ровно на границе часа тоже новая. `/new`
в этом чате начинает новую сразу. Сессия назначается при приёме команды и
сохраняется с очередью: задержка генерации/перезапуск не продлевают её.
Обычные сообщения собеседника/владельца сами по себе команды не запускают и
таймер не продлевают. Личный бот и разные собеседники не смешивают контекст.

Поиск фактов для агента использует короткие общие карточки Knowledge, например
описание Aelys и его стека. Для своей карточки нужны **оба** условия: точный тег
`agent-context` и **Enable for AI**. Встроена одна общая карточка Aelys.
Настройка и пример: [AGENT_KNOWLEDGE.md](AGENT_KNOWLEDGE.md). Личные задачи,
календарь, почта, финансы и файлы исходного кода не подключаются. В карточки
пишут понятные факты, а не пути/номера строк/реализацию. Это правило отбора
материалов владельцем, не автоматический классификатор приватности.

Текущая цитата имеет приоритет над историей. Карточки и цитаты — недоверенные
данные; они не выдают разрешений. Ссылки на версии источников и использованные
ходы сохраняются транзитивно: удаление/изменение хода либо карточки, снятие тега
или AI-доступа исключают и производные ответы из будущего контекста. Перед
публикацией источники проверяются снова. История прошлых сессий автоматически
не подмешивается. Завершить сессию — не значит удалить её: остаётся существующий
семидневный retention; revoke/disconnect очищает данные. Новое поле ответа
зашифровано и включено в ротацию ключей.

Редактирование требует действующего `can_reply`, входящего за последние 24 часа
и команды не старше 48 часов. Если весь исходный текст вместе с ответом и
ссылками превышает 4096 символов, команда сохраняется и владелец получает личное
уведомление. Ошибка/неизвестный результат редактирования не вызывает отправку
отдельного ответа или автоматический повтор.

Автоответ может быть выключен: команда владельца является отдельным явным
запросом. Нужны настроенный AI-провайдер и модель, работающее Business-подключение,
право `can_reply` и входящее за последние 24 часа. Ограничения Telegram не
обходятся. Без сети/ключа или при ошибке поиска обычный ответ не выдаётся за
веб-результат; уведомление об ошибке идёт в личку владельца. Неизвестный результат
отправки требует проверки переписки, автоматического повторения нет.

`/search` включает hosted поиск: Claude — до 2 обращений к поиску за запрос;
OpenRouter — web plugin с Exa и максимум 3 результата. Это дополнительные
внешние запросы и расходы по правилам провайдера; их учёт добавлен в usage,
доступный бюджет проверяется перед вызовом. Отправляется только вопрос и
выбранная цитата, без полной истории чата. Не используйте команду для раскрытия
секретов; существующая проверка чувствительного содержимого сохраняется.

Требуются миграции до `0054_telegram_command_sessions` и перезапуск обновлённого
backend. Очередь зашифрована, сохраняется вместе с receipt/cursor; одинаковый
update/message не порождает второй ответ. Прерванное выполнение не запускается
заново автоматически. При disconnect/отзыве доступа удаляется/очищается контекст
команд; retention — не более 7 дней. Live-проверка остаётся обязательной.

1. Создайте личного бота через [@BotFather](https://t.me/BotFather). В настройках бота включите **Secretary Mode**. Проверка `getMe` должна показать `can_connect_to_business: true`; если поле отсутствует или не равно `true`, настройка не готова.
2. Войдите в Aelys как владелец и в настройках Telegram введите токен бота. Поле предназначено только для записи: backend шифрует токен в хранилище секретов и не возвращает его в клиент. Не отправляйте токен в чат и не помещайте его в файлы репозитория.
3. В Aelys создайте одноразовую, ограниченную по времени ссылку привязки и откройте её **из личного Telegram-аккаунта владельца**: `https://t.me/<bot_username>?start=aelys_CODE`. Нажатие Start передаст боту `/start aelys_CODE`. Ссылка является секретом до использования: не пересылайте её. Сервер атомарно погашает challenge и сохраняет числовой Telegram ID владельца; повтор, просроченный код и посторонние команды отклоняются. Параметр `start` допускает только `A–Z`, `a–z`, `0–9`, `_`, `-` и не более 64 символов.
4. В официальном клиенте Telegram откройте **Settings → Telegram Business → Chatbots**, подключите этого бота к тому же аккаунту и выберите разрешённые личные чаты и права. Для ответа необходимо разрешение на ответы. Привязка через `/start` сама по себе бизнес-подключение не создаёт. Backend должен сопоставить владельца последнего `BusinessConnection` с привязанным Telegram ID; чужое подключение не даёт доступа к Aelys.
5. Укажите персону секретаря и настройте существующий BYOK AI-провайдер. По умолчанию ответ готовится как черновик по запросу владельца, а автоответ выключен. Для автоматических ответов владелец отдельно включает их и разрешает соответствующее действие через Policy Engine. Без настройки персоны, провайдера, разрешения передачи данных и необходимых прав Telegram ответ не отправляется.

Права и список чатов можно изменить или отозвать в настройках Telegram. Перед отправкой backend заново проверяет подключение и право ответа; после получения события отключения очищается содержимое сообщений этого подключения. Наличие Telegram Business и доступность этой функции зависят от аккаунта и Telegram.

## Как работает обработка

Локальный работающий backend получает обновления через Bot API `getUpdates` (long polling); публичный домен и webhook не нужны, но сеть и запущенный backend обязательны. Перед запуском следует проверить `getWebhookInfo`: при существующем webhook показать конфликт и остановить polling, **не удаляя webhook**. Владелец самостоятельно решает, как устранить конфликт.

Коннектор явно задаёт `allowed_updates`, включая `message` для привязки и `business_connection`, `business_message`, `edited_business_message`, `deleted_business_messages`. Telegram сохраняет предыдущий фильтр, если его не передать, а смена фильтра не влияет на уже созданные обновления. Поэтому обработчик также безопасно игнорирует неожиданные типы.

Обновления нужно устойчиво сохранять и дедуплицировать по `update_id`; подтверждать их следующим `offset` только после надёжной обработки и сохранения состояния. Сохранённый offset переживает перезапуск, а единая lease на бота исключает конкурирующие polling-процессы. Telegram хранит необработанные обновления не более 24 часов: после более долгого отключения полнота истории не гарантируется. После недели без обновлений следующий `update_id` может быть выбран случайно; текущий монотонный offset требует дополнительной проверки этого случая. Неполученные события не восстанавливаются одним только offset.

`business_connection` сообщает о подключении, изменении или отключении; храните актуальные `is_enabled` и `rights` и при необходимости запрашивайте известный ID через `getBusinessConnection`. Этот метод получает сведения по ID и не обнаруживает неизвестные подключения. Изменения и удаления сообщений должны обновлять локальное состояние и исключать устаревшие черновики; не считать входящее сообщение неизменным. Контекст чата отделён по `business_connection_id` и `chat_id`.

Перед каждой отправкой проверьте актуальное подключение и `rights.can_reply`. Оно разрешает отправлять и редактировать сообщения только в разрешённых личных чатах, где за последние 24 часа было входящее сообщение. При отправке от имени владельца используйте `business_connection_id` в `sendMessage`; Telegram остаётся окончательным источником решения и может отклонить отправку. Нет права, подходящего окна или связи — показать ошибку, не выдавать черновик за отправленный. При неопределённом результате отправки статус становится `unknown`: автоматического повтора нет, сначала проверьте переписку в Telegram.

Автоответы обрабатывают только последнее входящее каждого чата после задержки `reply_delay_seconds` (90 по умолчанию, 0–900). Допустимый возраст: от задержки до задержки + 300 секунд. Ручной ответ и новое входящее проверяются до LLM и после генерации. Ограничения: до 20 отправок в минуту на интеграцию и до 6 на чат; при ответе владельца или более новом входящем сообщении автоответ подавляется. Business-секретарь поддерживает текст, стикеры и ограниченный фото-контекст (см. исправление 2026-11-13 ниже); аудио остаётся для ручного просмотра/прослушивания. Пересланные сообщения и сообщения ботов не используются для автоответа. Личные команды `/task`, `/note`, `/today`, `/busy`, `/free`, `/help` доступны только привязанному владельцу в private-чате. Свободного AI-диалога в личке нет.

## Данные и безопасность

Текст клиента считается недоверенным. Он не даёт команд или разрешений Aelys и не открывает клиенту доступ к задачам, почте, секретам или другим данным владельца. AI для секретаря получает только необходимый контекст переписки и персоны, без инструментов и данных других модулей; автоматические действия проходят Policy Engine. Входящий текст передаётся AI только по запросу владельца на черновик или при явно включённом автоответе. При внешнем BYOK-провайдере текст покидает Aelys; до передачи нужно явно разрешить этого получателя и использование данных, с учётом применимых прав и согласий пользователей.

Telegram требует использовать данные Business только для предоставления услуги бизнес-чатбота, не раскрывать их третьим лицам, включая API, без разрешения пользователя, сообщать цели и сроки хранения и удалять данные в предусмотренных условиях. Текущая реализация шифрует текст, название чата, черновик и инструкции в базе; backend очищает содержимое сообщений старше семи дней, а при отзыве бизнес-подключения очищает его переписку. При отключении интеграции её сообщения и связи удаляются. Метаданные и резервные копии могут иметь отдельный срок жизни. До живого запуска необходимо проверить выполнение требований к раскрытию сроков и согласию. Не использовать переписку для других целей или обучения моделей. Разрешённые Telegram чаты могут содержать сообщения, медиа и файлы; ограничивайте сбор необходимым.

Bot API включает токен в URL запроса (`/bot<TOKEN>/METHOD`): скрывайте его в HTTP/access-логах, трассировках, исключениях, метриках и отладочных дампах, включая URL и заголовки. Не записывайте текст переписки, коды привязки или секреты в логи. При утечке отзовите токен через BotFather и заново настройте подключение.

## Источники и проверка

- [Telegram Bot Features: Business Bots и deep linking](https://core.telegram.org/bots/features#business-bots).
- [Bot API: обновления и getUpdates](https://core.telegram.org/bots/api#getupdates), [BusinessConnection и права](https://core.telegram.org/bots/api#businessconnection), [getBusinessConnection](https://core.telegram.org/bots/api#getbusinessconnection), [sendMessage](https://core.telegram.org/bots/api#sendmessage).
- [Telegram Privacy Policy §6.5](https://telegram.org/privacy#6-5-telegram-business-chatbots), [Bot Developer Terms §5.4](https://telegram.org/tos/bot-developers#5-4-telegram-business) и [Telegram Business Terms §7.5](https://telegram.org/tos/business).

**Проверка:** актуальные результаты и все 15 сценариев приведены в [отчёте](TELEGRAM_PERSONAL_ASSISTANT_REPORT.md). Live end-to-end проверка с настоящим токеном и разрешённой бизнес-перепиской не проводилась. Нужна проверка на реальном подключении, включая отзыв прав, доставку и восстановление после отключения.


## Personal + Business, 2026-11-01

Один бот Aelys и один poller, отдельно от бота MySDU. В Telegram Business
подключение MySDU на этом аккаунте при переключении отключает сам владелец;
учебный бот и его Sheets monitor сохраняются. Aelys не изменяет MySDU.

### Исправление контекста Business-секретаря, 2026-11-13

Секретарь получает имя автора исходящего ответа из проверенной привязки Telegram
или актуального BusinessConnection. Имя хранится зашифрованно; входящие имена,
цитаты и названия чатов не меняют личность владельца. Для существующей интеграции
имя заполняется при следующей проверке подключения перед генерацией. Требуется
миграция `0052_telegram_owner_identity` (`alembic upgrade head` из backend).

Промпт адаптирован из MySDU: ответ адресован собеседнику от первого лица владельца;
служебная заметка видна только владельцу. Ручные ответы и прежние автоответы
различаются в контексте. Явное обращение к владельцу в начале сгенерированного
ответа или посреднический голос превращаются в `handoff`, а не отправляются.
Это ограниченная проверка известных ошибок адресата, не полный семантический
анализ всех возможных формулировок.

Текущая неотвеченная серия входящих может включать до двух фото. Байты загружаются
временно через существующие проверки доступа и лимит 10 MiB на фото; модель
выбирается с capability `images` до загрузки. Факт вложения и ссылка reply
сохраняются в ограниченном контексте, включая фото без подписи. Неподдерживаемая
модель, недоступная картинка, более двух фото или непрочитанное аудио в этой серии
дают `handoff` владельцу без ответа собеседнику. Уже отвеченные старые фото
повторно не скачиваются. Байты и тексты Business-переписки не записываются в AI
history; учёт стоимости вызова сохраняется и для отклонённого ответа.

Это локальное исправление; live-проверка на разрешённом Telegram-чате остаётся
отдельным acceptance. Постоянное хранилище вложений и новые права не добавляются.

В Settings → Telegram задаются IANA timezone (default UTC), nullable digest_time
(HH:MM, пусто = выключено), reply_delay_seconds и виден текущий статус.
`/task` и `/note`: первая строка 1–300 символов; для note весь текст сохраняется
в Markdown и создаётся revision 1. Запись и receipt/cursor commit атомарны,
подтверждение после commit. Shortcut: ошибка подтверждения не откатывает запись,
не повторяется автоматически и может оставить владельца без Telegram-квитанции.

`/today` детерминированно выводит задачи со сроком в локальный день, просроченные
незавершённые и события с RRULE/DST. Сводка использует ту же повестку. Работает
только при digest_time и в локальном окне [time,time+2h); day claim сохраняется
перед отправкой, не более раза в календарный день. После пропуска окна отправки
за день нет; потерянная отправка не повторяется.

`/busy HH:MM <текст>` (до 200 символов) задаёт разрешённый для собеседников статус
до следующего наступления времени в timezone владельца; `/free` очищает. Истёкший
статус не попадает в prompt. Остальные личные модули не раскрываются секретарю.

Секретарь отвечает строгим JSON: `reply` с текстом, `no_reply` без текста либо
`handoff` с owner_note и без текста собеседнику. Невалидные решения отклоняются.
Handoff сохраняет зашифрованную заметку и одну Notification без переписки
(только message_id в data). Заметка отправляется в личку владельцу через Policy
Engine; отказ доставки не теряет Notification. Решения handoff/no_reply не
отправляются автоматически. После них владелец может заново создать черновик
или вручную отправить собственный текст. owner_note остаётся отдельным блоком,
не подставляется в ответ и стирается с содержимым при редактировании, удалении,
отзыве подключения и 7-дневной ретенции.

Sync Stage 1: capture и рабочие REST мутации Task/Note теперь пишут общий
SyncChange в той же транзакции. Записи доступны через REST, sync/pull и bootstrap.
Подробности версий, блокировки владельца и старых данных — в SYNC_PROTOCOL.md.
Live-check владельца: реальный `/task`, Business-переписка с задержкой, handoff,
права can_reply и самостоятельное отключение Business-бота MySDU на аккаунте.


## Исправления поведения после ревью, 2026-11-01

После генерации готового ответа worker выполняет `poll_once(timeout=0)` и только
затем проверяет актуальность перед отправкой. Сообщение владельца или новое
входящее из этого poll отменяет устаревший ответ. Если poll завершился ошибкой,
не получил lease или потерял его до обработки обновлений, автоматическая отправка
не выполняется: сохранённый `ready` черновик доступен владельцу. Даже успешный poll
не может исключить сообщение, пришедшее в Telegram после его завершения.

Голос, фото, стикер, файл и пересланное сообщение владельца учитываются как его
ответ с пустым `text`. Содержимое, подписи и идентификаторы медиа не сохраняются
и не скачиваются. В истории это «Сообщение без текста»; пустые реплики не входят
в prompt. Эхо бота (`is_bot`, `sender_business_bot`) и нетекстовые сообщения клиента
остаются проигнорированными.

JSON модели допускает одну внешнюю Markdown-обёртку с языком json или без языка.
Пояснения вокруг, несколько блоков, иной язык и невалидная структура отклоняются
с AI_UNAVAILABLE. `_DecisionPayload` и разделение customer text/owner_note остаются
строгими. Повторный handoff не дублирует Notification и личное уведомление.


За итерацию рассматриваются не больше 10 разных чатов, самые новые первыми.
Общая `check_automatic_reply_current` вызывается до LLM и перед автоматической
отправкой: более новое входящее или любое последующее сообщение владельца
(включая удалённое им) подавляет автоответ. При rollback следующий кандидат
загружается явно, ошибка одного чата не ломает остальные. Rate limit, can_reply,
окно 24 часа и атомарные claims сохранены.

Личное handoff-уведомление начинается с chat_title, затем идёт owner_note.
В незашифрованной Notification по-прежнему только общий title/body и message_id.
Live-check владельца включает проверку разбора JSON от реальной модели через
реального провайдера; это не проверялось mock HTTP-тестами.


## Personal reminders — Stage 2

`/remind 18:00 текст`, `/remind 2026-11-05 18:00 текст`, `/remind 2h текст`
создают задачу и связанное Telegram-напоминание. Время — timezone владельца;
явно прошедшая дата отклоняется. Deadline reminders выключены по умолчанию;
после включения напоминания приходят за 5 часов и 10 минут до срока активной задачи.
Quiet hours start/end задаются парой: срочность их не отменяет. Перенесённая из-за
тихих часов сводка сохраняется в БД до конца окна; обычного догоняющего digest нет.
Сводка включает завтра, /today не менялся. Claim и общая Notification сохраняются
до отправки, повтора после ошибки нет. Секретарь не получает эти личные данные.


## Personal owner dialogue — Stage 3

Обычный текст проверенного владельца поступает в `telegram_personal_jobs`:
text/quote зашифрованы, update receipt и cursor коммитятся с очередью. Poll не
вызывает LLM. Тот же connector запускает не больше одного нового хода за итерацию,
с одним in-flight ходом на integration и timeout 90 секунд. Задача supervised
async: ожидание модели или recovery DM не удерживает polling и доставку reminders.
Нет второго poller или scheduler. Startup переводит running в failed вместе с
привязанным AIRun; инструменты не повторяются. Recovery DM «Не выполнено, повтори.»
claim-ится до сети; при ошибке сохраняется общая Notification без содержимого.

Одна owner AIConversation сохраняется между ходами. `/new` начинает новую;
уже поставленные сообщения закреплены за прежней беседой. Prompt содержит максимум
20 последних реплик и server time/timezone. reply_to_message — UntrustedData.
Личные read/write tools доступны только через общий registry и Policy Engine;
write scope определяется источником хода, а не формулировкой: текст и голос владельца
могут писать в задачи, заметки, календарь и напоминания, ход с цитатой только читает,
ход с файлом не имеет инструментов. Запись в память только по явной просьбе. Task update/complete требуют версию;
конфликт сохраняет более свежую правку. Удаления нет. Ответы режутся по 4096,
parse_mode отсутствует. Секретарь не использует эту беседу или личный registry.

## Ephemeral personal media — Stage 4

Только личный чат проверенного владельца: voice/audio до 20 MiB, photo до
10 MiB, PDF до 20 MiB, UTF-8 text до 20 000 символов (80 000 bytes transfer cap).
Пересланное и чужое медиа молча игнорируется. Очередь хранит только шифрованные
file_id/ограниченные метаданные и подпись; getFile/download происходят в worker.
Известный размер и возможность выбранной модели проверяются до скачивания;
реальный stream ограничен независимо от Content-Length. Redirect/path traversal
запрещены, file URL с bot token не попадает в ошибки или HTTP diagnostics.
Байты существуют в памяти и не сохраняются в БД, файлы или логи.

Голос распознаётся отдельным BYOK provider kind `transcription`, настроенным в
AI & models: model ID и ключ OpenAI-compatible transcription protocol через
разрешённый HTTPS endpoint `api.openai.com`. Ключ не выбирается для chat/secretary.
Без него — «Распознавание голоса не настроено». В историю попадает транскрипт,
не аудио; он считается просьбой владельца и может разрешить создание задачи.
До запроса сохраняется AIRun с настраиваемой per-request budget estimate
(default 0.10 USD), учитываемой в monthly limit даже после сбоя. Это оценка,
не подтверждение фактического счёта провайдера; значения Decimal, не float.

Photo/PDF расширяют ChatMessage ephemeral media и capabilities images/documents.
Claude/OpenRouter получают inline base64, ModelRouter проверяет возможности.
Файл/фото/PDF ход вообще не получает инструментов, включая запись; подпись не
меняет это правило. Текст файла — UntrustedData, в историю не сохраняется;
остаётся общая отметка и ответ модели. Следующий отдельный текст владельца
может разрешить создание задачи. Business media не добавлено.

## Explicit personal memory — Stage 5

`/remember <факт>` сохраняет явный факт, `/forget <ID или точный текст>` забывает,
`/memory` показывает активные факты. Дубликаты нормализуются; источник и message
ID назначает сервер. Настройки → Memory дают просмотр/поиск, правку и забывание
с проверкой версии. Текст шифрован в основной БД, export/rotation обновлены.

Свободные «запомни/remember» и «забудь/forget» разрешают только соответствующий
memory tool в текущем owner text/voice ходе. Содержимое файлов и цитат, старые
факты и история прав не дают. В prompt не больше 10 лексически подходящих
активных фактов, помеченных UntrustedData. Forget/expiry/edit также исключают
производные реплики из будущего model context по ID/версии; проверка повторяется
перед каждым шагом модели. Сами старые реплики остаются видны владельцу в истории.
Секретарь вообще не читает эту память и не получает её личные инструменты.
Фонового извлечения, rolling summary, MCP, RAG и embeddings нет.

## Task matrix and work time — Stage 6

TasksView получает Matrix на тех же задачах и действиях: important priority >=2;
urgent — due_at <= now+48 часов, включая просроченное. Срок сравнивается как
момент, не как локальные календарные дни. Вид обновляет срочность раз в минуту;
поиск, фильтры, CAS и read-only cache режим сохранены. Новая таблица не создаётся.

Task started_at/completed_at принадлежат серверу и выставляются общим writer
на переходах статуса. Повтор того же состояния не меняет момент; reopen очищает
текущий completed_at, история прошлых завершений остаётся в HistoryEntry.
Историческим задачам неизвестное время не выдумывается при bootstrap. Вечерняя
сводка добавляет in_progress дольше 7*24 часов; /today не меняется. Итоговая
приёмка — в PERSONAL_OS_BOT_REPORT.md.

Stage 7: /today and personal calendar read tools now see the owner's locally
imported Google Calendar occurrences, including moved/cancelled instances. Google
consent, sync and disconnect live in Settings → Google Calendar; import is readonly
and runs in the existing connector iteration every 15 minutes independently of
Telegram enablement. No Google calendar context is added to the Business secretary.
Real Telegram /today with an actual Google account remains an owner live check.

## Manual chat composition — 2026-11-01

Owner-approved Phase 3 follow-up: Messages now sends independently typed text as
new chat messages. A prior secretary reply does not prevent further owner text.
The secretary draft Send/Edit path retains its one-answer/CAS protection. The
composer stays visible and editable in a selected chat; the real Send button is
disabled when empty, pending, offline, paused/unbound, without permissions or
outside the server's 24-hour window. Enter/Cmd+Enter follow the same checks.
An inline reason explains unavailable sending; polling and an exact expiry timer
update the state. Per-chat drafts and text typed during I/O are preserved. Unknown
manual delivery keeps text and disables repeating the same pending message until
the owner checks Telegram and changes their composition. No live messages are
sent by validation.

Manual messages use a separate content-free durable receipt and the existing
encrypted Business message table (migration 0035); each intentional message gets
its own key, retries preserve the key, and every claim is committed before I/O.
Sending/unknown manual activity suppresses secretary replies. An owner echo
already ingested during transport is adopted by its remote message identity.
A restart marks abandoned claims unknown, never replays them. Arbitrary new chat
initiation and bypassing Telegram's can_reply/24-hour rules remain unsupported.

## Optional quotes and photo/audio viewing — 2026-11-01

Owner-approved follow-up: ordinary text, including secretary drafts, is sent
without a forced Telegram reply. Messages has a Reply action per available
message, a visible selected target with Cancel reply and a quote block on sent/
received replies. The target stays within the current Business chat and remains
part of idempotency. Composer/window/rights/unknown-delivery controls still apply.

Photo, voice and audio updates now create owner-visible media cards. View photo /
Load voice message / Load audio fetches only after the owner asks; native image
and audio controls use transient browser blobs, with no autoplay. Captions are
shown as text; a media-only card is not labelled as an empty text message. The
backend stores only encrypted Telegram metadata, downloads within 10/20 MiB caps,
validates content type and serves private no-store bytes. Raw bytes never enter
DB, disk, logs, sync, exports, AI history or attachments. Deletion/TTL/disconnect
remove metadata; key rotation re-encrypts it. Previously ignored customer media
now also counts as a new incoming message and suppresses a stale text auto-reply.
Media generation is explicitly preview-only: no model analysis, transcription,
new Business media send path or AI permissions are introduced. Forwarded media,
video and other unsupported types remain outside this viewing slice.

## Opt-in task suggestions — Task 2, 2026-11-14

In the bound owner's private bot chat, `/task_suggestions` shows known Business
chats and the selected chat, plus remaining extraction attempts today.
`/task_suggestions on <chat_id>` enables one known chat from this instant;
`/task_suggestions off` disables extraction and invalidates pending proposals.
Existing `/task` and Business `/ask`/`/search` keep their existing behavior.
Auto-reply can remain disabled: suggestions never reply to the contact.

Only newly received plain inbound text in this chat is eligible. Forwarded,
media, bot and owner messages are excluded. An independent message state stores
queued/generating/ready/sending/sent or a terminal outcome; updates preserve the
message version and updated_at, so draft CAS and recovery remain independent.
No TelegramBusinessCommand rows or new queue service are used.

Extraction uses the configured BYOK provider, shared budget/timeout and untrusted
text boundary, without tools, web search, private memory or other chats. A
strict CreateTaskToolArgs JSON object (or null) proposes at most one task;
project assignment is unavailable. Dates use the source message instant and
owner timezone; unclear deadlines stay empty. The run audit records durable
attempt/usage metadata, with a hidden conversation and no chat-message copy.
An integration row lock serializes the limit of 20 attempts per UTC day;
failed/interrupted calls count. Exhausted messages become skipped_limit and are
not queued for tomorrow. Existing monthly provider budget also applies.

A proposal is committed before its private inline card is sent. The owner can
create or reject it there through the same action service as Web approvals.
Callbacks verify the bound owner, private chat, bot identity and action
provenance; callback data contains an operation and opaque action ID only.
Repeated approval returns the existing task ID. Rejected, missing, stale and
expired cards return a terminal explanation; they never execute a task again.
The action/task/sync result commits before Telegram confirmation or keyboard
removal. Expiration is 24 hours, shortened by the source's seven-day retention;
a connector sweep expires pending proposals even without a button click.

Source edit/delete/revoke, loss of read permission, clearing, bot replacement, disconnect, pause and off
invalidate pending actions atomically with the source change. Approval locks
only its action row. Changes of source edited_at or opt-in/token/model settings
while the model runs prevent a preview. Draft-only changes do not invalidate it.
Pending invalidated payloads are erased; already approved owner tasks remain.

A durable ready card can resume sending after a restart. Sending is claimed and
committed before I/O; interrupted or ambiguous delivery becomes unknown and is
never retried automatically. Interrupted generation becomes failed, without
another model call. A card arriving after off is harmless: its pending action
has already been invalidated. No production migration, live Telegram messages
or opt-in settings are changed by automated validation. Live owner acceptance
in one expressly selected chat remains separate from local deterministic tests.
