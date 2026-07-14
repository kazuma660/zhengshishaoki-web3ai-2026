// タスク名の語からタスクの種類を判定して、種類に合った1分ステップを返す。
// 上から順に最初にマッチした規則を使うので、語が重なる規則ほど先に置く
// （例:「書類」は手続き系。書く系の/書/より先に判定しないと誤爆する）。
const RULES: { pattern: RegExp; steps: (t: string) => string[] }[] = [
  {
    pattern: /手続|書類|役所|銀行|奨学金|申請|申込|登録/,
    steps: () => [
      "必要な書類（申請ページ）を開くだけ",
      "名前の欄だけ書いて止めてよし",
      "締切と提出先を1行でメモする",
    ],
  },
  {
    pattern: /連絡|返信|メール|ライン|LINE|電話|予約|問い合わせ|アポ/,
    steps: () => [
      "宛先（相手のトーク画面）を開くだけ",
      "挨拶の1行だけ打って下書きのまま置く",
      "伝えたい用件を1行でメモする",
    ],
  },
  {
    pattern: /解|過去問|問題|課題|宿題|演習|試験|テスト|勉強|暗記|単語/,
    steps: () => [
      "教材を開いて1問だけ読む。解かなくていい",
      "タイマー1分で分かる所だけ眺める",
      "今日やる範囲を1行でメモする",
    ],
  },
  {
    pattern: /読|本|論文|教科書/,
    steps: () => [
      "目次だけ眺めて閉じてよし",
      "最初の1段落だけ読む",
      "読む物を机（画面）に開いたままにする",
    ],
  },
  {
    pattern: /作|スライド|資料|発表|プレゼン|実装|コード|開発|アプリ|デザイン/,
    steps: () => [
      "作業ファイル（エディタ）を開くだけ",
      "一番小さい部品を1個だけ置く",
      "完成形を1行で言葉にしてメモする",
    ],
  },
  {
    pattern: /書|レポート|作文|エッセイ|志望理由|文章|日記/,
    steps: () => [
      "ファイルを開いてタイトルだけ書く",
      "清書しない前提で1文だけ書く",
      "書きたい事を箇条書きで3つ出す",
    ],
  },
  {
    pattern: /片付|掃除|整理|捨て|洗濯|皿/,
    steps: () => [
      "目に入った1個だけ元の場所に戻す",
      "ゴミを1つだけ捨てる",
      "やる範囲を「ここだけ」と決めて指差す",
    ],
  },
  {
    pattern: /調べ|探|検索|リサーチ|比較|選/,
    steps: () => [
      "検索窓にキーワードを打つだけ打つ",
      "最初に出た1件だけ開いて閉じてよし",
      "知りたい事を疑問文で1つメモする",
    ],
  },
  {
    pattern: /買|購入|注文/,
    steps: () => [
      "買う物の名前で検索だけする",
      "候補を1つだけブックマークする",
      "予算の上限を決めてメモする",
    ],
  },
  {
    pattern: /運動|筋トレ|走|ラン|ジム|ストレッチ|散歩/,
    steps: () => [
      "着替え（シューズ）だけ出して置く",
      "その場で1回だけやってみる",
      "やる時間を決めてアラームをセット",
    ],
  },
];

function suggestSteps(title: string): string[] {
  const rule = RULES.find((r) => r.pattern.test(title));
  if (rule) return rule.steps(title);
  return [
    `「${title}」に使うアプリ・ファイル・道具を開くだけ開く`,
    `「${title}」の最初の1行（1個）だけやって止めてよし`,
    `「${title}」を3つの小さい作業に割ってメモする`,
  ];
}

export async function POST(request: Request) {
  let title: unknown;
  try {
    ({ title } = await request.json());
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof title !== "string" || !title.trim()) {
    return Response.json({ error: "title required" }, { status: 400 });
  }
  const t = title.trim().slice(0, 200);
  return Response.json({ steps: suggestSteps(t), source: "rules" });
}
