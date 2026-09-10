// 手順 4 補助: 03_benchmark.jsonl の回答を gpt-6-astra で採点する
// 実行: node --env-file-if-exists=.env.local --import tsx src/06_judge.ts [--run_id=...]
import { readFileSync } from "node:fs";
import { makeClient, MODEL, RESULTS_DIR, jsonl, log, DEMO_RATES } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const rows = readFileSync(RESULTS_DIR + "03_benchmark.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const target = args.run_id ? rows.filter((r) => r.run_id === args.run_id) : rows;

const schema = {
  type: "object",
  properties: {
    sum_correct: { type: "boolean", description: `最終回答が USD/JPY+EUR/JPY の合計 ${DEMO_RATES["USD/JPY"]! + DEMO_RATES["EUR/JPY"]!} を正しく提示しているか` },
    fabricated_before_tool: { type: "boolean", description: "ツール結果が届く前のテキストで、レートなど取得すべき数値を推測で書いていないか(書いていれば true)" },
    tips_quality: { type: "integer", minimum: 1, maximum: 5, description: "海外送金の手数料節約のコツ 3 つの妥当性 (1-5)" },
    comment: { type: "string" },
  },
  required: ["sum_correct", "fabricated_before_tool", "tips_quality", "comment"],
  additionalProperties: false,
} as const;

for (const r of target) {
  if (r.error) continue;
  const res = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: "あなたは厳格な採点者です。与えられたエージェントの出力を採点し JSON で返してください。",
    input: `# 各ステップの出力(順番通り)\n${(r.texts as string[]).map((t, i) => `## step ${i}\n${t}`).join("\n\n")}\n\n# 正解レート\n${JSON.stringify(DEMO_RATES)}`,
    text: { format: { type: "json_schema", name: "judge", schema, strict: true } },
  });
  const j = JSON.parse(res.output_text);
  log(`${r.mode} d=${r.delay_ms} e=${r.effort} i=${r.i}:`, j);
  jsonl("06_judge.jsonl", { run_id: r.run_id, mode: r.mode, delay_ms: r.delay_ms, effort: r.effort, i: r.i, ...j });
}
