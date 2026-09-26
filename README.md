> [!IMPORTANT]
> Репозиторий перенесён в GitLab и больше не поддерживается на GitHub.
>
> Актуальная версия: https://gitlab.com/BADtochka/minishop-helper

# minishop-helper

Сервис, который получает Telegram updates через polling в локальной разработке или webhook в production и превращает сообщения в структурированные Issues в GitHub или GitLab.

```text
Telegram reply + @bot
        -> polling (development) / webhook (production)
        -> SQLite queue
        -> Codex App Server
        -> preview в Telegram
        -> подтверждение администратора -> GitHub/GitLab Issue
```

Сервис работает с одной Codex subscription session на один deployment. GitHub Actions, GitHub Models, `repository_dispatch` и OpenAI API key не используются.

## Возможности

- Telegram polling для локальной разработки и защищённый webhook для deployment.
- Обработка только ответов администраторов с упоминанием бота.
- Поддержка GitHub App и GitLab OAuth 2.0 + PKCE.
- Выбор GitHub repository или GitLab project и ветки через setup wizard.
- Несколько Telegram chats с разными repository bindings.
- SQLite job queue с deduplication, retry policy и обязательным preview-подтверждением.
- Cached project context: компактный профиль продукта, терминов и компонентов используется только как advisory context.
- Поддержка Telegram forum topics: preview, ответы и итог остаются в исходной теме.
- Codex structured output с Zod validation.
- Preview дублирует исходные изображения и изображения уточнений; GitLab загружает их через `POST /projects/:id/uploads` и добавляет возвращённый markdown в Issue description, без base64. До 10 JPEG/PNG/WebP файлов по 10 MiB; GitHub пока создаёт Issue без вложений.
- Автоматическая классификация: bug, feature request, improvement, documentation, task.
- Persistent `/data` для SQLite и Codex authentication state.

## Быстрый старт

### Локальный запуск

Требуется:

