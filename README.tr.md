<p align="center">
  <a href="https://altimate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Altimate Code logo">
    </picture>
  </a>
</p>
<p align="center">Açık kaynaklı yapay zeka kodlama asistanı.</p>
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

### Kurulum

```bash
# YOLO
curl -fsSL https://altimate.ai/install | bash

# Paket yöneticileri
npm install -g @altimateai/altimate-code@latest        # veya bun/pnpm/yarn
scoop install altimate-code             # Windows
choco install altimate-code             # Windows
brew install AltimateAI/tap/altimate-code # macOS ve Linux (önerilir, her zaman güncel)
brew install altimate-code              # macOS ve Linux (resmi brew formülü, daha az güncellenir)
sudo pacman -S altimate-code            # Arch Linux (Stable)
paru -S altimate-code-bin               # Arch Linux (Latest from AUR)
mise use -g altimate-code               # Tüm işletim sistemleri
nix run nixpkgs#altimate-code           # veya en güncel geliştirme dalı için github:AltimateAI/altimate-code
```

> [!TIP]
> Kurulumdan önce 0.1.x'ten eski sürümleri kaldırın.

### Masaüstü Uygulaması (BETA)

Altimate Code ayrıca masaüstü uygulaması olarak da mevcuttur. Doğrudan [sürüm sayfasından](https://github.com/AltimateAI/altimate-code/releases) veya [altimate.ai/download](https://altimate.ai/download) adresinden indirebilirsiniz.

| Platform              | İndirme                               |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `altimate-code-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `altimate-code-desktop-darwin-x64.dmg`     |
| Windows               | `altimate-code-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` veya AppImage          |

```bash
# macOS (Homebrew)
brew install --cask altimate-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/altimate-code-desktop
```

#### Kurulum Dizini (Installation Directory)

Kurulum betiği (install script), kurulum yolu (installation path) için aşağıdaki öncelik sırasını takip eder:

1. `$ALTIMATE_CODE_INSTALL_DIR` - Özel kurulum dizini
2. `$XDG_BIN_DIR` - XDG Base Directory Specification uyumlu yol
3. `$HOME/bin` - Standart kullanıcı binary dizini (varsa veya oluşturulabiliyorsa)
4. `$HOME/.altimate-code/bin` - Varsayılan yedek konum

```bash
# Örnekler
ALTIMATE_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://altimate.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://altimate.ai/install | bash
```

### Ajanlar

Altimate Code, `Tab` tuşuyla aralarında geçiş yapabileceğiniz iki yerleşik (built-in) ajan içerir.

- **build** - Varsayılan, geliştirme çalışmaları için tam erişimli ajan
- **plan** - Analiz ve kod keşfi için salt okunur ajan
  - Varsayılan olarak dosya düzenlemelerini reddeder
  - Bash komutlarını çalıştırmadan önce izin ister
  - Tanımadığınız kod tabanlarını keşfetmek veya değişiklikleri planlamak için ideal

Ayrıca, karmaşık aramalar ve çok adımlı görevler için bir **genel** alt ajan bulunmaktadır.
Bu dahili olarak kullanılır ve mesajlarda `@general` ile çağrılabilir.

[Ajanlar](https://altimate.ai/docs/agents) hakkında daha fazla bilgi edinin.

### Dokümantasyon

Altimate Code'u nasıl yapılandıracağınız hakkında daha fazla bilgi için [**dokümantasyonumuza göz atın**](https://altimate.ai/docs).

### Katkıda Bulunma

Altimate Code'a katkıda bulunmak istiyorsanız, lütfen bir pull request göndermeden önce [katkıda bulunma dokümanlarımızı](./CONTRIBUTING.md) okuyun.

### Altimate Code Üzerine Geliştirme

Altimate Code ile ilgili bir proje üzerinde çalışıyorsanız ve projenizin adının bir parçası olarak "altimate-code" kullanıyorsanız (örneğin, "altimate-code-dashboard" veya "altimate-code-mobile"), lütfen README dosyanıza projenin Altimate Code ekibi tarafından geliştirilmediğini ve bizimle hiçbir şekilde bağlantılı olmadığını belirten bir not ekleyin.

### SSS

#### Bu Claude Code'dan nasıl farklı?

Yetenekler açısından Claude Code'a çok benzer. İşte temel farklar:

- %100 açık kaynak
- Herhangi bir sağlayıcıya bağlı değil. [Altimate Code Zen](https://altimate.ai/zen) üzerinden sunduğumuz modelleri önermekle birlikte; Altimate Code, Claude, OpenAI, Google veya hatta yerel modellerle kullanılabilir. Modeller geliştikçe aralarındaki farklar kapanacak ve fiyatlar düşecek, bu nedenle sağlayıcıdan bağımsız olmak önemlidir.
- Kurulum gerektirmeyen hazır LSP desteği
- TUI odaklı yaklaşım. Altimate Code, neovim kullanıcıları ve [terminal.shop](https://terminal.shop)'un geliştiricileri tarafından geliştirilmektedir; terminalde olabileceklerin sınırlarını zorlayacağız.
- İstemci/sunucu (client/server) mimarisi. Bu, örneğin Altimate Code'un bilgisayarınızda çalışması ve siz onu bir mobil uygulamadan uzaktan yönetmenizi sağlar. TUI arayüzü olası istemcilerden sadece biridir.

---

**Topluluğumuza katılın**  | [X.com](https://x.com/Altimateinc)
