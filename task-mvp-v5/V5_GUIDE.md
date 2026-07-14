# TaskLog v5 ガイド（自分用）

> 「Firebase とか Vercel とか、何やってるか分からんくなった」時に開く。
> 困ったらまずここ → それでもダメなら Claude に聞く。

最終更新：2026-06-22

---

## 0. v5 で何が変わったか（一言で）

- **データの置き場所が変わった**：ブラウザのlocalStorage → Firebase（クラウド）
- **ログインが必要**：Google アカウントで
- **複数端末で同期できるようになった**（同じアカウントでログインすれば PC↔スマホ共有）

それ以外（DnDとか「今日」「明日」とかの機能）は v4.3.5 と同じ。

---

## 1. 用語の整理

| 用語 | これは何？ | TaskLog でどう使う？ |
|---|---|---|
| **Firebase** | Google のクラウドサービス全体の名前 | 親フォルダみたいなもの |
| **Authentication** | ログイン機能の部分 | 「Google でログイン」を実現 |
| **Firestore** | クラウド上のデータベース | タスクデータを置く |
| **Vercel** | Web アプリをホスティングするサービス | アプリ本体を公開（Firebase とは別物） |
| **Next.js** | アプリのフレームワーク | コードを動かす土台 |

イメージ：
```
ユーザーのブラウザ
  ↕ (ログイン)
Firebase Authentication
  ↕ (データ読み書き)
Firestore Database
```

アプリ自体（HTML/JS）は **Vercel** が配信、データだけ **Firebase** に置く。

---

## 2. 物の置き場所

| 何 | どこ |
|---|---|
| **v5 のコード** | `/Users/kazuma/web3/task-mvp-v5/` |
| **Firebase コンソール** | https://console.firebase.google.com/u/0/project/tasklog-a0837 |
| **GitHub repo** | https://github.com/kazuma660/zhengshishaoki-web3ai-2026 |
| **Vercel ダッシュボード** | https://vercel.com/dashboard |
| **v4.3.5（保険として残す）** | https://task-mvp-v4-2.vercel.app |
| **v5 本番（デプロイ後）** | まだ無い（後でURL確定） |

---

## 3. ローカルで動かす

```bash
cd /Users/kazuma/web3/task-mvp-v5
npm run dev -- --port 3203
```

→ ブラウザで `http://localhost:3203` を開く。

止める：ターミナルで `Ctrl+C`。

⚠️ **`.env.local` が無いと動かない**。
中身は Firebase の `apiKey` 等。これは git に上げない（.gitignore 済み）。
他のPCに移す時は手動でコピーが必要。

---

## 4. Firebase コンソールの読み方

https://console.firebase.google.com/u/0/project/tasklog-a0837

### 左メニューの主な場所

| メニュー | 何が見える？ | 何のためにくる？ |
|---|---|---|
| **Authentication > Users** | ログインしたユーザー一覧（メール、最終ログイン、UID） | 誰が使ってるか確認 |
| **Authentication > Sign-in method** | Google ログインのON/OFF | 設定変更時 |
| **Authentication > Settings > 承認済みドメイン** | このドメインからのログインを許可する一覧 | 新URL追加時 |
| **Firestore Database > データ** | 実際のデータ（/users/{uid}/items[] ） | 中身の確認・手動編集 |
| **Firestore Database > ルール** | セキュリティルール | 権限変更時 |
| **使用状況** | 無料枠の消費量 | 課金心配な時 |

### 「Users」を開くと

```
UID                          メール               最終ログイン
ABC123...                    kazuma....@gmail.com  2026-06-22 14:30
```
が並ぶ。**自分のUID** はここで確認できる。

### 「Firestore > データ」を開くと

```
users (コレクション)
  └ ABC123... (ドキュメントID = ユーザーのUID)
      ├ items: [{...}, {...}, ...]
      └ lastSeen: "2026-06-22"
```

ここで自分のタスク全部見れる。手動で編集も可（壊さないように注意）。

---

## 5. デプロイの流れ（Vercel）

> まだやってない。本番URL が決まるまでは localhost で動かす。

