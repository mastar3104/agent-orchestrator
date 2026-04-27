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
│    │   ├── test-plan.yaml # テスト観点の計画      │
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
                                              (Plan Feedback / YAML 編集)
                                                         │
                                              Test Planner → test-plan.yaml 生成
                                                         │
                                       ユーザーがテスト観点を確認・編集・承認
                                    (Test Plan Feedback / Approve Test Plan)
                                                         │
                                                    Worker 起動
                                                         │
                                   次の actionable task を 1 件選択
                          (repository をまたいで依存関係順に直列実行)
                                                         │
                                         Engineer → hooks → Reviewer
                                      (必要なら同じ task を review-fix)
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
                                      verificationPolicy を評価
                              (`bdd_required` のときだけ Completed Review)
                                                         │
                                                   Draft PR 作成
                                                   (gh CLI 経由)
                                                         │
                                              Review Receive (任意)
                                              PR レビューコメント反映
                                                         │
                                  必要に応じて plan.yaml / test-plan.yaml を再生成
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

| ロール             | AllowedTools                                                                                                | レスポンススキーマ                   |
|-----------------|-------------------------------------------------------------------------------------------------------------|-----------------------------|
| Planner         | `Read`, `Write`                                                                                             | `{status, summary}`         |
| Test Planner    | `Read`, `Write`                                                                                             | `{status, summary}`         |
| Engineer (dev)  | `Read`, `Write`, `Edit`, `Bash(git add:*)`, `Bash(git rm:*)`, `Bash(git commit -m:*)`, `Bash(git status:*)` | `{status}`                  |
| Reviewer        | `Read`, `Glob`, `Grep`                                                                                      | `{review_status, comments}` |
| Review-Receiver | `Read`, `Write`                                                                                             | `{status, summary}`         |
| Completed Reviewer | `Read`, `Glob`, `Grep`                                                                                   | `{review_status, summary, findings}` |

### 非同期実行

Planner / Test Planner / Worker / Completed Review の起動は HTTP `202 Accepted` で即時返答し、バックグラウンドで実行される。Item レベルの排他ロック (`withItemLock`) で重複実行を防止する。進捗は WebSocket + JSONL イベントで通知される。

## 前提条件

- **Node.js** >= 22.17.1
- **Claude CLI** (`claude`) がインストール済みで PATH に存在すること
- **GitHub CLI** (`gh`) が認証済みであること（PR 作成機能に必要）
- **Git** >= 2.x

## セットアップ

```bash
# 依存関係のインストール
pnpm install --frozen-lockfile

# 開発サーバー起動 (サーバー :3001 + Web :5173)
pnpm dev
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
│       │   ├── agents.ts      # Agent 制御 (planner/test-planner/worker/completed-review 起動, test-plan API)
│       │   ├── role-tools.ts  # role-tools.local.yaml 読み書き
│       │   ├── repositories.ts# 保存済みリポジトリ管理
│       │   └── ws.ts          # WebSocket (リアルタイムイベント)
│       ├── services/      # ビジネスロジック
│       │   ├── item-service.ts      # Item 作成・ワークスペースセットアップ
│       │   ├── agent-service.ts     # executeAgent() — Claude -p 実行 + イベント記録
│       │   ├── planner-service.ts   # Planner Agent オーケストレーション
│       │   ├── test-planner-service.ts # Test Planner / test-plan approval 管理
│       │   ├── worker-service.ts    # Worker Agent オーケストレーション (3 フェーズ)
│       │   ├── completed-review-service.ts # approved test-plan に対する完了レビュー
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
| `test-planner` | 現在の `plan.yaml` から振る舞いベースの `test-plan.yaml` を生成 | Read, Write のみ |
| `engineer` | Plan の task を 1 件ずつ実装 | Read, Write, Edit, git add, git commit -m, git status |
| `review` | Worker の変更をレビュー | Read, Glob, Grep のみ (読み取り専用) |
| `review-receiver` | PR レビューコメントを受けて修正計画を作成 | Read, Write のみ (Bash アクセスなし) |
| `completed-reviewer` | 承認済み `test-plan.yaml` に対する実装充足度を確認 | Read, Glob, Grep のみ (読み取り専用) |

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

`ready` は、現在の `plan.yaml` に対応する `test-plan.yaml` が存在し、承認状態が `approved` になっていることを意味する。

### Plan

`plan.yaml` 形式の実行計画。Planner が自動生成し、ユーザーが編集可能。

```yaml
version: "1.0"
itemId: "ITEM-xxxxx"
summary: "実装計画の概要"
verificationPolicy: "bdd_required"
verificationRationale: "複数 repository を跨ぐ変更で、BDD ベースの受入確認が必要"
tasks:
  - id: "task-1"
    title: "API エンドポイント作成"
    description: "..."
    repository: "backend"
    dependencies: []
    files: ["src/routes/api.ts"]
