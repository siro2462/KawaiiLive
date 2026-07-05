---
name: ingest-transcript
description: VTuber配信の文字起こしを台本md化し、style/topic/flowの蒸留カードに変換してベクトルDBへ投入する。新しいターゲット台本を追加する時に使う。
---

# ingest-transcript — 文字起こし→台本md→蒸留カード→ベクトルDB

## 前提知識

- ターゲット台本の置き場: `assets/vtuber台本/{名前}.md`（gitignore済み。**絶対にコミットしない**）
- 蒸留カードの置き場: `data/cards/{type}_{speaker}.jsonl`
- embed: `scripts/build-vector-db.mjs`（data/vector-source/*.jsonl を読む。要Ollama + nomic-embed-text）
- 詳細仕様とプロンプト原文: docs/ロードマップ.html「データ整備手順」

## 手順

1. **入力確認**: 文字起こしテキスト（YouTube字幕 / Whisper出力）を受け取る。speaker名（ローマ字）を決める（既存: okayu, pekora, fubuki, anju, eru, towa, inui, shiina, ayame, lamy, takkuu）

2. **md整形**: 話題の切れ目でトピック分割し、以下の形式で `assets/vtuber台本/{名前}.md` に保存:
   ```
   # トピックタイトル（15字以内）
   ## この話題の構成説明（どう入り、どう展開し、どう抜けるか1文）
   本文行…（発話をほぼそのまま。要約しない。フィラー・言い直し・脱線・笑いは残す）
   ```
   - 消すもの: 誤変換・文字化け・繰り返しアーティファクト（「スタースタースター」等）・歌詞・BGM区間の幻覚
   - **消してはいけないもの**（雑談感の本体）: フィラー、言い直し、脱線、笑い、コメント読み、言いさし

3. **蒸留**: 各トピックからカードを生成（プロンプト原文はロードマップの「データ整備手順」にある。style/topic/flowの3種）:
   - **style**: 1トピックから3〜8枚。text は固有名詞を一般化（フレア→友達、REPO→いつものゲーム）した20〜60字の話し言葉。move はその文がやっている動き
   - **topic**: 1トピック1枚。topic/title/handling/steps(3〜6)/entry/exit。内輪ネタは役割語に置換して構造だけ残す
   - **flow**: 配信1本で1枚。title(「◯◯型」)/summary/sections[]（order/name/role/flow/tags、4〜8個）
   - **search_text は単語間の半角スペースのみで連結**（文字間スペース挿入は既知バグ。禁止）
   - id 規則: `style_{speaker}_{連番3桁}` / `topic_{speaker}_{連番4桁}` / `flow_{speaker}_{連番3桁}`（既存と衝突しない開始番号を確認）

4. **保存**: `data/cards/{type}_{speaker}.jsonl` に保存。B4（cards読み一本化）未実施の間は `data/vector-source/{type}.jsonl` にも追記する（build-vector-db.mjs が読むのはこちら）

5. **embed**: Ollama 起動確認後 `node scripts/build-vector-db.mjs`。件数が増えたことを確認:
   ```
   node -e "const{DatabaseSync}=require('node:sqlite');for(const n of['style','topic','flow']){const db=new DatabaseSync('data/vector-db/'+n+'.sqlite',{readOnly:true});console.log(n, db.prepare('select count(*) c from vectors').get().c);db.close()}"
   ```

6. **報告**: 追加した speaker / トピック数 / カード枚数（style/topic/flow）/ DB件数の前後

## 選定基準（どの配信を取り込むか）

構成の型が違う配信を優先する（同じ型を増やしても flow の多様性が出ない）。既存12本は雑談・怪談中心なので、歌枠後トーク・記念配信・コラボ振り返り・作業配信などの型が価値が高い。
