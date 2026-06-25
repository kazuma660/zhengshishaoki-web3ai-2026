# デプロイ手順（本番環境への上げ方）

TaskLog v5 を Vercel 本番（https://task-mvp-v5.vercel.app）へ反映する手順。

## 0. 大前提：コピーが2つある

| 場所 | 役割 |
|---|---|
| `/Users/kazuma/web3/task-mvp-v5/` | **開発・デプロイ元**（Vercel に `.vercel` でリンク済み・git管理外） |
| `zhengshishaoki-web3ai-2026/task-mvp-v5/`（branch `v5-dev`） | **git の保管コピー**。本番に出したら忘れず同期してコミット |

→ 編集とデプロイは前者で行い、確定したら後者へ同期して `v5-dev` に push する。

## 1. デプロイ（Vercel CLI）

```bash
cd /Users/kazuma/web3/task-mvp-v5

# プレビュー（本番に影響しない・URLはデプロイ毎に変わる）
npx vercel deploy --yes

# 本番（task-mvp-v5.vercel.app に alias される）
npx vercel deploy --prod --yes
```

- ログイン状態：`npx vercel whoami`（`kazuma660`）。プロジェクトは `.vercel/project.json` でリンク済み。
- ビルド前ローカル確認：`npm run build`（TypeScript チェック込み）。

## 2. 前提条件（これが揃ってないとログインが失敗する）

Firebase コンソール（プロジェクト `tasklog-a0837`）：

1. **Authentication → ログイン方法**：`Google` と `メール/パスワード` が「有効」
   - 未有効だと該当ログインが `auth/operation-not-allowed` で失敗
2. **Authentication → 設定 → 承認済みドメイン**：ログインを通したいドメインを登録
   - 本番 `task-mvp-v5.vercel.app` は登録済み（だから本番はそのまま動く）
   - **プレビューURL（ハッシュ付き）は未登録**なので、プレビューでログインしたい時は都度ドメイン追加が必要
3. **Vercel 環境変数**：`NEXT_PUBLIC_FIREBASE_*` 6個
   - `Production` と `Preview` の両スコープに設定済み（`npx vercel env ls` で確認）
   - 値は `.env.local` と同じ（`NEXT_PUBLIC_*` なのでクライアントに露出する公開値）

## 3. ロールバック（本番がおかしい時）

データは Firestore なので、コードを戻してもデータは消えない。

```bash
# 直前の正常なデプロイに戻す（URLはダッシュボード or `npx vercel ls` で確認）
npx vercel rollback <deployment-url>
```

または Vercel ダッシュボード → Deployments → 戻したいものを「Promote to Production」。

## 4. デプロイ後に git へ残す

```bash
# 1) 本番コードを git 保管コピーへ同期（gitignore対象は除外）
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .vercel \
  --exclude '.env*' --exclude .git --exclude .DS_Store --exclude '*.tsbuildinfo' \
  /Users/kazuma/web3/task-mvp-v5/ \
  /Users/kazuma/web3/zhengshishaoki-web3ai-2026/task-mvp-v5/

# 2) コミット＆プッシュ（main は提出物なので触らない。v5 は v5-dev）
cd /Users/kazuma/web3/zhengshishaoki-web3ai-2026
git checkout v5-dev
git add task-mvp-v5
git commit -m "deploy: <内容>"
git push origin v5-dev
```
