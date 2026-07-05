# KawaiiLive — プロジェクトガイド

AI VTuber「ZIPちゃん」の配信システム。台本生成（ローカルLLM）→ TTS（Irodori）→ OBS配信（`?obs`ブラウザソース）まで一気通貫。公開リポ: https://github.com/siro2462/KawaiiLive

## 正典ドキュメント（必ずここから）

- **docs/ロードマップ.html** — 全体計画の正典。**実施順は「依存関係と優先順位（2026-07-02 引き直し）」セクションが正**。各施策の変更モジュール・具体的変更・プロンプトテンプレまで全部ここにある
- docs/台本生成仕様v3.7.md — 生成パイプラインの仕様
- docs/台本生成評価観点.md — 品質評価の観点

## 現在地（2026-07-04時点）

- 配信ランタイム（?obsモード、モーション/口パク同期）は動く。ED画面のみ未実装
- **台本品質の改善は Step 0 が未着手**: A1（topic_hintをプロンプト接続）+ A2（episode_v2使用）+ A3（style蒸留カードfew-shot）+ D-2案1（独り言スタイル）+ D-4案1（分布メトリクス）
- 重要な既知事実: ベクトルDB（flow/topic/style）は実質プロンプトに届いていない。flow=完全未使用、topic_hint=取得済みだがプロンプト未接続、style=生文字起こしが激フィルタで縮退、memory.episode_v2=343件生成済みで未使用。詳細はロードマップの「調査で判明した現状」表

## 作業の作法

- **UI変更後は必ずビルド**: `cd app/ui && npx vite build`（サーバーは dist を直配信。ビルドしないと反映されない）
- **server.js / app配下の.js変更はサーバー再起動が必要**（ダッシュボードのRESTARTボタン or scripts/restart-control-server.js）
- コミットメッセージは日本語。push はユーザーが指示した時だけ
- **公開リポ**: `assets/vtuber台本/`・`data/`配下のコンテンツはコミット禁止（.gitignore済み。過去に履歴からも除去した経緯あり）
- 文字コード注意は AGENTS.md 参照（PowerShellのUTF-8設定）
- LLM: llama-server（Qwen3.6 MoE, LLAMA_SERVER_URL）+ Ollama（embedding: nomic-embed-text）。蒸留・整形などの品質重要バッチは強いモデル（Claude）でやる方針

## スキル（.claude/skills/）

- `/roadmap-next` — ロードマップの次の未着手ステップを特定して実装する
- `/add-memories` — 断片記憶を生成して memory テーブルに追加する
- `/ingest-transcript` — 配信文字起こしを台本md化→蒸留カード→ベクトルDBに投入する

## 主要ファイルマップ

| 場所 | 役割 |
|---|---|
| app/server.js | HTTP API 全部（status/broadcast/script/radio） |
| app/daihon/generate.mjs | 台本生成v3のオーケストレーション |
| app/daihon/prompt.mjs | blockプロンプト構築（A1の変更先） |
| app/daihon/director.mjs / planner.mjs | plan生成・memory候補選定 |
| app/daihon/memory.js | talk-items.sqlite（memory/live/speech_lines） |
| app/daihon/vector.mjs | ベクトル検索（style/topic/flow） |
| app/onair/radio.js / tts.js | 再生キュー / Irodori TTS |
| app/ui/src/components/OnAirView.tsx | ダッシュボード+OBSモード（ClipAvatar含む） |
| data/talk-items.sqlite | memory 455件 / live / speech_lines |
| data/vector-db/*.sqlite | ベクトルDB（style 3599生行 / topic 219 / flow 12） |
| data/vector-source/*.jsonl | 蒸留カード（style 401 / topic 200 / flow 12）← A3で使う |
| scripts/build-vector-db.mjs | vector-source → vector-db 再ビルド（要Ollama） |
