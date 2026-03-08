# agent-orch

AI エージェントによるマルチリポジトリ開発を自動化するオーケストレーションシステム。Claude CLI を `claude -p` (非対話モード) で実行し、設計ドキュメントからコード実装・レビュー・PR 作成までを一貫して行う。

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────┐
│  Web UI (React)                                 │
│  - Item 管理 / Plan 編集                         │
│  - Agent ステータス表示 / リアルタイムイベント      │
└──────────────┬──────────────────────────────────┘
               │ REST API + WebSocket
┌──────────────▼──────────────────────────────────┐
│  Server (Fastify + TypeScript)                  │
│                                                 │
│  Routes ─► Services ─► Claude Executor          │
│                          │                      │
│                    claude -p --output-format json│
│                    --json-schema <schema>        │
│                    --allowedTools <tools>        │
│                          │                      │
│                    ステートレス実行               │
│                    (1ステップ = 1プロセス)         │
└──────────────┬──────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│  File System                                    │
│  data/items/{ITEM-ID}/                          │
│    ├── item.yaml          # Item 設定           │
│    ├── events.jsonl       # イベントログ (append-only)│
│    ├── workspace/                               │
│    │   ├── plan.yaml      # 実行計画            │
│    │   ├── {repoName}/    # リポジトリ作業ディレクトリ│
│    │   └── ...                                  │
│    └── agents/{agentId}/  # エージェント別データ  │
└─────────────────────────────────────────────────┘
```

## ワークフロー

```
Item 作成 → リポジトリ clone/link → Planner Agent → plan.yaml 生成
                                                         │
                                              ユーザーが Plan を確認・編集
                                              (Plan Feedback で再生成も可)
                                                         │
                                                    Worker 起動
                                                         │
                                          ┌──────────────┼──────────────┐
                                          ▼              ▼              ▼
                                     front agent    back agent    infra agent
                                      (並列実行)     (並列実行)     (並列実行)
                                          │              │              │
                                          └──────────────┼──────────────┘
                                                         │
                                                   Review Agent
                                                  (コードレビュー)
                                                         │
                                                 ┌───────┴───────┐
                                                 │ request_changes│
                                                 │  → Worker に   │
                                                 │    フィードバック│
                                                 │  (最大3回)      │
                                                 └───────┬───────┘
                                                         │
                                                   Draft PR 作成
                                                   (gh CLI 経由)
                                                         │
                                              Review Receive (任意)
                                              PR レビューコメント反映
```

## 実行モデル

各エージェントは `claude -p` の単発プロセスとして実行される。長寿命の PTY セッションではなく、ステップごとに新しいプロセスを起動し、JSON レスポンスで結果を受け取る。

```
claude -p \
  --output-format json \
  --json-schema '{"type":"object",...}' \
  --allowedTools Read,Write,Edit,Bash(git status:*) \
  < prompt.txt
```

### ロール別の許可ツールとレスポンス

| ロール | AllowedTools | レスポンススキーマ |
|--------|-------------|-------------------|
| Planner | `Read`, `Write` | `{status, summary}` |
| Engineer (dev) | `Read`, `Write`, `Edit`, `Bash(git status:*)` | `{status, files_modified}` |
| Reviewer | `Read`, `Glob`, `Grep` | `{review_status, comments}` |
| Review-Receiver | `Read`, `Write` | `{status, summary}` |

### 非同期実行

Planner と Worker の起動は HTTP `202 Accepted` で即時返答し、バックグラウンドで実行される。Item レベルの排他ロック (`withItemLock`) で重複実行を防止する。進捗は既存の WebSocket + JSONL イベントで通知される。

## 前提条件

- **Node.js** >= 18
- **Claude CLI** (`claude`) がインストール済みで PATH に存在すること
- **GitHub CLI** (`gh`) が認証済みであること（PR 作成機能に必要）
- **Git** >= 2.x

## セットアップ

```bash
# 依存関係のインストール
yarn install

