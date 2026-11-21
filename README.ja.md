# Antigravity Suite

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

> **Google Antigravity デスクトップ版（macOS）向けの 100% ゼロ改変（Zero-Patch）拡張＆リモート操作スイート。`app.asar` や Apple 公式署名を一切変更せず、公式アップデートにも干渉しません。**

## 主な機能

1. **🇨🇳 中国語／英語の即時切替（ゼロトークン思考翻訳）**：ローカル翻訳キャッシュにより思考プロセスとタイトルをトークン消費なしで翻訳。**`⚙️`** 設定パネルから再起動不要で英語 UI へ即切替可能。
2. **📱 4ルート対応モバイル／PC リモート操作（Cloudflare トンネル標準対応・セッション分離）**：LAN / Tailscale / Bonjour / ログイン不要の Cloudflare 一時トンネル（既定有効・独自固定ドメイン対応）に対応。最速ルート自動切替、マルチプロジェクト切替と**全量履歴のロスレス上スクロール読み込み（長文途切れ防止・`gzip` 圧縮・Subagent 状態集約）**、`$HOME` 安全境界内でのリモート新規プロジェクト作成、上部ドロワー・9項目表示切替・タブ別セッション分離・IME 保護付き `Cmd/Ctrl + Enter` 送信に対応。
3. **📊 コンテキスト＆デュアルウィンドウ配額モニター（240K 自動圧縮・328K 警告対応）**：右上のリングでコンテキスト消費量・52週ヒートマップ・API 換算コストを可視化し、`G4` / `C` カプセルで 5時間＆週間残量を監視。さらにアイドル時 240K 到達またはキャッシュ脱落検知で `/compact` を自動実行し長時間フリーズを防止。
4. **⚡ 入力欄効率化スイート（`挿入` vs `⚡即時送信`）**：
   - 14種の内蔵おすすめコマンドプール（ホバー2行解説・スラッシュ選択でネイティブピル変換）に加え、カスタム欄の**10種人気定型テンプレートワンクリック追加**に対応。**`挿入`** は入力欄に下書きを入れエラー貼り付けや追記後に送信（`エラー修正`・`要件どおりに実装` 等が既定）、**`⚡即時送信`**（末尾 `↵`）はワンクリックで即送信（`すぐ実装`・`中国語で回答`・`続けて`・`説明不要` 等が既定）。いずれも既存下書き上書き防止ガード＆**`⌘/Ctrl + クリック`** 一時反転、`v2.32.x–2.34.0` および非 Homebrew Node（`nvm`/`fnm`/`volta`/`asdf`/`mise`）・`SingletonSocket` 自動起動に対応。
   - 送信横の **`✨ 最適化` / `↩ 元に戻す`**、AI 応答文脈（英語返答時の中国語切替提案等）に応じた **`Tab / →`** 次ステップ短縮提案、**`⌘1`〜`⌘9`** 会話切替、右側 **`⌘S`** 直接編集、**`>_ CLI`** 起動。
5. **🛡️ 高リスクコマンド赤枠ブロック**：`rm -rf`、`git reset --hard`、`sudo` などの危険コマンド実行時は自動承認オンでも赤枠で強制停止し手動確認を要求。
6. **🔄 更新自動検知 ＆ ワンクリックホットアップデート**：GitHub の新着コミットを検知すると右上の **`⚙️`** に赤バッジが点灯し、「立即更新」で再起動なしに即時反映。

---

## 🚀 クイック導入（macOS・ゼロ改変 CDP 方式）

動作要件：**macOS**、**Google Antigravity**、**Node.js `22.4.0+`**

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> オプション：`--no-auto`（自動起動を無効化、`ag-context-meter install-launcher` で独立起動アイコン作成可）、`--no-remote`（リモートサーバーを無効化）。Windows / Linux 環境ではデバッグポート有効化の上 `node cli.js live` で利用できます。

### 主なコマンド

- `ag-context-meter status`：各モジュール状態と公式署名未改変を確認
- `ag-context-meter remote`：4ルート QR コード・接続デバイス確認（`--tunnel on|off` / `--reset-token`）
- `ag-context-meter live` / `restart`：実行中ウィンドウへ即時適用、または `v2.33.0+` デバッグポート付きで安全再起動
- `ag-context-meter update` / `stop` / `auto-off`：ワンクリック更新・一時解除・自動起動無効化

テスト実行は `npm run test:suite`。詳細な設定ガイド・トラブルシューティング・謝辞は **[简体中文 README](README.md)** および **[English README](README.en.md)** をご覧ください。[MIT License](LICENSE) 下で公開されています。
