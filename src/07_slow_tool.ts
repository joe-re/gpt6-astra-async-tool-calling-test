// 追加検証: 挟むツールを意図的に遅くしたとき、sync / async で最初のレスポンスと継続がどう変わるか
// 実行: node --env-file-if-exists=.env.local --import tsx src/07_slow_tool.ts [--delays=0,10000,60000,180000] [--modes=sync,async]
import type { FunctionTool, Response } from "openai/resources/responses/responses";
import { makeClient, MODEL, describeError, jsonl, saveJson, log, now, ms, sleep, addUsage, emptyUsage, costUsd } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const DELAYS = (args.delays ?? "0,10000,60000,180000").split(",").map(Number);
const MODES = (args.modes ?? "sync,async").split(",") as ("sync" | "async")[];
const OUT = "07_slow_tool.jsonl";

const tool = (async_: boolean): FunctionTool => ({
  type: "function", name: "get_weather", async: async_, strict: true,
  description: "Read the demo weather snapshot for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
});
const INSTRUCTIONS =
  "天気の取得を開始してください。天気とは関係のない持ち物の質問には、取得結果を待たずに先に答えてください。天気はツール結果が届いてから実際の値を使い、推測で書かないでください。天気がデモデータであることを明示してください。";
const INPUT = "パリのデモ天気を確認してください。その間に、都市旅行に共通して必要な持ち物を3つ挙げてください。";

// 記事掲載用に output を読みやすい形へ(id と encrypted_content を落とす)
function rawOutput(res: Response) {
  return res.output.map((o) => {
    if (o.type === "function_call") return { type: o.type, name: o.name, call_id: o.call_id, async: (o as { async?: boolean }).async, arguments: o.arguments };
    if (o.type === "message") return { type: o.type, phase: (o as { phase?: string }).phase, text: o.content.map((c) => (c.type === "output_text" ? c.text : `[${c.type}]`)).join("") };
    if (o.type === "reasoning") return { type: o.type, summary: o.summary.map((s) => s.text).join("\n") || "(encrypted)" };
    return { type: o.type };
  });
}

for (const delay of DELAYS) for (const mode of MODES) {
  log(`=== mode=${mode} delay=${delay}ms ===`);
  const usage = emptyUsage();
  const t0 = now();
  const tools = [tool(mode === "async")];
  const first = await client.responses.create({ model: MODEL, tools, instructions: INSTRUCTIONS, input: INPUT, reasoning: { effort: "low" } });
  const tFirst = ms(now() - t0);
  addUsage(usage, first.usage);
  const firstOut = rawOutput(first);
  console.log(JSON.stringify(firstOut, null, 2));
  const call = first.output.find((o) => o.type === "function_call");
  if (!call) { jsonl(OUT, { mode, delay_ms: delay, error: "no function_call" }); continue; }

  log(`tool sleeping ${delay}ms ...`);
  await sleep(delay);
  const result = { city: "Paris", temperature_c: 22, condition: "Clear", source: "demo weather snapshot" };
  const t1 = now();
  let second: Response | null = null;
  let error: unknown = null;
  try {
    second = await client.responses.create({
      model: MODEL, tools, instructions: INSTRUCTIONS, reasoning: { effort: "low" },
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) }],
    });
    addUsage(usage, second.usage);
  } catch (e) {
    error = describeError(e);
    log("continuation error:", error);
  }
  const tSecond = ms(now() - t1);
  const secondOut = second ? rawOutput(second) : null;
  if (secondOut) console.log(JSON.stringify(secondOut, null, 2));
  const row = {
    mode, delay_ms: delay,
    first_status: first.status, first_items: firstOut.map((o) => o.type + ((o as { phase?: string }).phase ? `(${(o as { phase?: string }).phase})` : "")),
    first_text_chars: firstOut.filter((o) => o.type === "message").reduce((s, o) => s + ((o as { text?: string }).text?.length ?? 0), 0),
    t_first_ms: tFirst, t_second_ms: tSecond, t_total_ms: ms(now() - t0),
    second_status: second?.status ?? null, second_items: secondOut?.map((o) => o.type + ((o as { phase?: string }).phase ? `(${(o as { phase?: string }).phase})` : "")) ?? null,
    continuation_ok: !!second, error, usage, cost_usd: costUsd(usage),
  };
  log(JSON.stringify({ ...row, usage: undefined }));
  jsonl(OUT, { ts: new Date().toISOString(), ...row });
  saveJson(`07_slow_tool_${mode}_${delay}.json`, { first: { status: first.status, usage: first.usage, output: firstOut }, second: second ? { status: second.status, usage: second.usage, output: secondOut } : null, error });
}

// 集計表
const rows = (await import("node:fs")).readFileSync(new URL("../results/" + OUT, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log("\n| mode | tool 遅延 | 1 本目 | 1 本目の items | 1 本目の文字数 | 継続 | 2 本目 | 合計 | 継続成功 |\n|---|---|---|---|---|---|---|---|---|");
for (const r of rows.slice(-DELAYS.length * MODES.length)) {
  console.log(`| ${r.mode} | ${r.delay_ms / 1000}s | ${r.t_first_ms}ms | ${r.first_items?.join(" → ")} | ${r.first_text_chars} | ${r.t_second_ms}ms | ${r.second_items?.join(" → ")} | ${(r.t_total_ms / 1000).toFixed(1)}s | ${r.continuation_ok} |`);
}
