// 手順 3: async tool calling の基本挙動(HTTP + previous_response_id 継続)
// 実行: node --env-file-if-exists=.env.local --import tsx src/02_async_basic.ts [--lang=en|ja] [--delay=3000]
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import { makeClient, MODEL, describeError, saveJson, jsonl, log, now, ms, sleep, summarizeOutput, addUsage, emptyUsage, costUsd } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const LANG = (args.lang ?? "ja") as "en" | "ja";
const DELAY = Number(args.delay ?? 3000);
const OUT = "02_async_basic.jsonl";

const weatherTool = (async_: boolean, strict = true): FunctionTool => ({
  type: "function",
  name: "get_weather",
  description: "Read the demo weather snapshot for a city.",
  async: async_,
  strict,
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
});

const TEXT = {
  en: {
    instructions:
      "Start the weather lookup and answer the independent packing question without waiting. Use the actual tool result when it arrives; never invent it. Identify the weather as demo data.",
    input: "Check the demo weather in Paris. Meanwhile, list three essentials for any city trip.",
  },
  ja: {
    instructions:
      "天気の取得を開始してください。天気とは関係のない持ち物の質問には、取得結果を待たずに先に答えてください。天気はツール結果が届いてから実際の値を使い、推測で書かないでください。天気がデモデータであることを明示してください。",
    input: "パリのデモ天気を確認してください。その間に、都市旅行に共通して必要な持ち物を3つ挙げてください。",
  },
}[LANG];

async function getWeather(city: string) {
  await sleep(DELAY);
  return { city, temperature_c: 22, condition: "Clear", source: "demo weather snapshot" };
}

async function runScenario(name: string, tool: FunctionTool) {
  log(`=== ${name} (async=${tool.async}, strict=${tool.strict}) ===`);
  const usage = emptyUsage();
  const t0 = now();
  const first = await client.responses.create({ model: MODEL, tools: [tool], instructions: TEXT.instructions, input: TEXT.input, reasoning: { effort: "low" } });
  const tFirst = now() - t0;
  addUsage(usage, first.usage);
  const summary = summarizeOutput(first.output);
  log(`first response: status=${first.status} in ${ms(tFirst)}ms`);
  console.log(JSON.stringify(summary, null, 2));
  saveJson(`02_first_response_${name}.json`, first);

  const call = first.output.find((i) => i.type === "function_call");
  if (!call) {
    log("function_call が含まれない。終了。");
    jsonl(OUT, { scenario: name, first_status: first.status, has_call: false, usage });
    return;
  }
  const callAsync = (call as { async?: boolean }).async ?? null;
  const hasPartialText = first.output.some((i) => i.type === "message");
  log(`call.async=${callAsync}, 最初の response に message あり=${hasPartialText}`);

  const { city } = JSON.parse(call.arguments) as { city: string };
  const result = await getWeather(city);
  const t1 = now();
  const second = await client.responses.create({
    model: MODEL,
    tools: [tool],
    instructions: TEXT.instructions,
    reasoning: { effort: "low" },
    previous_response_id: first.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) }],
  });
  addUsage(usage, second.usage);
  log(`second response: status=${second.status} in ${ms(now() - t1)}ms, total ${ms(now() - t0)}ms`);
  console.log(JSON.stringify(summarizeOutput(second.output), null, 2));
  saveJson(`02_second_response_${name}.json`, second);
  jsonl(OUT, {
    scenario: name,
    lang: LANG,
    delay_ms: DELAY,
    first_status: first.status,
    call_async: callAsync,
    first_has_message: hasPartialText,
    t_first_ms: ms(tFirst),
    t_total_ms: ms(now() - t0),
    usage,
    cost_usd: costUsd(usage),
  });
  return { first, call };
}

// A/B: async vs sync
const asyncRun = await runScenario("async", weatherTool(true));
await runScenario("sync", weatherTool(false));

// C: strict を外した async ツールが受理されるか
try {
  await runScenario("async_nostrict", weatherTool(true, false));
} catch (e) {
  log("async_nostrict error:", describeError(e));
  jsonl(OUT, { scenario: "async_nostrict", error: describeError(e) });
}

// D〜F: 異常系。A の最初の response を起点に使う
if (asyncRun) {
  const { first, call } = asyncRun;
  const tool = weatherTool(true);

  log("=== D: function_call_output を返さずに user メッセージだけ送る ===");
  try {
    const r = await client.responses.create({
      model: MODEL, tools: [tool], instructions: TEXT.instructions, reasoning: { effort: "low" },
      previous_response_id: first.id,
      input: LANG === "ja" ? "ところで、パリの天気はもう分かりましたか?" : "By the way, do you have the Paris weather yet?",
    });
    console.log(JSON.stringify(summarizeOutput(r.output), null, 2));
    jsonl(OUT, { scenario: "D_no_output_then_user", status: r.status, output: summarizeOutput(r.output) });
  } catch (e) {
    log("D error:", describeError(e));
    jsonl(OUT, { scenario: "D_no_output_then_user", error: describeError(e) });
  }

  log("=== E: 存在しない call_id で function_call_output を返す ===");
  try {
    const r = await client.responses.create({
      model: MODEL, tools: [tool], instructions: TEXT.instructions, reasoning: { effort: "low" },
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_does_not_exist", output: "{}" }],
    });
    jsonl(OUT, { scenario: "E_bogus_call_id", status: r.status, output: summarizeOutput(r.output) });
  } catch (e) {
    log("E error:", describeError(e));
    jsonl(OUT, { scenario: "E_bogus_call_id", error: describeError(e) });
  }

  log("=== E2: 正しい call_id で 2 回目の function_call_output(重複)===");
  try {
    const input: ResponseInputItem[] = [{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ city: "Paris", temperature_c: 99 }) }];
    const r = await client.responses.create({ model: MODEL, tools: [tool], instructions: TEXT.instructions, reasoning: { effort: "low" }, previous_response_id: first.id, input });
    jsonl(OUT, { scenario: "E2_duplicate_output", status: r.status, output: summarizeOutput(r.output) });
  } catch (e) {
    log("E2 error:", describeError(e));
    jsonl(OUT, { scenario: "E2_duplicate_output", error: describeError(e) });
  }
}

log("=== F: hosted tool (web_search) に async: true ===");
try {
  const r = await client.responses.create({
    model: MODEL,
    tools: [{ type: "web_search", async: true } as unknown as FunctionTool],
    input: "今日の東京の天気は?",
    max_output_tokens: 64,
  });
  jsonl(OUT, { scenario: "F_hosted_async", status: r.status, output: summarizeOutput(r.output) });
} catch (e) {
  log("F error:", describeError(e));
  jsonl(OUT, { scenario: "F_hosted_async", error: describeError(e) });
}
log("done →", OUT);