```

`plan.yaml` は implementation task のみを表し、review task は含めない。

- `verificationPolicy` は plan 全体の受入保証レベルを表す
- 値は `none` / `regression_only` / `bdd_required`
- `verificationRationale` には、そのレベルが必要な理由を記録する

### Test Plan / TestApprove

`test-plan.yaml` は、現在の `plan.yaml` に対する振る舞いベースの検証観点を表す。`TestPlanner` はコードを変更せず、このファイルだけを生成・更新する。

```yaml
version: "1.0"
itemId: "ITEM-xxxxx"
planFingerprint: "<current plan fingerprint>"
summary: "テスト計画の概要"
verificationPolicy: "bdd_required"
verificationRationale: "環境依存の挙動を含むため BDD での受入確認が必要"
scenarios:
  - id: "scenario-1"
    kind: "bdd"
    title: "ユーザーが設定を保存できる"
    repositories: ["frontend", "backend"]
    given: "ユーザーが設定画面を開いている"
    when: "必須項目を入力して保存する"
    then: "設定が永続化され、再表示時にも内容が保持される"
```

- 各 scenario は `kind: bdd` または `kind: regression` のどちらかを使う
- `repositories` には、その scenario に関係する repository 名を 1 つ以上入れる
- `TestPlanner` は plan の `verificationPolicy` を引き継ぐか、より強いレベルへ昇格できるが、弱めることはできない
- `verificationPolicy: none` の test plan は `scenarios: []` 必須で、自動承認される
- `verificationPolicy: regression_only` の test plan は `kind: regression` のみを含み、手動承認が必要
- `verificationPolicy: bdd_required` の test plan は少なくとも 1 件の `kind: bdd` を含み、手動承認が必要
- Planner 完了後、Plan Feedback 後、手動 `plan.yaml` 更新後、Review Receive による plan 再生成後に、現在の plan と同期する `test-plan.yaml` が再生成される
- `POST /items/:id/test-planner/start` でも手動再生成できる
- `POST /items/:id/test-plan/approve` が `Approve Test Plan` に相当し、現在の `plan.yaml` と `test-plan.yaml` の組み合わせに対して承認イベントを記録する
- 承認状態は `missing` / `pending` / `stale` / `approved`
- `plan.yaml` が更新されると既存の `test-plan.yaml` は `stale` になり、再生成または編集後に再承認が必要
- `plan.yaml` に task が 1 件もない場合は、空の `scenarios` を持つ `test-plan.yaml` を生成し、自動承認 (`approvedBy: auto`) する

### Worker 実行

Worker の起動時、以下の流れで処理される:

`POST /items/:id/workers/start` は、現在の test plan approval が `approved` の場合にのみ実行できる。`missing` / `pending` / `stale` のときは開始できない。

リポジトリごとの worker を常駐させて並列実行するのではなく、オーケストレーターが毎回 1 つの actionable task を選び、repository をまたぎながら順番に処理する。

1. **Task Execution** — `plan.yaml` の task を依存関係を見ながら 1 件ずつ直列実行。Engineer が task を実装しコミット
2. **Task Review Loop** — 各 task の直後に hooks と reviewer を実行し、`approve` されるまで同じ task を修正し続ける。hooks は通常の engineer 後も review-fix 後も走り、失敗して retry を使い切っても task failure にはせず `hooks exhausted` warning として reviewer へ進む。`request_changes` は最大 3 回まで feedback fix を試し、最後の review-fix が終わった時点で再度 reviewer は起動せず、その直後に hooks を 1 回だけ流して task を完了させる。そこで hooks が失敗しても `review exhausted` / `hooks exhausted` warning 付きの completed として次へ進む
3. **Completed Review / Skip** — 全 task 完了後、resolved `verificationPolicy` が `bdd_required` の場合のみ Completed Review を実行する。`none` / `regression_only` の場合は `completed_review_skipped` を記録して publish へ進む
4. **Push & PR** — publish 条件を満たしたら `gh` CLI で Draft PR を作成

### Git 差分管理

レビュー時の差分は task 開始時点の HEAD を基準にする:

- **`phaseBase`** (`git rev-parse HEAD` at task start) — Engineer / hooks-fix / review-fix を含む、その task の変更のみ

### Review-Receiver セキュリティ

PR コメントは外部ユーザーからの入力であるため、Review-Receiver は Bash アクセスを持たない。オーケストレーターが `gh api` で PR コメントを取得し、プロンプトにコンテキストとして注入する。

### ロール設定のカスタマイズ

`app/server/config/roles.yaml` がロール定義の正本で、各 role の `promptTemplate` / `allowedTools` / `schemaRef` を保持する。

- サーバ起動時と `getRole()` 初回呼び出し時に `roles.yaml` が読み込まれる
- Web UI の **Settings > Roles** 画面で編集できるのは、`config/role-tools.local.yaml` に保存される追加 `allowedTools` のみ
- `role-tools.local.yaml` の内容は `roles.yaml` の `allowedTools` に加算マージされる
- repository 単位の追加 prompt は repositories 設定の `rolePrompts` で管理される
- `.gitignore` に登録されるローカル設定ファイルは `role-tools.local.yaml`

```
config/
├── roles.yaml               # ロール定義の正本 (git 管理)
└── role-tools.local.yaml    # allowedTools のローカル加算設定 (git 管理外)
```

### Plan Feedback

Planner が生成した `plan.yaml` に対して、タスク単位でフィードバックを送信し Planner に再生成させる機能。

- **エンドポイント**: `POST /items/:id/plan/feedback`（202 Accepted、非同期実行）
- **リクエスト**: `{ feedbacks: [{ taskId: "task-1", feedback: "修正内容" }, ...] }`
- **処理フロー**:
  1. 現在の `plan.yaml` を `plan_<timestamp>_<random>.yaml` にアーカイブ
  2. フィードバック内容を含むプロンプトで Planner Agent を再実行
  3. 生成された `plan.yaml` をバリデーション後、`plan_created` イベントを発行
  4. 同期のため Test Planner も再実行し、`test-plan.yaml` を現行 plan に合わせて更新する
- **UI**: Plan エディタ内にフィードバックフォームが表示される。タスクを選択しフィードバックを入力して送信
- フィードバックに含まれないタスクは保持するよう Planner に指示される
- `plan_created` イベント受信時、エディタが未編集なら自動リロード、編集中ならリロード確認バナーを表示

### Test Plan Feedback / TestApprove

生成済みの `test-plan.yaml` に対して、scenario 単位のフィードバックと承認を行える。

- **再生成**: `POST /items/:id/test-plan/feedback`（202 Accepted、非同期実行）
- **リクエスト**: `{ feedbacks: [{ scenarioId: "scenario-1", feedback: "修正内容" }, ...] }`
- **バリデーション**: `scenarioId` の重複は禁止。現在の `test-plan.yaml` に存在しない scenario は指定できない
- **挙動**: フィードバック対象以外の scenario は保持しつつ `test-plan.yaml` を再生成する。再生成後の承認状態は `pending` に戻る
- **手動編集**: `PUT /items/:id/test-plan` で YAML を直接更新できる。保存後は承認を取り直す
- **承認**: `POST /items/:id/test-plan/approve` で現在の `planFingerprint` と `testPlanFingerprint` の組に対して承認を記録する
- **前提条件**: `stale` 状態の test plan は承認できない
- **Completed Review**: resolved policy が `bdd_required` のときだけ必須。`none` / `regression_only` では skip 扱いで publish できる

### Repository Setup Commands

保存済み remote repository ごとに、clone 完了後に 1 回だけ実行するセットアップコマンドを設定できる。

- **設定箇所**: 保存済みリポジトリ設定の `setup` フィールド（文字列配列）
- **対象**: remote repository のみ。local repository では設定不可
- **実行タイミング**: `git clone` と work branch 作成の完了後、Planner 起動の前
- **実行順**: `clone` → `work branch checkout` → `setup` → `planner`
- **実行場所**: clone された repository 直下
- **失敗時**: 最初の失敗コマンドで打ち切るが、Planner は継続して起動する
- **retry**: `POST /items/:id/clone` で clone/setup を再実行すると、item.yaml にスナップショットされた `setup` が再度使われる
- **イベント**: `repo_setup_started` / `repo_setup_completed`

```yaml
# data/repositories.yaml の例
- id: REPO-12345678
  name: backend
  type: remote
  url: https://github.com/example/backend.git
  setup:
    - "pnpm install --frozen-lockfile"
    - "pnpm prisma generate"
