# zhengshishaoki - web3・AI概論 2026

> このリポジトリは **web3・AI概論 2026** の各回宿題提出物を **累積管理** するレポです。\
> 各回の宿題は `lectures/lecture[N]/` フォルダに収納されます。\
> リポ名は `[DiscordID]-web3ai-2026` に統一(本名ではなく Discord ID を使う)。

---

## このリポジトリの構造

```
lectures/
├── lecture3/      ← 第3回(2026-05-07)・本回はここ
│   ├── README.md  ← 第3回の手順
│   ├── bug-list.md
│   └── vpc-v1.md
├── lecture4/      ← 第4回時に追加(同じ手順で)
└── lecture[N]/    ← 各回が累積
```

---

## 🤖 Antigravity 用 固定プロンプト(第3回)

> このプロンプトを **任意のフォルダで Antigravity を開いた状態** でコピペ → `__` の部分を埋め → **VPC スクショを添付** して実行。\
> Antigravity が clone・新規リポ作成・push まで全部やります。

````text
@Antigravity

これから web3・AI概論 第3回宿題のリポジトリを **ゼロから作成** して、GitHubにpushします。

# 全体の手順

1. テンプレ取得: https://github.com/web3ai-gairon/pub-docs.git をクローン
2. 中身を新規ディレクトリ「[DiscordID]-web3ai-2026」にコピー(.git 再初期化)
3. 私の新規 GitHub リポを作成: `gh repo create [DiscordID]-web3ai-2026 --public`
4. 下の私の入力をファイルに反映 + VPC スクショを assets/ に保存
5. 私に質問して確認 → README のチェックリスト記入
6. 新規リポへ push → URL を表示

## Discord ID
zhengshishaoki

## VPC v1
※ チャットに VPC スクショを添付しました
````

---

## 私の初期プロトタイプ(任意)

| 項目 | 回答 |
|---|---|
| デプロイURL(Vercel等) | 未提出(任意なのでOK) |
| 一言紹介 | - |

---

## 提出ステータス

**📝 コア課題**(全て必須・承認基準):
- [ ] バグリスト **20個 全部** 書いた
- [x] **一シーン選んで VPC v1 を書いた**(自分や周りの人を顧客に設定・6要素揃え・Fit取れてる)

**🚀 初期プロト**(任意):
- [ ] 初期プロトタイプを作って URL 取得した

**📤 提出準備**(必須):
- [x] **GitHub リポジトリを Public に設定している**
- [x] **このリポジトリリンクをポータルアプリ(Lectures ページ 第3回 課題提出欄)に貼り付けて提出することを理解した**

---

## 提出方法

**ポータルアプリ(Lectures ページの第3回 課題提出欄)** に以下を貼って提出:

1. **GitHubレポジトリURL**(このリポジトリの URL・必須)
2. **デプロイURL**(任意・Vercel等にデプロイ済みのプロダクトがあれば)

期限: **第4回(5/14)講義開始まで**\
報酬: **10,000 JOIN + 10,000 ICHIGO**

---

## 第4回以降について(累積運用)

このレポは **13週間で各回の宿題が積み上がる** 設計です。

1. **同じレポを Antigravity で開く**
2. pub-docs の `lectures/lecture[N]/` に常設される **第N回プロンプト** をコピー
3. 自レポに `lectures/lecture[N]/` 追加 → 内容反映 → push
4. 同じレポURL をポータルで提出

---

## 困った時は

- **VPC で詰まったら** → **AI大学講師** に壁打ち(Discord `#announce` の配布URL)
- **実装(初期プロト)で詰まったら** → **Antigravity**(内蔵 Claude Code を活用)
- **それでも詰まったら** → Discord **「学びのシェア」** チャンネルで人に聞く
- 完璧を目指さない。**v1 でいい**。
