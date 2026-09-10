// 手順 4: sync vs async 比較ベンチ (mode × delay × effort × N)
// 実行: node --env-file-if-exists=.env.local --import tsx src/03_benchmark.ts [--n=5] [--modes=sync,async] [--delays=3000,10000] [--efforts=low,medium]
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import type { ResponseStream } from "openai/lib/responses/ResponseStream";
import { makeClient, MODEL, describeError, jsonl, log, now, ms, addUsage, emptyUsage, costUsd, fetchExchangeRate, fetchCompanyProfile, calc, DEMO_RATES } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const N = Number(args.n ?? 5);
const MODES = (args.modes ?? "sync,async").split(",") as ("sync" | "async")[];
const DELAYS = (args.delays ?? "3000,10000").split(",").map(Number);
const EFFORTS = (args.efforts ?? "low,medium").split(",") as ("low" | "medium")[];
const OUT = "03_benchmark.jsonl";
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

const tools = (async_: boolean): FunctionTool[] => [
  {
    type: "function", name: "fetch_exchange_rate", async: async_, strict: true,
    description: "為替レートを外部 API から取得する(数秒かかる)。pair は 'USD/JPY' 形式。",
    parameters: { type: "object", properties: { pair: { type: "string" } }, required: ["pair"], additionalProperties: false },
  },
  {
    type: "function", name: "fetch_company_profile", async: async_, strict: true,
    description: "企業プロフィールを外部 API から取得する(数秒かかる)。",
    parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false },
  },
  {
    type: "function", name: "calc", async: false, strict: true,
    description: "四則演算を評価する(即時)。",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: false },
  },
];

const INSTRUCTIONS =
  "あなたは金融アシスタントです。ツールが必要な部分はツールを呼び、ツールが不要な独立した質問には待たずに先に答えてください。" +
  "ツール結果が届く前にレートなどの数値を推測で書いてはいけません。届いた値のみを使ってください。回答は日本語で簡潔に。";
const PROMPT =
  "USD/JPY と EUR/JPY のレートを取得して合計してください。それとは別に、海外送金で手数料を抑える一般的なコツを 3 つ挙げてください。";
const EXPECTED_SUM = DEMO_RATES["USD/JPY"]! + DEMO_RATES["EUR/JPY"]!; // 312.75

async function execTool(name: string, argsJson: string, delayMs: number): Promise<string> {
  const a = JSON.parse(argsJson) as Record<string, string>;
  if (name === "fetch_exchange_rate") return JSON.stringify(await fetchExchangeRate(a.pair!, delayMs));
  if (name === "fetch_company_profile") return JSON.stringify(await fetchCompanyProfile(a.ticker!, delayMs));
  if (name === "calc") return JSON.stringify(calc(a.expression!));
  return JSON.stringify({ error: `unknown tool ${name}` });
}

type RunResult = {
  run_id: string; mode: string; delay_ms: number; effort: string; i: number;
  t_first_text_ms: number | null; t_total_ms: number; n_requests: number; n_tool_calls: number; async_flag_seen: boolean;
  first_response_had_text: boolean; first_text_had_number_before_tool: boolean; final_has_expected_sum: boolean;
  usage: ReturnType<typeof emptyUsage>; cost_usd: number; texts: string[]; final_text: string; error?: unknown;
};