```

既存の saved repository / item 設定に `yarn` ベースの setup や hook が残っていないか確認するには、以下を実行する。

```bash
pnpm audit:setup-commands
```

### Hooks (リポジトリ別コマンド実行)

リポジトリごとに、Engineer の実装完了後に自動実行するシェルコマンド（lint, test, build など）を設定できる。

- **設定箇所**: リポジトリ設定の `hooks` フィールド（文字列配列）
- **実行タイミング**: Engineer Agent がコミット完了後、Review Phase の前
- **setup との違い**: `setup` は clone 後に 1 回、`hooks` は各 task の Engineer 完了後に毎回実行される
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

保存済みリポジトリ (`data/repositories.yaml`) には `setup` / `hooks` / `hooksMaxAttempts` を設定でき、Item 作成時に引き継がれる。

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
| `test_plan_created` / `test_plan_approved` | test-plan.yaml の生成・承認 |
| `repo_setup_started` / `repo_setup_completed` | clone 後 setup 実行 |
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
pnpm build

# サーバーのみ型チェック
pnpm exec tsc --noEmit -p app/server/tsconfig.json

# テスト
pnpm test
```

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React 18, Vite, Tailwind CSS |
| バックエンド | Fastify, TypeScript |
| CLI 連携 | Claude CLI (`claude -p`), GitHub CLI (`gh`) |
| データ永続化 | YAML (設定), JSONL (イベント), ファイルシステム |
| モノレポ | pnpm workspaces |