### 初回のみ

```bash
cd /Users/kazuma/web3/task-mvp-v5
npm i -g vercel       # 初回だけ
vercel login          # ブラウザでGitHub認証
vercel                # 質問に答えて新規プロジェクト作成
```

### 環境変数を Vercel に設定

`.env.local` の中身を Vercel ダッシュボードの「Settings > Environment Variables」に手動で入れる：
- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

### 本番デプロイ

```bash
vercel --prod
```

### 本番URLを Firebase に登録

デプロイで `https://task-mvp-v5-xxx.vercel.app` が出る → Firebase コンソールの
**Authentication > Settings > 承認済みドメイン** に **追加**。

これしないと本番でログインできない（「unauthorized-domain」エラー）。

---

## 6. 困った時

### 「ログインできない／ポップアップ出ない」
- ブラウザがポップアップブロックしてる可能性 → アドレスバー右側のアイコン確認
- 承認済みドメインに今のURLが入ってるか確認

### 「unauthorized-domain」エラー
- Firebase > Authentication > Settings > 承認済みドメイン
- 今のURLを追加

### 「データが保存されない／同期しない」
- ブラウザのコンソール（F12）でエラー確認
- Firestore のルールが正しいか確認（`/users/{userId}` ルール）
- ネットワーク繋がってるか

### 「無料枠超えそう／使いすぎ警告」
- Firebase > 使用状況 で読み書き数チェック
- 1日 5万reads/2万writes 以上来てたら異常 → コード側にループバグ疑い

### 「ログインしたら別人のデータが見える」
- セキュリティルールがおかしい → `/users/{userId}` で `request.auth.uid == userId` の条件が必須

### 「ローカルが動かない」
- `.env.local` 存在チェック
- `npm install` し直す
- `node_modules/` 消して `npm install`

---

## 7. やっちゃダメな事

- ❌ **`.env.local` を git に上げる**（.gitignore 済みだけど一応注意）
- ❌ **Firebase コンソールで「Blaze プラン」にアップグレード**（押さない限り課金されない）
- ❌ **Firestore のルールを `allow read, write: if true;` にする**（誰でも全データ読める）
- ❌ **`main` ブランチに直接 push**（v4.1 提出版を壊す）
- ❌ **/users/ コレクションを手動で全削除**（自分のデータ消える）

---

## 8. 残タスク（v5 リリースまで）

### ✅ 完了
- Firebase プロジェクト作成 (`tasklog-a0837`)
- Authentication（Google）有効化
- Firestore Database 作成・ルール設定
- firebaseConfig 取得
- task-mvp-v5/ ディレクトリ作成
- Firebase SDK 導入・`.env.local` 設定
- `app/lib/firebase.ts` 作成
- Auth UI 実装（ログイン/ログアウト/未ログイン画面）
- データ層差し替え（localStorage → Firestore）
- マイグレーション処理

### 🔄 いまココ
- **本人による実ブラウザでの動作確認**（http://localhost:3203）
  - Google でログインできる
  - タスク置ける → リロードで残ってる
  - ログアウトできる
  - （任意）別アカウントでデータ分離されてる

### ⏳ 残り
- [ ] **v5-dev ブランチ作成 + push**（コードを GitHub に上げる）
- [ ] **Vercel 新規プロジェクトとしてデプロイ**
- [ ] **環境変数を Vercel に設定**
- [ ] **本番URLを Firebase 承認済みドメインに追加**
- [ ] **PC・スマホで同期テスト**
- [ ] **マルチアカウントテスト**（データ分離確認）
- [ ] **HANDOFF.md / PURPOSE.md 更新**

---

## 9. v5 以降の候補（今はやらない）

- 復元機能（Ctrl+Z）
- import/export（.json）
- 振り返り装置（別アプリ）
- MOE 指標

判断軸は `PURPOSE.md` の「機能追加するときの判断軸」に従う。
**ループ誘発系は却下**、外部化と摩擦低減に効くもの優先。

---

## 10. 自分用メモ欄

（ここに自分で気づいた事メモる）

-
-
-
