// 03 ベンチと同じツール定義・instructions・プロンプトで sync を 1 回実行し、1つ目の response の output を生のまま保存する
// (記事で「sync でも message が function_call の前に出る」ことを示すための例)
import type { FunctionTool } from "openai/resources/responses/responses";
import { makeClient, MODEL, saveJson, log } from "./common.js";

const client = makeClient();
const tools: FunctionTool[] = [
  { type: "function", name: "fetch_exchange_rate", async: false, strict: true, description: "為替レートを外部 API から取得する(数秒かかる)。pair は 'USD/JPY' 形式。",
    parameters: { type: "object", properties: { pair: { type: "string" } }, required: ["pair"], additionalProperties: false } },
  { type: "function", name: "fetch_company_profile", async: false, strict: true, description: "企業プロフィールを外部 API から取得する(数秒かかる)。",
    parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false } },
  { type: "function", name: "calc", async: false, strict: true, description: "四則演算を評価する(即時)。",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: false } },
];
const INSTRUCTIONS =
  "あなたは金融アシスタントです。ツールが必要な部分はツールを呼び、ツールが不要な独立した質問には待たずに先に答えてください。" +
  "ツール結果が届く前にレートなどの数値を推測で書いてはいけません。届いた値のみを使ってください。回答は日本語で簡潔に。";
const PROMPT = "USD/JPY と EUR/JPY のレートを取得して合計してください。それとは別に、海外送金で手数料を抑える一般的なコツを 3 つ挙げてください。";

const first = await client.responses.create({ model: MODEL, tools, instructions: INSTRUCTIONS, reasoning: { effort: "low" }, input: PROMPT });
log(`status=${first.status} items=${first.output.map((o) => o.type).join(" → ")}`);
const out = first.output.map((o) => { const c = { ...o } as Record<string, unknown>; delete c.id; delete c.encrypted_content; return c; });
console.log(JSON.stringify({ status: first.status, output: out, usage: first.usage }, null, 2));
saveJson("09_bench_sync_first_response.json", { status: first.status, output: out, usage: first.usage });
