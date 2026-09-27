# Быстрый старт

Копировать ничего не нужно. Пакет — это обычный pi-пакет, и pi ставит его сам.

Репозиторий пакета: [github.com/rkaliev/pi-engineering-kit](https://github.com/rkaliev/pi-engineering-kit). Ниже **`<kit>`** — локальный клон (`git clone https://github.com/rkaliev/pi-engineering-kit`), он нужен только для демо и разработки.

## 0. Установить pi

Pi — это CLI-агент, работает в терминале. Нужен **Node.js 22.19 или новее**: официальные установщики поставят его сами, если его нет. Пакет npm: `@earendil-works/pi-coding-agent`, команда называется `pi`.

| Вариант | Когда подходит |
|---|---|
| [Установщик macOS / Linux](#установщик-macos--linux-рекомендуется) | Обычная установка, рекомендуется |
| [Установщик Windows](#windows) | Нативный Windows |
| [npm / pnpm / yarn / bun глобально](#через-пакетный-менеджер) | Node уже стоит, хочешь сам управлять версией |
| [npx / pnpm dlx / bunx без установки](#без-установки-npx) | Попробовать, CI, разовый запуск |
| [Версия в проекте (devDependency)](#версия-pi-в-проекте) | Вся команда на одной версии pi |
| [Docker](#docker-изолированно) | Недоверенные или автономные задачи |
| [Android (Termux)](#android-termux) | Телефон или планшет |

### Установщик macOS / Linux (рекомендуется)

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

- Проверяет, что есть Node.js ≥ 22.19 и npm. Если их нет, предлагает поставить: через Homebrew, если он есть, иначе как standalone Node.js.
- Повторный запуск на машине, где pi уже стоит, предлагает переустановить или удалить pi.

### Windows

В PowerShell:

```powershell
irm https://pi.dev/install.ps1 | iex
```

- Установщик проверяет Node.js 22.19+ и **Git for Windows**: для shell-команд pi использует Git Bash.
- Второй вариант — поставить pi внутри **WSL** и пользоваться им как в Linux.
- Подробнее, включая `shellPath` и PowerShell как инструмент модели: [Windows setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md). Guard этого пакета для инструмента `powershell` на Windows пока не проверялся.

### Через пакетный менеджер

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # официальный способ
pnpm add -g @earendil-works/pi-coding-agent
yarn global add @earendil-works/pi-coding-agent                   # yarn 1
bun add -g @earendil-works/pi-coding-agent
```

- `--ignore-scripts` — из официальной документации: скрипты установки pi не нужны.
- Официально документированы только npm и установщики. pnpm, yarn и bun ставят тот же npm-пакет.

### Без установки (npx)

```bash
npx -y @earendil-works/pi-coding-agent          # последняя версия
npx -y @earendil-works/pi-coding-agent@0.87.1   # конкретная версия
pnpm dlx @earendil-works/pi-coding-agent        # то же через pnpm
bunx @earendil-works/pi-coding-agent            # то же через bun
```

- Все аргументы передаются как обычно, например `npx -y @earendil-works/pi-coding-agent -e <kit>`.
- Настройки, логин и пакеты хранятся в том же `~/.pi/agent`, что и при глобальной установке.
- Первый запуск скачивает пакет в кэш, поэтому для ежедневной работы удобнее глобальная установка.
- `npx` и `pnpm dlx` проверены с pi 0.87.1, `bunx` — нет: на тестовой машине не было bun.

### Версия pi в проекте

```bash
npm install -D @earendil-works/pi-coding-agent@0.87.1
npx pi
```

Версия фиксируется в `package.json` и lockfile, поэтому у всей команды и в CI одна и та же версия pi. Так устроен и сам этот пакет: на этой версии гоняются его тесты и typecheck.

### Docker (изолированно)

Для задач, где агенту нельзя давать доступ ко всей машине. Официальный рецепт — `Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
WORKDIR /workspace
ENTRYPOINT ["pi"]
```

```bash
docker build -t pi-sandbox -f Dockerfile.pi .
docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD:/workspace" -v pi-agent-home:/root/.pi/agent pi-sandbox
```

- Не монтируй хостовый `~/.pi/agent`: там твои ключи и сессии.
- Другие варианты изоляции (Docker Sandboxes, OpenShell, Gondolin) описаны в [Containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md).

### Android (Termux)

Сначала `pkg install nodejs git`, затем установка через npm, как выше. Подробности: [Termux setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/termux.md).

### Проверить, обновить, удалить

```bash
pi --version          # проверить установку
pi update             # обновить pi
pi update --all       # обновить pi и все установленные pi-пакеты
```

- **Удалить:** запусти установщик ещё раз и выбери удаление, или `npm uninstall -g @earendil-works/pi-coding-agent`.
- **`pi: command not found` после установки через npm:** каталог глобальных бинарников npm не в `PATH`. Посмотри его через `npm prefix -g` и добавь `<prefix>/bin` в `PATH`.

### Подключить модель

Pi работает с подпиской, API-ключом или локальной моделью.

```bash
cd ~/projects/my-app
pi
```

Внутри pi:

```
/login            # выбрать провайдера: подписка (OAuth) или API-ключ
/model            # выбрать модель
```

- Учётные данные сохраняются в `~/.pi/agent/auth.json`.
- Вместо `/login` можно задать ключ переменной окружения, например `export ANTHROPIC_API_KEY=…`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. Полный список — в [Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).
- Доступные модели: `pi --list-models`.
- При первом запуске в папке проекта pi спросит, доверять ли проекту (trust). Без этого он не читает `.pi/` проекта.

#### Claude (Anthropic)

**Через подписку Claude (Pro/Max):**
1. В pi выполнить `/login` и выбрать **«Anthropic (Claude Pro/Max)»**.
2. В браузере откроется `claude.ai`. Войти тем же аккаунтом, что и в Claude Code, и подтвердить доступ.
3. Pi получит ответ через `localhost`. Если браузер на другой машине (SSH, сервер), вставь в pi итоговый redirect URL или код авторизации — pi сам это предложит.
4. Токены сохранятся в `~/.pi/agent/auth.json` и дальше обновляются сами. Выйти: `/logout`.

> **Сначала проверь условия.** Anthropic ограничивает использование учётных данных потребительской подписки в сторонних инструментах, а pi — сторонний агент. Корпоративные аккаунты (Team, Enterprise) подчиняются ещё и политике компании. Перед использованием сверься с актуальными условиями Anthropic и с администратором аккаунта.

**Через API-ключ (надёжный путь для любого стороннего агента):**
1. Создать ключ в Claude Console (`platform.claude.com`). Для корпоративного аккаунта ключ выдаёт администратор.
2. Подключить одним из способов:
   - `/login` → Anthropic → API key;
   - `export ANTHROPIC_API_KEY=sk-ant-...` перед запуском `pi`;
   - хранить ключ в связке ключей macOS и не держать его в файле. Для этого в `~/.pi/agent/auth.json` указать:
     ```json
     { "anthropic": { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" } }
     ```
3. Оплата — по использованию (pay-as-you-go), отдельно от подписки.

В обоих случаях провайдер называется `anthropic`, поэтому `.pi/model-routing.json` (режимы `deep`, `fast`, `cheap`) работает без правок. Точные ID моделей смотри в `pi --list-models`.

### Что ещё

- **`pi-subagents`** (желательно): нужен для ревью в свежем контексте и параллельной разведки. `/kit-init` добавит его в проект сам.
- **Node.js 22.18+ отдельно** нужен только для `npm test` в демо-проекте и для разработки самого пакета.
- Официальная документация pi: [pi.dev](https://pi.dev) и [docs в репозитории](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs).

## 1. Установка: три способа

### Попробовать, ничего не устанавливая

```bash
cd ~/projects/my-app
pi -e <kit>
```

Пакет работает только в этой сессии, в настройках ничего не меняется.

### Поставить себе, из локальной папки

```bash
pi install <kit>      # для всех твоих проектов (~/.pi/agent/settings.json)
```

- Pi подключает папку по ссылке, а не копирует её, поэтому правки в `<kit>` видны после `/reload` или перезапуска.
- Вариант `pi install -l <путь>` тоже есть, но он пишет в `.pi/settings.json` проекта **относительный путь до твоей папки**. У коллег такой путь не сработает, поэтому для команды используй способ ниже.

### Из GitHub (рекомендуется)

Себе, для всех проектов:
```bash
pi install git:github.com/rkaliev/pi-engineering-kit@v0.2.9
```

Для команды — одна строка в проекте:
```bash
cd ~/projects/my-app
pi install -l git:github.com/rkaliev/pi-engineering-kit@v0.2.9
git add .pi/settings.json && git commit -m "chore: enable pi-engineering-kit"
```

Коллеге достаточно склонировать проект, запустить `pi` и подтвердить доверие к проекту (trust). Pi сам поставит пакет нужной версии. **Обновление:** поменяй версию после `@` на новый тег из [релизов](https://github.com/rkaliev/pi-engineering-kit/releases). Сама версия не меняется.

## 2. Настроить проект: `/kit-init`

Внутри pi, в корне проекта:

```
/kit-init
```

Команда показывает, что создаст, спрашивает по каждому файлу и **никогда не перезаписывает существующие**:

| Файл | Что в нём |
|---|---|
| `.pi/verify.json` | Команды проверки: из `## Commands` в AGENTS.md, иначе из скриптов `package.json` (npm/pnpm/yarn/bun по lockfile), иначе `./gradlew check`, `cargo test`, `go test`, `dotnet test`, `pytest` |
| `.pi/guard.json` | Пустые проектные правила guard. Встроенные правила действуют и без них |
| `.pi/model-routing.json` | Режимы `deep`, `fast` и `cheap` и какая команда в каком режиме работает. **ID моделей сверь с `pi --list-models`** |
| `.pi/settings.json` | Добавляет `npm:pi-subagents` в `packages`, остальные ключи не трогает |

- Если в проекте нет `AGENTS.md`, команда предложит запустить `/onboard`: агент изучит репозиторий, прогонит команды и предложит AGENTS.md.
- `/kit-init --yes` создаёт всё недостающее без вопросов. Это удобно для скриптов.

Все файлы `.pi/*` стоит закоммитить: тогда у команды одинаковые проверки, правила и модели.

## 3. Демо на тестовом проекте

В пакете есть мини-проект `examples/demo`: библиотека корзины без зависимостей и одна задача с нумерованными критериями. Скопируй его, чтобы не трогать оригинал:

```bash
cp -r <kit>/examples/demo /tmp/kit-demo
cd /tmp/kit-demo && git init -q && git add -A && git commit -qm init
npm test                    # 2 теста, зелёные
pi install <kit>            # или: pi -e <kit>
pi
```

Дальше команды вводятся внутри pi.

| Шаг | Что ввести | Что увидишь |
|---|---|---|
| 1 | подтвердить trust | Pi загрузит `.pi/` проекта |
| 2 | `/kit-init` | Вопросы по файлам. В `verify.json` попадёт `npm test`: pi взял его из AGENTS.md |
| 3 | `/mode` | Текущая модель, режимы и маршруты. Если модели из `model-routing.json` у тебя нет, поправь ID |
| 4 | `/implement tasks/01-percent-discount.md` | Модель переключится на `fast`. Агент покажет план до 7 строк и пойдёт по TDD: сначала падающий тест на каждый критерий. Задача про деньги, поэтому подключится `payments-and-money`: только целочисленная арифметика и округление half-up. После первой правки в статусе появится `verify: unverified edits` |
| 5 | (агент говорит «готово») | Если проверок после правок не было, verify-гейт вернёт агента: «Verify gate: files changed…». Агент вызовет `run_verification` и выдаст отчёт: файлы, команды с результатами, критерии 1–5, что не проверено |
| 6 | `/review tasks/01-percent-discount.md` | Модель `deep`. Ревью только на чтение: Criteria / Confirmed / Assumptions / Questions / Verdict |
| 7 | `/verify` | Ручной прогон проверок, результат увидит и агент |
| 8 | `/finish` | Варианты merge / PR / keep / discard. Push и merge выполняются только после твоего выбора |

Как проверить guard: создай `.env` с любым значением и попроси агента его прочитать. Чтение через инструмент `read` блокируется, а `cat .env` в shell требует подтверждения. На `git push --force` будет отказ с подсказкой про `--force-with-lease`.

Другие входы в работу:
- `/brainstorm <идея>` — дизайн до кода;
- `/plan <spec>` — план;
- `/debug <симптом>` — поиск корня бага;
- `/new-task <что сделать>` — написать задачу с критериями;
- `/skill:<name>` — принудительно загрузить скилл.

На своём проекте последовательность та же: `/kit-init` → `/onboard` (если нет AGENTS.md) → `/new-task` → `/implement`.

## 4. Частые вопросы

- **Команды из `.pi/` не появились.** Проект не trusted: выполни `/trust` или перезапусти pi и подтверди. Без trust pi не читает `.pi/settings.json`, `.pi/prompts`, `.pi/skills` и `.pi/model-routing.json`. Встроенные правила guard и verify работают и так.
- **У проекта свои промпты с теми же именами** (например, `.pi/prompts/implement.md`). Pi молча берёт одну версию:
  - при установке через `pi install` побеждают промпты проекта (`.pi/prompts/*.md`);
  - при `pi -e` побеждает пакет.
  Чтобы пользоваться нашей версией, переименуй проектный файл или удали его, если он дублирует наш.
- **«no available model for mode …».** В `model-routing.json` указана модель, к которой у тебя нет доступа. Поправь ID или укажи список, например `"model": ["anthropic/…", "openai/…"]`: возьмётся первая доступная.
- **Verify-гейт пишет, что команд нет.** Заполни `.pi/verify.json` или секцию `## Commands` в AGENTS.md.
- **Как посмотреть, что загружено.** `pi list` показывает пакеты, `pi config` включает и выключает отдельные ресурсы пакета.

Как всё устроено и почему: [ARCHITECTURE.ru.md](ARCHITECTURE.ru.md).
