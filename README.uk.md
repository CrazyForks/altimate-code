<p align="center">
  <a href="https://altimate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Altimate Code logo">
    </picture>
  </a>
</p>
<p align="center">AI-агент для програмування з відкритим кодом.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@altimateai/altimate-code"><img alt="npm" src="https://img.shields.io/npm/v/@altimateai/altimate-code?style=flat-square" /></a>
  <a href="https://github.com/AltimateAI/altimate-code/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/AltimateAI/altimate-code/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a>
</p>

[![Altimate Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://altimate.ai)

---

### Встановлення

```bash
# YOLO
curl -fsSL https://altimate.ai/install | bash

# Менеджери пакетів
npm install -g @altimateai/altimate-code@latest        # або bun/pnpm/yarn
scoop install altimate-code             # Windows
choco install altimate-code             # Windows
brew install AltimateAI/tap/altimate-code # macOS і Linux (рекомендовано, завжди актуально)
brew install altimate-code              # macOS і Linux (офіційна формула Homebrew, оновлюється рідше)
sudo pacman -S altimate-code            # Arch Linux (Stable)
paru -S altimate-code-bin               # Arch Linux (Latest from AUR)
mise use -g altimate-code               # Будь-яка ОС
nix run nixpkgs#altimate-code           # або github:AltimateAI/altimate-code для найновішої dev-гілки
```

> [!TIP]
> Перед встановленням видаліть версії старші за 0.1.x.

### Десктопний застосунок (BETA)

Altimate Code також доступний як десктопний застосунок. Завантажуйте напряму зі [сторінки релізів](https://github.com/AltimateAI/altimate-code/releases) або [altimate.ai/download](https://altimate.ai/download).

| Платформа             | Завантаження                          |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `altimate-code-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `altimate-code-desktop-darwin-x64.dmg`     |
| Windows               | `altimate-code-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` або AppImage           |

```bash
# macOS (Homebrew)
brew install --cask altimate-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/altimate-code-desktop
```

#### Каталог встановлення

Скрипт встановлення дотримується такого порядку пріоритету для шляху встановлення:

1. `$ALTIMATE_CODE_INSTALL_DIR` - Користувацький каталог встановлення
2. `$XDG_BIN_DIR` - Шлях, сумісний зі специфікацією XDG Base Directory
3. `$HOME/bin` - Стандартний каталог користувацьких бінарників (якщо існує або його можна створити)
4. `$HOME/.altimate-code/bin` - Резервний варіант за замовчуванням

```bash
# Приклади
ALTIMATE_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://altimate.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://altimate.ai/install | bash
```

### Агенти

Altimate Code містить два вбудовані агенти, між якими можна перемикатися клавішею `Tab`.

- **build** - Агент за замовчуванням із повним доступом для завдань розробки
- **plan** - Агент лише для читання для аналізу та дослідження коду
  - За замовчуванням забороняє редагування файлів
  - Запитує дозвіл перед запуском bash-команд
  - Ідеально підходить для дослідження незнайомих кодових баз або планування змін

Також доступний допоміжний агент **general** для складного пошуку та багатокрокових завдань.
Він використовується всередині системи й може бути викликаний у повідомленнях через `@general`.

Дізнайтеся більше про [agents](https://altimate.ai/docs/agents).

### Документація

Щоб дізнатися більше про налаштування Altimate Code, [**перейдіть до нашої документації**](https://altimate.ai/docs).

### Внесок

Якщо ви хочете зробити внесок в Altimate Code, будь ласка, прочитайте нашу [документацію для контриб'юторів](./CONTRIBUTING.md) перед надсиланням pull request.

### Проєкти на базі Altimate Code

Якщо ви працюєте над проєктом, пов'язаним з Altimate Code, і використовуєте "altimate-code" у назві, наприклад "altimate-code-dashboard" або "altimate-code-mobile", додайте примітку до свого README.
Уточніть, що цей проєкт не створений командою Altimate Code і жодним чином не афілійований із нами.

### FAQ

#### Чим це відрізняється від Claude Code?

За можливостями це дуже схоже на Claude Code. Ось ключові відмінності:

- 100% open source
- Немає прив'язки до конкретного провайдера. Ми рекомендуємо моделі, які надаємо через [Altimate Code Zen](https://altimate.ai/zen), але Altimate Code також працює з Claude, OpenAI, Google і навіть локальними моделями. З розвитком моделей різниця між ними зменшуватиметься, а ціни падатимуть, тому незалежність від провайдера має значення.
- Підтримка LSP з коробки
- Фокус на TUI. Altimate Code створено користувачами neovim та авторами [terminal.shop](https://terminal.shop); ми й надалі розширюватимемо межі можливого в терміналі.
- Клієнт-серверна архітектура. Наприклад, це дає змогу запускати Altimate Code на вашому комп'ютері й керувати ним віддалено з мобільного застосунку, тобто TUI-фронтенд - лише один із можливих клієнтів.

---

**Приєднуйтеся до нашої спільноти**  | [X.com](https://x.com/Altimateinc)
