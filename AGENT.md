# AGENT.md — agent-orch 開発ガイド

このドキュメントは、agent-orch コードベースで作業する AI エージェントおよび開発者向けのガイドです。

## プロジェクト概要

Claude CLI をオーケストレーションし、マルチリポジトリ開発を自動化するシステム。モノレポ構成で、共有型定義・サーバー・Web UI の3パッケージから成る。

## リポジトリ構成

```
packages/shared/    → 型定義 (agent, item, plan, events, api)
app/server/         → Fastify バックエンド
app/web/            → React フロントエンド
```

## ビルド・実行

```bash
npm install                                      # 依存関係インストール
npm run dev                                      # 開発サーバー起動 (server:3001 + web:5173)
npx tsc --noEmit -p app/server/tsconfig.json     # サーバー型チェック
npx tsc --noEmit -p packages/shared/tsconfig.json # shared 型チェック
npm test                                         # テスト実行
```

型定義を変更した場合は `packages/shared` のビルドが先に必要:

```bash
npm run build -w @agent-orch/shared
```

## アーキテクチャの原則

### イベント駆動・append-only

- 全状態変更は `events.jsonl` に append される。状態は常にイベント履歴から導出する (`state-service.ts`)。
- イベントを直接変更・削除してはならない。
- 新しい状態遷移を追加する場合は `lib/events.ts` にファクトリ関数を追加し、`packages/shared/src/types/events.ts` に型を定義する。

### Agent ID フォーマット

`--` (ダブルハイフン) を構造的セパレータとして使用する:

```
agent-{role}--{repoName}--{nanoid(6)}   # リポジトリあり
agent-{role}--{nanoid(6)}               # リポジトリなし
```

`tryExtractRoleFromAgentId()` はこのフォーマットを `--` で分割して role を取得する。レガシーフォーマット (シングルハイフン区切り) のフォールバックも維持している。新しい agent ID を生成する際は必ず `generateAgentId()` を使うこと。

### activeDevAgents Map

`worker-service.ts` の `activeDevAgents` はモジュールレベルの `Map<string, string>` で、Worker Phase 中の dev agent を追跡する。キーは `${itemId}/${repoName}` 形式で、複数 Item 間の衝突を防ぐ。

### PTY 管理

- `lib/pty-manager.ts` が Claude CLI プロセスの生成・入出力・終了を管理する。
- Agent は `--permission-mode acceptEdits` で起動され、ファイル編集は自動承認される。
- Bash/ネットワーク操作は `approval-engine.ts` で分類され、blocklist は自動拒否、approval_required はユーザー承認待ちとなる。

### ファイルベース永続化

- DB は使わない。全データはファイルシステム上に存在する。
- 設定: YAML (`item.yaml`, `plan.yaml`, `repositories.yaml`)
- イベント: JSONL (`events.jsonl`)
- パス構築: `lib/paths.ts` のヘルパー関数を必ず使用すること。

## コード変更時の注意点

### 型定義の変更

`packages/shared/src/types/` 内の型を変更する場合:

1. 型を変更する
2. `packages/shared` をビルドする
3. `app/server` と `app/web` の型チェックが通ることを確認する

共有型は以下のファイルに分かれている:

| ファイル | 内容 |
|---------|------|
| `agent.ts` | `AgentInfo`, `AgentStatus`, `AgentRole`, ロール判定関数 |
| `item.ts` | `ItemConfig`, `ItemStatus`, `ItemSummary`, `ItemDetail`, `ItemRepositoryConfig` |
| `plan.ts` | `Plan`, `PlanTask` |
| `events.ts` | 全イベント型 (20種以上) |
| `api.ts` | REST API リクエスト/レスポンス型 |
| `repository.ts` | `GitRepository` |

### サービス層の変更

サービス間の依存関係:

```
routes/items.ts ──► item-service.ts ──► planner-service.ts
                                   └──► workspace setup (clone/link)

routes/agents.ts ──► agent-service.ts ──► pty-manager.ts
                 ├──► planner-service.ts
                 ├──► worker-service.ts ──► agent-service.ts
                 │                     └──► git-pr-service.ts
                 └──► review-receive-service.ts

routes/ws.ts ──► event-bus.ts (WebSocket ブロードキャスト)
```

- `agent-service.ts`: Agent の生成・停止・イベント処理の中核。他サービスから呼ばれる。
- `worker-service.ts`: Worker のライフサイクル管理。dev → review → PR 作成のフローを制御。
- `planner-service.ts`: Planner Agent の起動と `plan.yaml` の監視。
- `git-pr-service.ts`: `gh` CLI 経由の PR 作成。`createDraftPrsForAllRepos` が唯一の公開エントリーポイント。

### イベントの追加

新しいイベント型を追加する手順:

1. `packages/shared/src/types/events.ts` に型を定義し、union 型に追加
2. `app/server/src/lib/events.ts` にファクトリ関数を追加
3. 必要に応じて `state-service.ts` の状態導出ロジックを更新
4. Web UI でイベントを表示する場合は `ItemDetailPage.tsx` のイベントログ部分を更新

### API エンドポイントの追加

1. `packages/shared/src/types/api.ts` にリクエスト/レスポンス型を定義
2. `app/server/src/routes/` に Fastify ルートを追加
3. `app/web/src/api/client.ts` にクライアント関数を追加

## ワークフローの状態遷移

```
ItemStatus の遷移:
created → cloning → planning → ready → running → completed
                                  │         │
                                  │         └─► waiting_approval → running
                                  │
                                  └─► review_receiving → running → completed

各遷移で error に遷移する可能性がある
```

## テスト

```bash
npm test                    # 全テスト実行
npm run test -w @agent-orch/server   # サーバーのみ
```

## よくあるタスク

### 新しい AgentRole を追加する

1. `packages/shared/src/types/agent.ts` の `AgentRole` 型を更新
2. 必要に応じて `isDevRole()` / `isSystemRole()` を更新
3. `worker-service.ts` の `getRoleDescription()` にロール説明を追加
4. Plan のタスクで新ロールを `agent` フィールドに指定可能にする

### Approval Engine のルール変更

`app/server/src/lib/approval-engine.ts` を編集する。パターンは3カテゴリ:

- `BLOCKLIST_PATTERNS`: 絶対に実行させないコマンド
- `APPROVAL_REQUIRED_PATTERNS`: ユーザー承認が必要なコマンド
- `AUTO_APPROVE_PATTERNS`: 自動承認するコマンド

### データディレクトリの構造

```
data/items/{ITEM-ID}/
├── item.yaml                         # Item 設定
├── events.jsonl                      # Item レベルイベント
├── workspace/
│   ├── plan.yaml                     # 実行計画
│   └── {repoName}/                   # リポジトリ作業ディレクトリ
└── agents/
    └── {agentId}/
        └── events.jsonl              # Agent レベルイベント
```

パスの構築には必ず `lib/paths.ts` の関数を使用すること:

- `getWorkspaceRoot(itemId)` → `data/items/{itemId}/workspace`
- `getRepoWorkspaceDir(itemId, repoName)` → `data/items/{itemId}/workspace/{repoName}`
- `getItemEventsPath(itemId)` → `data/items/{itemId}/events.jsonl`
- `getAgentDir(itemId, agentId)` → `data/items/{itemId}/agents/{agentId}`
- `getAgentEventsPath(itemId, agentId)` → `data/items/{itemId}/agents/{agentId}/events.jsonl`
