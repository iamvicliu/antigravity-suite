# Antigravity Suite

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

> **Google Antigravity デスクトップ版（macOS）向けの 100% ゼロ改変（Zero-Patch）拡張＆リモート操作スイート。`app.asar` や Apple 公式署名を一切変更せず、公式アップデートにも干渉しません。**

## 主な機能

1. **🇨🇳 中国語／英語の即時切替（ゼロトークン思考翻訳）**：ローカル翻訳キャッシュにより思考プロセスとタイトルをトークン消費なしで翻訳。**`⚙️`** 設定パネルから再起動不要で英語 UI へ即切替可能。
2. **📱 超高速モバイル／PC リモート操作（公式より圧倒的に高速）**：
   - 公式クラウド中継を介さず LAN ミリ秒直結（外出時は Tailscale / Bonjour / ログイン不要 Cloudflare 一時トンネルから最速ルートを自動選択）。切替時の旧リクエスト中断・遅延履歴ロード・`gzip` 圧縮を備えた超軽量 PWA で瞬時に起動します。
   - マルチプロジェクト切替、全量履歴ロスレス上スクロール、`$HOME` 安全境界内での新規プロジェクト作成、上部ドロワー、9項目表示切替、タブ別セッション分離、IME 保護付き `Cmd/Ctrl + Enter` 送信に対応。
3. **⚡ 入力欄ショートカット＆プロンプト最適化（`挿入` vs `⚡即時送信`）**：
   - 14種の内蔵おすすめコマンドプール（スラッシュ選択でネイティブピル変換）とカスタム欄の **10種人気定型ワンクリック追加**。
   - **`挿入`** は下書き入力（エラー修正等）、**`⚡即時送信`**（`↵`）は即送信（`すぐ実装`・`中国語で回答` 等既定8種）。既存下書き保護＆**`⌘/Ctrl + クリック`** 反転、**`✨ 最適化` / `↩ 元に戻す`**、**`Tab / →`** 文脈ショート提案を搭載。
4. **🧰 デスクトップ便利ツール**：**`⌘1`〜`⌘9`** 会話即時切替、メッセージナビゲーション、右側 **`✏️ 編集` + `⌘S`** 直接編集、**`>_ CLI`** 端末起動（`v2.32.x–2.34.0` / `SingletonSocket` / 各種 Node 環境マネージャ自動検出対応）。
5. **📊 コンテキスト＆デュアルウィンドウ配額モニター（240K 自動圧縮・328K 警告対応）**：右上のリングで消費量・52週ヒートマップ・API 換算コストを可視化し、`G4` / `C` カプセルで 5時間＆週間残量を監視。アイドル時 240K 到達またはキャッシュ脱落検知で `/compact` を自動実行し長時間フリーズを防止。
6. **🛡️ 高リスクコマンド赤枠ブロック**：`rm -rf`、`git reset --hard`、`sudo` などの危険コマンド実行時は自動承認オンでも赤枠で強制停止し手動確認を要求。
7. **🔄 更新自動検知＆ワンクリックホットアップデート**：GitHub の新着コミットを検知すると右上の **`⚙️`** に赤バッジが点灯し、「立即更新」（今すぐ更新）で再起動なしに即時反映。

---

## 🚀 クイック導入（macOS・ゼロ改変 CDP 方式）

動作要件：**macOS**、**Google Antigravity**、**Node.js `22.4.0+`**

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-suite
cd ~/.local/share/antigravity-suite
./scripts/setup-macos-cdp.sh
```

> オプション：`--no-auto`（自動起動を無効化、`ag-context-meter install-launcher` で独立起動アイコン作成可）、`--no-remote`（リモートサーバーを無効化）。Windows / Linux 環境ではデバッグポート有効化の上 `node cli.js live` で利用できます。

### 主なコマンド

- `ag-context-meter status`：各モジュール状態と公式署名未改変を確認
- `ag-context-meter remote`：4ルート QR コード・接続デバイス確認（`--tunnel on|off` / `--reset-token`）
- `ag-context-meter live` / `restart`：実行中ウィンドウへ即時適用、または `v2.33.0+` デバッグポート付きで安全再起動
- `ag-context-meter update` / `stop` / `auto-off`：ワンクリック更新・一時解除・自動起動無効化

テスト実行は `npm run test:suite`。QR ペアリング・リモート操作・周辺体験の最適化に貢献してくれた共同開発者 [@hubo1989](https://github.com/hubo1989)・[@Shens](https://github.com/Shens) に感謝します。詳細は **[简体中文 README](README.md)** および **[English README](README.en.md)** をご覧ください。[MIT License](LICENSE) 下で公開されています。
