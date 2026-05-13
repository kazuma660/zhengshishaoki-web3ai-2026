# web3・AI概論 2026 — 公開ドキュメント

千葉工業大学「**総合科学特論 web3・AI概論 2026**」の **受講生向け公開資料** を集約するリポジトリです。

---

## 構造

```
lectures/
├── lecture3/    第3回(2026-05-07)— 自分のやりたいことを深掘って設計する(VPC)
├── lecture4/    第4回(将来追加)
└── lecture[N]/  各回が累積
```

---

## 受講生用テンプレートの使い方

### 第3回(初回・Use this template)

1. このリポジトリの **緑の "Use this template" ボタン** で自分のリポジトリを作成
   - リポ名: `[DiscordID]-web3ai-2026` / Public
2. 自分のリポジトリの [`lectures/lecture3/README.md`](./lectures/lecture3/) を開く
3. そこに常設の **Antigravity 用固定プロンプト** をコピペ → 内容を埋めて Antigravity で実行
4. 自動で `lectures/lecture3/` の3ファイル更新 + commit + push
5. ポータルアプリ(第3回 課題提出欄)に GitHub レポURL を提出

### 第4回以降(累積運用)

1. **同じリポジトリ** を Antigravity で開く(Use this template は不要)
2. このリポジトリの `lectures/lecture[N]/README.md` から **第N回プロンプト** をコピペ
3. プロンプトが pub-docs から第N回フォルダを fetch → 自リポに `lectures/lecture[N]/` 追加 → 内容反映 → push
4. 同じレポURLをポータルで提出

→ **学生は「README からプロンプトをコピペ」だけ**(毎回同じパターン・新規レポ作成不要)

---

## 各回の詳細

| 回 | 日付 | テーマ | 詳細 |
|---|---|---|---|
| 3 | 2026-05-07 | 自分のやりたいことを深掘って設計する(VPC) | [`lectures/lecture3/`](./lectures/lecture3/) |
| 4 | 2026-05-14 | 技術① AIの全体像 | (準備中) |

---

## メンテナ

- **minta**(運営): 各回の課題テンプレ追加・更新
