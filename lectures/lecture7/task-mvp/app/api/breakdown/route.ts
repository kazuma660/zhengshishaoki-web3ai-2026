import Anthropic from "@anthropic-ai/sdk";

const SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: { type: "string" },
      description: "最初の1分でできる具体的な行動。3つ。",
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

const SYSTEM = `あなたは「やる気が出ない日でも動ける最初の一歩」を設計するコーチ。
渡されたタスクに対して、最初の1分以内に物理的に完了できる行動を3つ提案する。

ルール:
- 各提案は30文字以内
- 「考える」「調べる」のような曖昧な動詞ではなく、「〜を開く」「〜を1行書く」「〜を1つ出す」のように完了が目に見える行動にする
- 3つは粒度や角度を変える（環境を整える系 / 着手する系 / 分解する系 など）
- 説教やはげましは書かない。行動だけ。`;

function fallbackSteps(title: string): string[] {
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ steps: fallbackSteps(t), source: "builtin" });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `タスク: ${t}`,
        },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { steps: string[] };
    const steps = parsed.steps.filter((s) => typeof s === "string").slice(0, 3);
    if (steps.length === 0) throw new Error("empty steps");
    return Response.json({ steps, source: "ai" });
  } catch {
    return Response.json({ steps: fallbackSteps(t), source: "builtin" });
  }
}
