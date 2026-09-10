// 従来(sync)の tool calling の流れを最小構成で再現する。ツール 2 本を並列に呼ばせ、
// 1 本目の response が function_call だけで終わり、結果を返すまでモデルが何も出さないことを見る
import type { FunctionTool } from "openai/resources/responses/responses";
import { makeClient, MODEL, sleep, saveJson, log, now, ms } from "./common.js";

const client = makeClient();

const tools: FunctionTool[] = ["fetch_rate", "fetch_news"].map((name) => ({
  type: "function", name, strict: true,
  description: name === "fetch_rate" ? "為替レートを取得する(数秒かかる)" : "為替ニュースの見出しを取得する(数秒かかる)",
  parameters: { type: "object", properties: { pair: { type: "string" } }, required: ["pair"], additionalProperties: false },
}));

async function runTool(name: string, pair: string) {
  await sleep(3000); // 遅い外部 API を模す
  return name === "fetch_rate" ? { pair, rate: 150.25, source: "demo" } : { pair, headlines: ["デモ見出し 1", "デモ見出し 2"], source: "demo" };
}

const t0 = now();
// 1. モデルがツール呼び出しを出力する。この時点でレスポンスは終わる
const first = await client.responses.create({
  model: MODEL, tools, reasoning: { effort: "low" },
  input: "USD/JPY のレートと関連ニュースを調べて、あわせて海外送金で手数料を抑えるコツを 3 つ教えてください。",
});
log(`first: status=${first.status} in ${ms(now() - t0)}ms`);
console.log(JSON.stringify(first.output.map((o) => (o.type === "function_call" ? { type: o.type, name: o.name, call_id: o.call_id, arguments: o.arguments } : { type: o.type })), null, 2));
console.log("output_text:", JSON.stringify(first.output_text));

// 2. アプリがツールを実行する(並列)
const calls = first.output.filter((o) => o.type === "function_call");
const outputs = await Promise.all(calls.map(async (c) => ({ type: "function_call_output" as const, call_id: c.call_id, output: JSON.stringify(await runTool(c.name, (JSON.parse(c.arguments) as { pair: string }).pair)) })));

// 3. 結果を function_call_output として返す → 4. モデルが続きを生成する
const t1 = now();
const second = await client.responses.create({ model: MODEL, tools, reasoning: { effort: "low" }, previous_response_id: first.id, input: outputs });
log(`second: status=${second.status} in ${ms(now() - t1)}ms, total ${ms(now() - t0)}ms`);
console.log(JSON.stringify(second.output.map((o) => (o.type === "message" ? { type: o.type, phase: (o as { phase?: string }).phase, text: o.content.map((c) => (c.type === "output_text" ? c.text : "")).join("") } : { type: o.type })), null, 2));
saveJson("08_sync_basic.json", { first: { status: first.status, usage: first.usage, output: first.output }, second: { status: second.status, usage: second.usage, output: second.output } });