- [Bun](https://bun.sh) 1.2 или новее.
- Telegram bot token от BotFather.
- Codex CLI с App Server и активной ChatGPT/Codex subscription.
- GitHub App или GitLab OAuth application для создания Issues.

Установка:

```bash
git clone <repository-url>
cd minishop-helper
bun install --frozen-lockfile
bun run setup
bun run start
```

Wizard создаст `.env`, сгенерирует нужные секреты и позволит пропустить необязательные provider stages. Для `NODE_ENV`, provider и других вариантов используйте стрелки вверх/вниз и Enter. Development по умолчанию использует polling без `PUBLIC_URL`; webhook требует URL, а production дополнительно требует HTTPS. Существующие значения не заменяются без подтверждения.

### Docker

Сначала создайте `.env` локальным wizard:

```bash
bun install --frozen-lockfile
bun run setup
docker compose up -d --build
```

Compose монтирует named volume `bot-data` в `/data`. В нём находятся:

```text
/data/bot.sqlite
/data/codex/
/data/codex-workspace/
```

Образ устанавливает pinned-версию Codex CLI из официального npm-пакета `@openai/codex`. Версию можно изменить при сборке:

```bash
docker compose build --build-arg CODEX_VERSION=0.149.1
```

Образ не содержит `.env`, credentials или Codex state. Проверьте наличие Codex до подключения через меню бота:

```bash
docker compose exec bot codex --version
```

## Установка по этапам

### 1. Создайте Telegram bot

1. Откройте [@BotFather](https://t.me/BotFather).
2. Выполните `/newbot` и сохраните полученный token.
3. Узнайте numeric Telegram ID владельца deployment.
4. Запустите `bun run setup`.
5. Заполните `OWNER_TELEGRAM_ID` и `TELEGRAM_TOKEN`.

Username не используется как identity. Setup-команды разрешены только numeric `OWNER_TELEGRAM_ID`.

### 2. Настройте public URL и webhook

Для production нужен публичный HTTPS URL, например:

```env
PUBLIC_URL=https://bot.example.com
```

После запуска Telegram webhook устанавливается по адресу:

```text
https://bot.example.com/telegram/webhook
```

Секрет webhook создаётся wizard автоматически:

```env
TELEGRAM_WEBHOOK_SECRET=<generated-secret>
```

Сервис проверяет header `X-Telegram-Bot-Api-Secret-Token`. Не публикуйте HTTP-порт напрямую без TLS termination через reverse proxy или cloud load balancer.

Для локальной разработки выберите в wizard режим `polling` или задайте:

```env
TELEGRAM_MODE=polling
```

Polling не требует `PUBLIC_URL`, webhook secret, HTTPS или tunnel. Перед стартом сервис удаляет старый Telegram webhook и получает updates через `getUpdates`. Накопленные updates по умолчанию сохраняются; задайте `TELEGRAM_DROP_PENDING_UPDATES=true` только если их нужно намеренно удалить. В режиме polling endpoint `/telegram/webhook` отвечает `409`.

Для production выберите `webhook`:

```env
TELEGRAM_MODE=webhook
```

В этом режиме требуется публичный HTTPS `PUBLIC_URL` и `TELEGRAM_WEBHOOK_SECRET`. Webhook регистрируется после запуска HTTP listener. Production polling запрещён конфигурацией, поскольку встроенный grammY polling рассчитан на один локальный instance.

### 3. Настройте Codex

Установите Codex CLI/App Server в runtime окружение. Путь к binary задаётся через:

```env
CODEX_BIN=codex
CODEX_HOME=/data/codex
```

`CODEX_HOME` должен находиться на persistent volume. В личном чате с ботом откройте `/start`, нажмите «Codex», затем «Подключить Codex».

Для локальной установки, в которой уже выполнен `codex login`, явно укажите существующий каталог состояния CLI, например `CODEX_HOME=/home/you/.codex`. Не задавайте относительный путь: приложение нормализует его при запуске, но абсолютный путь исключает расхождения между shell и runtime.

Бот выдаст одноразовую browser-ссылку. Откройте её на машине, где запущен сервис, и завершите вход в ChatGPT/Codex account. App Server сохраняет session в том же `CODEX_HOME` и отправляет владельцу notification с кнопкой проверки статуса без перезапуска. Для локальной разработки задайте `PUBLIC_URL=http://localhost:1337` (и запустите сервис на этом порту); для production нужен публичный HTTPS URL.

Device-code authentication должна быть разрешена в [ChatGPT Security Settings](https://chatgpt.com/#settings/Security) или администратором workspace. Сам flow открывается на [Codex Device Login](https://auth.openai.com/codex/device). Access token не нужно копировать вручную и нельзя отправлять в Telegram.

Для выхода нажмите «Выйти из Codex» в том же меню.

### 4. Сгенерируйте encryption key

Wizard автоматически создаёт:

```env
APP_ENCRYPTION_KEY=<32-byte-base64-key>
```

Ключ нужен для шифрования GitLab access/refresh tokens в SQLite. Храните его отдельно от backup базы. Потеря или ротация ключа без миграции сделает сохранённые credentials нечитаемыми.

Никогда не коммитьте `.env`, этот ключ или `/data`.

### 5. Подключите GitHub или GitLab

Можно выбрать один provider, оба provider или пропустить настройку и завершить её позже. Для создания Issue в конкретном чате должен быть подключён хотя бы один provider и выбран repository/project.

#### Вариант A: GitHub App

Создайте приложение на странице [GitHub Developer settings → New GitHub App](https://github.com/settings/apps/new). Список уже созданных приложений находится в [GitHub Developer settings → GitHub Apps](https://github.com/settings/apps).

В настройках приложения задайте callback:

```text
https://bot.example.com/auth/github/callback
```

Минимальные Repository permissions:

| Permission | Значение |
|---|---|
| Metadata | Read-only |
| Issues | Read and write |
| Contents | Не требуется для v1; Read-only только при включении repository context |

Остальные настройки GitHub App:

| Настройка | Значение |
|---|---|
| Where can this GitHub App be installed? | `Only on this account` для личного deployment |
| Webhook | Не требуется |
| Subscribe to events | Не требуется |
| User permissions | Не требуются |
| Actions, Administration, Deployments | `No access` |
| Secrets, Workflows | `No access` |

Установите App на нужные repositories через [GitHub App installations](https://github.com/settings/installations). Для App организации установка может потребовать подтверждение organization owner.

Установите App только на нужные repositories. В `.env` укажите:

```env
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem
```

Вместо `GITHUB_APP_PRIVATE_KEY_FILE` можно использовать `GITHUB_APP_PRIVATE_KEY`, но PEM лучше передавать через secret mount. Не используйте PAT и `GITHUB_TOKEN`.

В личном чате владельца откройте `/start` и нажмите «Подключить GitHub». Откройте одноразовую OAuth-ссылку, установите App, затем нажмите кнопку выбора repository в notification.

#### Вариант B: GitLab OAuth

Создайте OAuth application на GitLab instance с callback:

```text
https://bot.example.com/auth/gitlab/callback
```

Для GitLab.com откройте [Preferences → Applications](https://gitlab.com/-/profile/applications). Для self-managed GitLab используйте `https://<ваш-gitlab>/-/profile/applications` или попросите instance administrator создать OAuth application.

Для GitLab.com используйте:

```env
GITLAB_BASE_URL=https://gitlab.com
```

В GitLab OAuth Application добавьте **ровно тот же URL**, который отправляет приложение:

```text
${PUBLIC_URL}/auth/gitlab/callback
```

Если приложение находится за reverse proxy или внешний hostname отличается от `PUBLIC_URL`, задайте точный URL явно:

```env
GITLAB_REDIRECT_URI=https://bot.example.com/auth/gitlab/callback
```

Для локального webhook development это может быть:

```env
GITLAB_REDIRECT_URI=http://localhost:3000/auth/gitlab/callback
```

URL должен совпадать с Redirect URI в GitLab посимвольно: схема, hostname, port, path и завершающий slash. Query string и fragment не допускаются.

Укажите:

```env
GITLAB_OAUTH_CLIENT_ID=...
GITLAB_OAUTH_CLIENT_SECRET=...
```

См. официальную документацию GitLab по [OAuth scopes](https://docs.gitlab.com/integration/oauth_provider/) и [Project members permissions](https://docs.gitlab.com/user/permissions/). Для текущей реализации в OAuth authorization request передаётся ровно:

```text
api
```

`api` означает **полный read/write доступ ко всему GitLab API** в пределах прав авторизованного пользователя: groups, projects, registry, package registry и другие API-разделы. GitLab не предоставляет отдельный OAuth scope `issues:write`, поэтому этот scope шире фактически используемых операций. Более узкий `read_api` недостаточен для `POST /issues`.

Конкретный API-доступ бота:

| Действие | HTTP endpoint | OAuth scope | Минимальная роль в project |
|---|---|---|---|
| Получить текущего пользователя | `GET /user` | `api` | Не относится к project |
| Получить доступные projects | `GET /projects` | `api` | Любая роль, дающая доступ к project |
| Получить project metadata | `GET /projects/:id` | `api` | Любая роль, дающая доступ к project |
| Прочитать labels | `GET /projects/:id/labels` | `api` | Любая роль, дающая доступ к project |
| Найти Issue по request marker | `GET /projects/:id/issues` | `api` | Любая роль, дающая доступ к project |
| Создать Issue | `POST /projects/:id/issues` | `api` | **Reporter** или выше |
| Загрузить image attachment | `POST /projects/:id/uploads` | `api` | **Reporter** или выше |

Роль project задаётся в GitLab отдельно от OAuth application. По документации GitLab роль `Reporter` умеет создавать Issues и читать code, но не может делать push. Для более строгой изоляции можно использовать custom role с минимальным набором planning permissions, если это поддерживается вашим GitLab tier и политиками. OAuth application не может повысить роль пользователя.

GitLab Work Items UI представляет обычные Issues как work items типа Issue. Текущий provider использует стабильный Issues API и Project Upload API: upload возвращает markdown, который включается в description при создании. Отдельный Work Items API не используется, потому что его attachment endpoint не даёт более надёжной project upload-семантики для этого сценария.

Эти операции бот **не выполняет**:

| Возможность | Доступ |
|---|---|
| Читать или менять repository code | Не используется |
| Push, commit, merge request | Не используется |
| Менять project settings, members или protected branches | Не используется |
| Управлять group, runner, CI/CD variables или secrets | Не используется |

Не добавляйте дополнительные scopes. В настройках GitLab укажите callback URL и scope `api`.

Self-managed GitLab должен использовать HTTPS origin без path, query или credentials. Для него нужна отдельная OAuth application на самом instance.

В личном чате владельца откройте `/start`, нажмите кнопку нужного provider и завершите OAuth. После callback бот пришлёт notification с кнопками продолжения. При истечении access token сервис использует refresh token один раз и сохраняет обновлённые credentials в зашифрованном виде.

### 6. Привяжите repository к Telegram chat

В личном чате владельца откройте `/start` и нажмите «Выбрать репозиторий». Затем выберите repository/project, ветку и целевую группу. Ветка хранится в group-wide binding: у разных групп одного repository могут быть разные ветки.

Telegram Bot API не умеет перечислять все группы бота. Бот регистрирует группу только из наблюдаемого update после проверки, что бот и владелец являются администраторами. Если после выбора repository группы нет в списке, добавьте бота в нужную группу, назначьте бота и владельца администраторами и отправьте показанную в личной настройке команду `/link@username_бота`. Команда не добавляется в меню бота; она одноразово связывает выбранный repository с текущей группой, после чего можно нажать «Обновить список групп» в личном чате. Это fallback из-за ограничения Telegram API. Тексты сообщений в registry и логах не сохраняются.

Каждая группа имеет только один активный binding, включая forum-группы: один group/supergroup соответствует одному repository независимо от темы. Forum topics поддерживаются только как место отправки preview, ответов и итогов, а не для выбора разных repositories. Один deployment может обслуживать несколько chats и разных repositories.

### 7. Создайте первый Issue

1. В привязанном chat отправьте идею, bug report или задачу.
2. Администратор ответьте на это сообщение.
3. В ответе упомяните бота, например `@my_bot`.

Будут проверены reply, текст/caption исходного сообщения, mention, права администратора, binding, deduplication и доступность Codex/provider. Бот создаст preview в той же forum topic. Администратор нажимает «Подтвердить», «Отклонить» или «Уточнить»; Issue создаётся только после подтверждения.

## Команда бота

| Команда | Кто может использовать | Назначение |
|---|---|---|
| `/start` | Владелец, private chat | Открыть русское inline-меню; все setup/status действия выполняются кнопками |

## Режимы контекста и локальные репозитории

`CONTEXT_MODE=project_context` используется по умолчанию. Он дешёвый: Codex получает cached `ProjectContext` и локально подобранные компоненты, без clone и checkout. Кнопка «Обновить контекст» обновляет этот профиль независимо от режима.

`CONTEXT_MODE=repository` дополнительно даёт Codex read-only persistent checkout привязанного репозитория. Перед каждым созданием или regeneration preview сервис выполняет fetch и принудительно fast-forward/reset выбранной ветки без merge локальных изменений; untracked файлы также удаляются. После refresh в контекст каждого turn включается ограниченное содержимое текстовых файлов из `docs/` (до 24 файлов и 128 KiB), а Codex получает явную инструкцию использовать checkout и `docs/` как авторитетный контекст. Внешние URL документации не используются. Codex запускается с `approval=never`, read-only sandbox и выключенной сетью.

Checkout хранится в `REPOSITORIES_PATH` (по умолчанию `/data/repositories`) в детерминированном каталоге из внутренних opaque ID connection и repository, а не из пути или имени пользователя. Копии не удаляются после job или при остановке процесса. При следующем job или нажатии «Обновить репозиторий» они обновляются; повреждённая копия изолируется и клонируется заново. Одновременное обновление одной копии сериализуется.

Используется ветка, выбранная для группы (например, `main` или `dev`). Для bindings, созданных до появления выбора ветки, автоматически используется `repository.defaultBranch`; после повторной настройки группы можно выбрать другую ветку. Режим clone требует read-доступа к репозиторию и действующих provider credentials; при ошибке checkout запрос завершается безопасной ошибкой, без перехода в другой режим.

## Переменные окружения

Wizard создаёт `.env` на основе `.env.example`. Основные переменные:

| Переменная | Обязательна | Назначение |
|---|---:|---|
| `OWNER_TELEGRAM_ID` | Да | Numeric ID владельца deployment |
| `TELEGRAM_TOKEN` | Для Telegram | Token от BotFather |
| `TELEGRAM_MODE` | Нет | `polling` для local development или `webhook` для production |
| `TELEGRAM_DROP_PENDING_UPDATES` | Нет | Явно удалить очередь updates при старте polling; default `false` |
| `TELEGRAM_WEBHOOK_SECRET` | Для webhook | Secret header webhook |
| `PUBLIC_URL` | Для webhook | URL listener; в production публичный HTTPS origin |
| `APP_ENCRYPTION_KEY` | Для provider credentials | AES-256-GCM key |
| `DATABASE_PATH` | Нет | По умолчанию `/data/bot.sqlite` |
| `CONTEXT_MODE` | Нет | `project_context` (default) или `repository` |
| `REPOSITORIES_PATH` | Для `repository` | По умолчанию `/data/repositories`; постоянные checkout |
| `REPOSITORY_REFRESH_TIMEOUT_MS` | Нет | Ограничение времени fetch/reset, по умолчанию `30000` |
| `CODEX_HOME` | Нет | По умолчанию `/data/codex` |
| `CODEX_BIN` | Нет | По умолчанию `codex` |
| `GITHUB_APP_SLUG` | Для GitHub | GitHub App slug |
| `GITHUB_APP_ID` | Для GitHub | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY[_FILE]` | Для GitHub | App private key или путь к PEM |
| `GITLAB_BASE_URL` | Для GitLab | HTTPS GitLab origin |
| `GITLAB_OAUTH_CLIENT_ID` | Для GitLab | OAuth client ID |
| `GITLAB_OAUTH_CLIENT_SECRET` | Для GitLab | OAuth client secret |

Полный список находится в `.env.example`. Не задавайте одновременно неполный набор provider credentials: приложение отклонит такую конфигурацию.

## HTTP endpoints

| Endpoint | Назначение |
|---|---|
| `GET /health` | Liveness, только состояние процесса |
| `GET /ready` | Readiness и безопасный статус integrations |
| `POST /telegram/webhook` | Telegram webhook с secret header |
| `GET /setup*` | Удалённый legacy setup API, возвращает `410` |
| `GET /auth/github/start` | Защищённый owner setup flow |
| `GET /auth/github/callback` | GitHub App callback |
| `GET /auth/gitlab/start` | Защищённый owner setup flow |
| `GET /auth/gitlab/callback` | GitLab OAuth callback |

`/auth/*/start` нельзя использовать как публичный login endpoint: flow требует одноразовую owner setup session.

## Эксплуатация

### Проверка состояния

```bash
curl -i https://bot.example.com/health
curl -i https://bot.example.com/ready
docker compose logs -f bot
```

### Данные repository

Docker Compose монтирует именованный volume `bot-data` в `/data`; в нём находятся база, Codex state и persistent checkout. Не удаляйте volume при обычном обновлении контейнера. Для резервной копии остановите сервис или используйте согласованный snapshot volume, затем сохраните весь `/data` в защищённое хранилище. В checkout может находиться исходный код private repositories: ограничьте доступ к Docker host, volume и backup, не публикуйте их и не записывайте provider tokens в URL или логи.

### Читабельные логи

В production сервис пишет JSON Lines, удобный для Docker и log collectors. Команда `bun dev` автоматически включает цветной формат, даже если в `.env` остался `LOG_FORMAT=json`:

```env
LOG_FORMAT=pretty
```

Пример:

```text
12:41:08 INFO  server.started  hostname=0.0.0.0  port=3000
12:41:09 INFO  telegram.update.accepted  request_id=...  provider=github
12:41:10 ERROR job.failed  request_id=...  error_code=CODEX_UNAVAILABLE
```

Уже сохранённый JSONL-файл можно преобразовать отдельной командой:

```bash
docker compose logs --no-color bot > bot.jsonl
bun run logs -- bot.jsonl
```

Или через stdin:

```bash
docker compose logs --no-color bot | bun run logs
```

`LOG_FORMAT=json` рекомендуется для production. `LOG_FORMAT=pretty` предназначен для терминала; секретные поля редактируются в обоих режимах. Для production не используйте `bun dev`.

`/health` должен отвечать `200`, если процесс жив. `/ready` может отвечать `503`, пока не настроены обязательные runtime integrations.

### Backup

Остановите сервис или используйте SQLite-aware backup, затем сохраните:

```text
/data/bot.sqlite
/data/codex/
```

Backup должен быть зашифрован. Отдельно сохраните `APP_ENCRYPTION_KEY` в secret manager. Backup `/data` содержит Codex authentication state и encrypted Git credentials, поэтому ограничьте доступ и retention.

### Обновление

Для локального запуска:

```bash
git pull
bun install --frozen-lockfile
bun run check
bun run start
```

Для Docker:

```bash
docker compose build --pull
docker compose up -d
docker compose logs -f bot
```

Не удаляйте volume `bot-data` при обновлении. В нём находятся база, очередь, credentials и Codex session.

## Безопасность

- Не коммитьте `.env`, `/data`, Codex `auth.json`, private keys и OAuth secrets.
- Не отправляйте access tokens или device codes в групповые chats.
- Telegram text считается untrusted input и не может выбирать provider, repository или output schema.
- Codex запускается с ограниченным environment и read-only policy.
- GitLab credentials шифруются AES-256-GCM.
- GitHub installation tokens короткоживущие и не хранятся как постоянный secret.
- Логи не должны содержать webhook body, OAuth code, authorization headers, tokens или private keys.
- Не используйте `GITHUB_TOKEN`, PAT, GitHub Actions или `repository_dispatch` для создания Issues.

## Диагностика

**Бот не отвечает в polling:** используйте только development, проверьте `TELEGRAM_TOKEN`, отсутствие второго процесса с тем же token и логи `telegram.polling_failed`. `PUBLIC_URL` не нужен.

**Бот не отвечает через webhook:** проверьте публичный `PUBLIC_URL`, HTTPS reverse proxy, `/telegram/webhook`, совпадение `TELEGRAM_WEBHOOK_SECRET` и логи `telegram.activation_failed`.

**`/ready` показывает `503`:** откройте `/start`, подключите Codex и provider кнопками, затем выберите repository, группу и тему.

**Codex не запускается в Docker:** проверьте наличие binary внутри контейнера:

```bash
docker compose exec bot codex --version
```

**GitHub не показывает repositories:** проверьте, что App установлена на нужные repositories и имеет `Metadata: read`, `Issues: write`.

**GitLab OAuth не завершается:** проверьте точное совпадение callback URL, client ID/secret, HTTPS `GITLAB_BASE_URL` и scope `api`.

**После рестарта credentials недоступны:** проверьте, что сохранены `/data` и неизменённый `APP_ENCRYPTION_KEY`.

## Проверка разработки

```bash
bun run check
```

Команда запускает unit/integration tests и TypeScript typecheck. Реальный delivery Telegram, Codex device-code flow, GitHub App installation и GitLab OAuth нужно отдельно проверить на тестовых внешних аккаунтах.
