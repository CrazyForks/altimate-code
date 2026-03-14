<p align="center">
  <a href="https://altimate.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Altimate Code logo">
    </picture>
  </a>
</p>
<p align="center">オープンソースのAIコーディングエージェント。</p>
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

### インストール

```bash
# YOLO
curl -fsSL https://altimate.ai/install | bash

# パッケージマネージャー
npm install -g @altimateai/altimate-code@latest        # bun/pnpm/yarn でもOK
scoop install altimate-code             # Windows
choco install altimate-code             # Windows
brew install AltimateAI/tap/altimate-code # macOS と Linux（推奨。常に最新）
brew install altimate-code              # macOS と Linux（公式 brew formula。更新頻度は低め）
sudo pacman -S altimate-code            # Arch Linux (Stable)
paru -S altimate-code-bin               # Arch Linux (Latest from AUR)
mise use -g altimate-code               # どのOSでも
nix run nixpkgs#altimate-code           # または github:AltimateAI/altimate-code で最新 dev ブランチ
```

> [!TIP]
> インストール前に 0.1.x より古いバージョンを削除してください。

### デスクトップアプリ (BETA)

Altimate Code はデスクトップアプリとしても利用できます。[releases page](https://github.com/AltimateAI/altimate-code/releases) から直接ダウンロードするか、[altimate.ai/download](https://altimate.ai/download) を利用してください。

| プラットフォーム      | ダウンロード                          |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `altimate-code-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `altimate-code-desktop-darwin-x64.dmg`     |
| Windows               | `altimate-code-desktop-windows-x64.exe`    |
| Linux                 | `.deb`、`.rpm`、または AppImage       |

```bash
# macOS (Homebrew)
brew install --cask altimate-code-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/altimate-code-desktop
```

#### インストールディレクトリ

インストールスクリプトは、インストール先パスを次の優先順位で決定します。

1. `$ALTIMATE_CODE_INSTALL_DIR` - カスタムのインストールディレクトリ
2. `$XDG_BIN_DIR` - XDG Base Directory Specification に準拠したパス
3. `$HOME/bin` - 標準のユーザー用バイナリディレクトリ（存在する場合、または作成できる場合）
4. `$HOME/.altimate-code/bin` - デフォルトのフォールバック

```bash
# 例
ALTIMATE_CODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://altimate.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://altimate.ai/install | bash
```

### Agents

Altimate Code には組み込みの Agent が2つあり、`Tab` キーで切り替えられます。

- **build** - デフォルト。開発向けのフルアクセス Agent
- **plan** - 分析とコード探索向けの読み取り専用 Agent
  - デフォルトでファイル編集を拒否
  - bash コマンド実行前に確認
  - 未知のコードベース探索や変更計画に最適

また、複雑な検索やマルチステップのタスク向けに **general** サブ Agent も含まれています。
内部的に使用されており、メッセージで `@general` と入力して呼び出せます。

[agents](https://altimate.ai/docs/agents) の詳細はこちら。

### ドキュメント

Altimate Code の設定については [**ドキュメント**](https://altimate.ai/docs) を参照してください。

### コントリビュート

Altimate Code に貢献したい場合は、Pull Request を送る前に [contributing docs](./CONTRIBUTING.md) を読んでください。

### Altimate Code の上に構築する

Altimate Code に関連するプロジェクトで、名前に "altimate-code"（例: "altimate-code-dashboard" や "altimate-code-mobile"）を含める場合は、そのプロジェクトが Altimate Code チームによって作られたものではなく、いかなる形でも関係がないことを README に明記してください。

### FAQ

#### Claude Code との違いは？

機能面では Claude Code と非常に似ています。主な違いは次のとおりです。

- 100% オープンソース
- 特定のプロバイダーに依存しません。[Altimate Code Zen](https://altimate.ai/zen) で提供しているモデルを推奨しますが、Altimate Code は Claude、OpenAI、Google、またはローカルモデルでも利用できます。モデルが進化すると差は縮まり価格も下がるため、provider-agnostic であることが重要です。
- そのまま使える LSP サポート
- TUI にフォーカス。Altimate Code は neovim ユーザーと [terminal.shop](https://terminal.shop) の制作者によって作られており、ターミナルで可能なことの限界を押し広げます。
- クライアント/サーバー構成。例えば Altimate Code をあなたのPCで動かし、モバイルアプリからリモート操作できます。TUI フロントエンドは複数あるクライアントの1つにすぎません。

---

**コミュニティに参加**  | [X.com](https://x.com/Altimateinc)
