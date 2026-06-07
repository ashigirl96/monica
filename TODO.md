# Monica Frontend Rebuild TODO

## レイアウト基盤 ✅

- [x] ディレクトリ構成（app / spaces / components / commands / hooks / stores / lib）
- [x] SpaceNav（アイコン列、Space切り替え）
- [x] Sidebar / Header の Space 依存レンダリング
- [x] Content パネル（角丸）
- [x] Cmd+1 で LeftPanel 開閉
- [x] traffic light 不可侵領域
- [x] MCP Bridge プラグイン導入（dev時スクリーンショット）

## レイアウト磨き込み ✅

- [x] LeftPanel 開閉アニメーション（width transition, 200ms ease-out）
- [x] Content パネルの視覚調整（多層 shadow + ring border、--content-bg CSS変数）
- [x] vibrancy とのバランス調整（sidebar 透過 vs content 不透明パネル）
- [x] SpaceNav アイコンの hover / active 状態改善（strokeWidth 変化、bg-white/0.12）
- [x] サイドバーリサイズ（ドラッグで幅変更、jotai で管理、ダブルクリックでリセット）
- [x] traffic light 不可侵領域を定数化（TRAFFIC_LIGHT_ZONE_HEIGHT / WIDTH）
- [x] LeftPanel幅に応じたヘッダー左パディング自動計算

## タブシステム ✅

- [x] `stores/tabs.ts` — Space ごとのタブ状態管理（tabs + activeTabId + counter per SpaceId）
- [x] Header 内のタブ UI（TabBar、アクティブタブは --content-bg、非アクティブは bg-white/0.06）
- [x] Space 切り替え時のタブ状態復元（tabsBySpaceAtom で自動保持）
- [x] タブ追加（Ctrl+T → C / +ボタン）、閉じる（Cmd+W / Ctrl+D / ×ボタン）
- [x] タブ移動（Alt+H 左 / Alt+L 右）
- [x] ショートカット集約（hooks/use-shortcuts.ts、prefix key 方式）

## 各 Space の実装

- [ ] Dashboard — メイン画面（タスク概要？フィード？）
- [ ] Project — サイドバーにプロジェクト一覧、メインにイシュー/タスク
- [ ] Work Board — カンバン的なボード UI
- [ ] Work Bench — エージェント実行・開発作業用

## コマンド層（commands/）

- [ ] 既存 Tauri コマンドの型安全ラッパー（list_tasks, list_task_summaries, list_events, delete_task, github_auth_status）
- [ ] コマンド呼び出しのエラーハンドリング共通化

## 共有コンポーネント（components/）

- [ ] shadcn 再導入（必要なものだけ）
- [ ] ボタン / 入力 / モーダル等の基本 UI

## その他

- [x] キーボードショートカット体系（Cmd+1, Ctrl+T→C, Cmd+W, Ctrl+D, Alt+H/L）
- [ ] ダークモード / ライトモード切り替え（現状はダーク固定）
- [ ] 状態永続化（jotai + localStorage or Tauri store）