# 開発サーバー起動 (サーバー :3001 + Web :5173)
yarn dev
```

## プロジェクト構成

```
agent-orch/
├── packages/shared/       # 共有型定義 (AgentInfo, ItemConfig, Plan, Events, API types)
├── app/server/            # バックエンド (Fastify)
│   └── src/
│       ├── index.ts       # エントリーポイント
│       ├── routes/        # REST API エンドポイント
│       │   ├── items.ts       # Item CRUD, Review Receive
│       │   ├── agents.ts      # Agent 制御 (planner/worker/plan-feedback 起動, 202 Accepted)
│       │   ├── settings.ts    # ロール設定 (roles.local.yaml 読み書き)
│       │   ├── repositories.ts# 保存済みリポジトリ管理
│       │   └── ws.ts          # WebSocket (リアルタイムイベント)
│       ├── services/      # ビジネスロジック
│       │   ├── item-service.ts      # Item 作成・ワークスペースセットアップ
│       │   ├── agent-service.ts     # executeAgent() — Claude -p 実行 + イベント記録
│       │   ├── planner-service.ts   # Planner Agent オーケストレーション
│       │   ├── worker-service.ts    # Worker Agent オーケストレーション (3 フェーズ)
│       │   ├── git-pr-service.ts    # Draft PR 作成, PR コメント取得 (gh CLI)
│       │   ├── git-snapshot-service.ts # 定期的 git status 追跡
│       │   ├── review-receive-service.ts # PR レビューコメント処理
│       │   ├── state-service.ts     # イベントからの状態導出
│       │   └── event-bus.ts         # インメモリ Pub/Sub
│       └── lib/           # ユーティリティ
│           ├── claude-executor.ts   # runClaude() / executeWithRetry() — コア実行エンジン
│           ├── claude-schemas.ts    # ロール別 JSON スキーマ・許可ツール定数
│           ├── locks.ts             # Item レベル排他ロック (withItemLock)
│           ├── events.ts            # イベントファクトリ関数
│           ├── paths.ts             # ディレクトリ構造ヘルパー
│           ├── jsonl.ts             # JSONL 永続化
│           └── yaml.ts             # YAML 読み書き
├── app/web/               # フロントエンド (React + Vite + Tailwind)
│   └── src/
│       ├── api/client.ts          # REST API クライアント
│       ├── pages/                 # ItemListPage, ItemDetailPage
│       ├── components/            # AgentCard, ItemList, etc.
│       └── hooks/                 # useItems, useWebSocket, useRepositories
└── package.json           # ワークスペースルート
```

## 主要な概念

### Item

開発タスクの単位。複数リポジトリをまとめて1つの Item として管理する。

### Agent

Claude CLI の `-p` モード (非対話) で実行されるエンティティ。1 ステップ = 1 プロセスのステートレス実行。役割ごとに使用可能なツールが制限される:

| 役割 | 説明 | ツール制限 |
|------|------|-----------|
| `planner` | 設計ドキュメントからタスク計画を生成 | Read, Write のみ |
| `engineer` | Plan の task を 1 件ずつ実装 | Read, Write, Edit, git status のみ (commit は orch が実行) |
| `review` | Worker の変更をレビュー | Read, Glob, Grep のみ (読み取り専用) |
| `review-receiver` | PR レビューコメントを受けて修正計画を作成 | Read, Write のみ (Bash アクセスなし) |

### Agent ステータス

```
idle → starting → running → completed | error | stopped
```

### Item ステータス

```
created → cloning → planning → ready → running → completed | error
                                                     ↓
                                              review_receiving
```

### Plan

`plan.yaml` 形式の実行計画。Planner が自動生成し、ユーザーが編集可能。

```yaml
version: "1.0"
itemId: "ITEM-xxxxx"
summary: "実装計画の概要"
tasks:
  - id: "task-1"
    title: "API エンドポイント作成"
    description: "..."
    repository: "backend"
    dependencies: []
    files: ["src/routes/api.ts"]