async function runOnce(mode: "sync" | "async", delayMs: number, effort: "low" | "medium", i: number): Promise<RunResult> {
  const usage = emptyUsage();
  const texts: string[] = [];
  let tFirstText: number | null = null;
  let nToolCalls = 0;
  let asyncFlagSeen = false;
  let firstResponseHadText = false;
  const t0 = now();
  const toolDefs = tools(mode === "async");
  let input: string | ResponseInputItem[] = PROMPT;
  let previousId: string | undefined;
  let error: unknown;

  try {
    for (let step = 0; step < 6; step++) {
      const stream: ResponseStream<null> = client.responses.stream({
        model: MODEL, tools: toolDefs, instructions: INSTRUCTIONS, reasoning: { effort },
        input, previous_response_id: previousId,
        prompt_cache_key: `gpt6-bench:${mode}:${effort}`, prompt_cache_options: { ttl: "30m" },
      });
      let stepText = "";
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") {
          if (tFirstText === null) tFirstText = now() - t0;
          stepText += ev.delta;
        }
      }
      const res = await stream.finalResponse();
      addUsage(usage, res.usage);
      if (stepText) texts.push(stepText);
      if (step === 0 && stepText) firstResponseHadText = true;
      previousId = res.id;

      const calls = res.output.filter((o) => o.type === "function_call");
      if (calls.length === 0) break;
      nToolCalls += calls.length;
      if (calls.some((c) => (c as { async?: boolean }).async)) asyncFlagSeen = true;
      // どちらのモードでもツールは並列実行して公平にする
      const outputs: ResponseInputItem[] = await Promise.all(
        calls.map(async (c) => ({ type: "function_call_output" as const, call_id: c.call_id, output: await execTool(c.name, c.arguments, delayMs) })),
      );
      input = outputs;
    }
  } catch (e) {
    error = describeError(e);
    log("error", error);
  }
  const finalText = texts.at(-1) ?? "";
  const firstText = texts[0] ?? "";
  // 最初のテキストにレートらしき数値(3 桁以上の小数)が含まれていたら捏造疑い
  const firstTextHadNumberBeforeTool = firstResponseHadText && nToolCalls > 0 && /\d{3}(\.\d+)?/.test(firstText);
  return {
    run_id: RUN_ID, mode, delay_ms: delayMs, effort, i,
    t_first_text_ms: tFirstText === null ? null : ms(tFirstText), t_total_ms: ms(now() - t0),
    n_requests: usage.requests, n_tool_calls: nToolCalls, async_flag_seen: asyncFlagSeen,
    first_response_had_text: firstResponseHadText, first_text_had_number_before_tool: firstTextHadNumberBeforeTool,
    final_has_expected_sum: texts.join("\n").includes(String(EXPECTED_SUM)),
    usage, cost_usd: costUsd(usage), texts, final_text: finalText, error,
  };
}

const results: RunResult[] = [];
for (const delay of DELAYS) for (const effort of EFFORTS) for (let i = 0; i < N; i++) for (const mode of MODES) {
  // mode を最内で交互に回し、時間帯による API レイテンシ変動を両モードに均等に散らす
  log(`run mode=${mode} delay=${delay} effort=${effort} i=${i}`);
  const r = await runOnce(mode, delay, effort, i);
  results.push(r);
  jsonl(OUT, r);
  log(`  t_first_text=${r.t_first_text_ms}ms t_total=${r.t_total_ms}ms req=${r.n_requests} calls=${r.n_tool_calls} async_seen=${r.async_flag_seen} sum_ok=${r.final_has_expected_sum} cost=$${r.cost_usd.toFixed(4)}`);
}

// 集計表
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
console.log("\n| mode | delay | effort | n | t_first_text(med ms) | t_total(med ms) | requests(avg) | in tok(avg) | cached(avg) | out tok(avg) | reasoning(avg) | cost(avg $) | sum_ok | 捏造疑い |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const mode of MODES) for (const delay of DELAYS) for (const effort of EFFORTS) {
  const g = results.filter((r) => r.mode === mode && r.delay_ms === delay && r.effort === effort && !r.error);
  if (!g.length) continue;
  const avg = (f: (r: RunResult) => number) => (g.reduce((s, r) => s + f(r), 0) / g.length).toFixed(1);
  console.log(
    `| ${mode} | ${delay} | ${effort} | ${g.length} | ${med(g.map((r) => r.t_first_text_ms ?? NaN))} | ${med(g.map((r) => r.t_total_ms))} | ${avg((r) => r.n_requests)} | ${avg((r) => r.usage.input_tokens)} | ${avg((r) => r.usage.cached_tokens)} | ${avg((r) => r.usage.output_tokens)} | ${avg((r) => r.usage.reasoning_tokens)} | ${(g.reduce((s, r) => s + r.cost_usd, 0) / g.length).toFixed(4)} | ${g.filter((r) => r.final_has_expected_sum).length}/${g.length} | ${g.filter((r) => r.first_text_had_number_before_tool).length}/${g.length} |`,
  );
}
log("done →", OUT, "run_id=", RUN_ID);
