# agent-orch

AI エージェントによるマルチリポジトリ開発を自動化するオーケストレーションシステム。Claude CLI を PTY 経由で制御し、設計ドキュメントからコード実装・レビュー・PR 作成までを一貫して行う。

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────┐
│  Web UI (React + xterm.js)                      │
│  - Item 管理 / Plan 編集 / Agent Terminal       │
│  - Approval Queue / リアルタイムイベント表示      │
└──────────────┬──────────────────────────────────┘
               │ REST API + WebSocket
┌──────────────▼──────────────────────────────────┐
│  Server (Fastify + TypeScript)                  │
│                                                 │
│  Routes ─► Services ─► PTY Manager              │
│                          │                      │
│                    Claude CLI (node-pty)         │
│                          │                      │
│                    Approval Engine               │
│                    (コマンド分類 + 自動判定)       │
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
                                                 │ needs_fixes?  │
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

## 前提条件

- **Node.js** >= 18
- **Claude CLI** (`claude`) がインストール済みで PATH に存在すること
- **GitHub CLI** (`gh`) が認証済みであること（PR 作成機能に必要）
- **Git** >= 2.x

## セットアップ

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動 (サーバー :3001 + Web :5173)
npm run dev
```

## プロジェクト構成

```
agent-orch/
├── packages/shared/       # 共有型定義 (AgentInfo, ItemConfig, Plan, Events, API types)
├── app/server/            # バックエンド (Fastify)
│   └── src/
│       ├── index.ts       # エントリーポイント
│       ├── routes/        # REST API エンドポイント
│       │   ├── items.ts       # Item CRUD
│       │   ├── agents.ts      # Agent 制御 (planner/worker 起動)
│       │   ├── approval.ts    # Approval 判定
│       │   ├── repositories.ts# 保存済みリポジトリ管理
│       │   └── ws.ts          # WebSocket (リアルタイムイベント)
│       ├── services/      # ビジネスロジック
│       │   ├── item-service.ts      # Item 作成・ワークスペースセットアップ
│       │   ├── agent-service.ts     # Agent 生成・PTY イベント処理
│       │   ├── planner-service.ts   # Planner Agent オーケストレーション
│       │   ├── worker-service.ts    # Worker Agent オーケストレーション
│       │   ├── git-pr-service.ts    # Draft PR 作成 (gh CLI)
│       │   ├── git-snapshot-service.ts # 定期的 git status 追跡
│       │   ├── review-receive-service.ts # PR レビューコメント処理
│       │   ├── state-service.ts     # イベントからの状態導出
│       │   └── event-bus.ts         # インメモリ Pub/Sub
│       └── lib/           # ユーティリティ
│           ├── pty-manager.ts       # PTY/ターミナル管理
│           ├── approval-engine.ts   # コマンド分類・承認ロジック
│           ├── events.ts            # イベントファクトリ関数
│           ├── paths.ts             # ディレクトリ構造ヘルパー
│           ├── jsonl.ts             # JSONL 永続化
│           └── yaml.ts             # YAML 読み書き
├── app/web/               # フロントエンド (React + Vite + Tailwind)
│   └── src/
│       ├── api/client.ts          # REST API クライアント
│       ├── pages/                 # ItemListPage, ItemDetailPage
│       ├── components/            # AgentCard, AgentTerminal, ApprovalQueue, etc.
│       └── hooks/                 # useItems, useWebSocket, useRepositories
└── package.json           # ワークスペースルート
```

## 主要な概念

### Item

開発タスクの単位。複数リポジトリをまとめて1つの Item として管理する。

### Agent

Claude CLI プロセスを PTY 経由で実行するエンティティ。役割ごとに分かれる:

| 役割 | 説明 |
|------|------|
| `planner` | 設計ドキュメントからタスク計画を生成 |
| カスタム dev ロール (例: `front`, `back`) | Plan のタスクに基づいてコードを実装 |
| `review` | Worker の変更をレビューしフィードバック |
| `review-receiver` | PR レビューコメントを受けて修正を実施 |

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
    agent: "back"
    repository: "backend"
    dependencies: []
    files: ["src/routes/api.ts"]
```

### Agent ID フォーマット

構造的セパレータとして `--` (ダブルハイフン) を使用:

- リポジトリあり: `agent-{role}--{repoName}--{nanoid(6)}`
- リポジトリなし: `agent-{role}--{nanoid(6)}`

### Approval Engine

Agent が実行するコマンドを3段階に分類:

- **Blocklist**: 自動拒否 (`rm -rf /`, fork bomb 等)
- **Approval Required**: ユーザー承認待ち (`git push`, `docker`, `curl` 等)
- **Auto-approve**: 自動承認 (`ls`, `cat`, `git status` 等)

### イベントログ

全状態変更は JSONL (append-only) で記録される。Item のステータスはイベント履歴から導出される。

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
npm run build

# サーバーのみ型チェック
npx tsc --noEmit -p app/server/tsconfig.json

# テスト
npm test
```

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 18, Vite, Tailwind CSS, xterm.js |
| バックエンド | Fastify, TypeScript, node-pty |
| CLI 連携 | Claude CLI, GitHub CLI (`gh`) |
| データ永続化 | YAML (設定), JSONL (イベント), ファイルシステム |
| モノレポ | npm workspaces |