```

`plan.yaml` は implementation task のみを表し、review task は含めない。

### Worker 実行

Worker の起動時、以下の流れで処理される:

1. **Task Execution** — `plan.yaml` の task を依存関係を見ながら 1 件ずつ直列実行。Engineer が task を実装しコミット
2. **Task Review Loop** — 各 task の直後に hooks と reviewer を実行し、`approve` されるまで同じ task を修正し続ける
3. **Push & PR** — その repository の task がすべて完了したら `gh` CLI で Draft PR を作成

### Git 差分管理

レビュー時の差分は task 開始時点の HEAD を基準にする:

- **`phaseBase`** (`git rev-parse HEAD` at task start) — Engineer / hooks-fix / review-fix を含む、その task の変更のみ

### Review-Receiver セキュリティ

PR コメントは外部ユーザーからの入力であるため、Review-Receiver は Bash アクセスを持たない。オーケストレーターが `gh api` で PR コメントを取得し、プロンプトにコンテキストとして注入する。

### ロール設定のカスタマイズ (roles.local.yaml)

`app/server/config/roles.yaml` にはデフォルトのロール定義（promptTemplate, allowedTools, schemaRef）が含まれる。このファイルを直接編集する代わりに、**`roles.local.yaml`** でローカルオーバーライドできる。

- `roles.local.yaml` が存在する場合、`roles.yaml` の代わりにそちらが読み込まれる
- Web UI の **Settings > Roles** 画面から編集・保存が可能（`PUT /api/settings/roles`）
- 保存時にバリデーション → アトミック書き込み → ホットリロードが行われ、不正な設定はロールバックされる
- `DELETE /api/settings/roles/local` でローカルオーバーライドを削除しデフォルトに戻せる
- `.gitignore` に `roles.local.yaml` が登録されておりリポジトリにはコミットされない

```
config/
├── roles.yaml          # デフォルト設定 (git 管理)
└── roles.local.yaml    # ローカルオーバーライド (git 管理外)
```

### Plan Feedback

Planner が生成した `plan.yaml` に対して、タスク単位でフィードバックを送信し Planner に再生成させる機能。

- **エンドポイント**: `POST /items/:id/plan/feedback`（202 Accepted、非同期実行）
- **リクエスト**: `{ feedbacks: [{ taskId: "task-1", feedback: "修正内容" }, ...] }`
- **処理フロー**:
  1. 現在の `plan.yaml` を `plan_<timestamp>_<random>.yaml` にアーカイブ
  2. フィードバック内容を含むプロンプトで Planner Agent を再実行
  3. 生成された `plan.yaml` をバリデーション後、`plan_created` イベントを発行
- **UI**: Plan エディタ内にフィードバックフォームが表示される。タスクを選択しフィードバックを入力して送信
- フィードバックに含まれないタスクは保持するよう Planner に指示される
- `plan_created` イベント受信時、エディタが未編集なら自動リロード、編集中ならリロード確認バナーを表示

### Hooks (リポジトリ別コマンド実行)

リポジトリごとに、Engineer の実装完了後に自動実行するシェルコマンド（lint, test, build など）を設定できる。

- **設定箇所**: リポジトリ設定の `hooks` フィールド（文字列配列）
- **実行タイミング**: Engineer Agent がコミット完了後、Review Phase の前
- **試行回数**: `hooksMaxAttempts` で初回を含む総試行回数を指定できる（saved repository YAML からのみ注入、未指定または不正値は `2`）
- **リトライ**: hooks が失敗した場合、失敗出力を Engineer にフィードバックして修正を依頼する
- **全試行失敗時**: その task は `failed` のまま残り、`currentPhase='hooks'` のエラーイベントが記録される。依存関係を満たす独立 task があれば同じ run 内で継続する
- **イベント**: `hooks_executed`（結果、成否、試行回数を含む）

```yaml
# Item 作成時のリポジトリ設定例
repositories:
  - name: backend
    type: local
    localPath: /path/to/repo
    hooks:
      - "npm run lint"
      - "npm test"
    hooksMaxAttempts: 3
```

保存済みリポジトリ (`data/repositories.yaml`) にも `hooks` / `hooksMaxAttempts` を設定でき、Item 作成時に引き継がれる。

### Agent ID フォーマット

構造的セパレータとして `--` (ダブルハイフン) を使用:

- リポジトリあり: `agent-{role}--{repoName}--{nanoid(6)}`
- リポジトリなし: `agent-{role}--{nanoid(6)}`

### イベントログ

全状態変更は JSONL (append-only) で記録される。Item のステータスはイベント履歴から導出される。

主なイベントタイプ:

| イベント | 説明 |
|---------|------|
| `agent_started` / `agent_exited` | エージェントのライフサイクル |
| `claude_execution` | Claude -p 実行結果 (exitCode, durationMs, attempt, success) |
| `plan_created` | plan.yaml 生成完了 |
| `review_findings_extracted` | レビュー結果 (findings, overallAssessment) |
| `hooks_executed` | Hooks 実行結果 (allPassed, attempt) |
| `pr_created` / `repo_no_changes` | PR 作成結果 |
| `status_changed` | ステータス遷移 |
| `error` | エラー発生 |

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `3001` | サーバーポート |
| `HOST` | `0.0.0.0` | サーバーホスト |
| `DATA_DIR` | `./data` | データディレクトリ |
| `LOG_LEVEL` | `info` | ログレベル (pino) |
| `CLAUDE_PATH` | 自動検出 | Claude CLI バイナリパス |

## ビルド

```bash
# 全パッケージビルド (shared → server → web)
yarn build

# サーバーのみ型チェック
npx tsc --noEmit -p app/server/tsconfig.json

# テスト
yarn test
```

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 18, Vite, Tailwind CSS |
| バックエンド | Fastify, TypeScript |
| CLI 連携 | Claude CLI (`claude -p`), GitHub CLI (`gh`) |
| データ永続化 | YAML (設定), JSONL (イベント), ファイルシステム |
| モノレポ | Yarn workspaces |
