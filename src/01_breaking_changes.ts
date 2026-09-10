// 手順 2: GPT-5.x → GPT-6 Astra の破壊的変更スモークテスト
// 実行: node --env-file-if-exists=.env.local --import tsx src/01_breaking_changes.ts
import { makeClient, MODEL, describeError, jsonl, saveJson, log } from "./common.js";

const client = makeClient();
const OUT = "01_breaking_changes.jsonl";

type Row = { id: string; case: string; expect: string; ok: boolean; status?: number; code?: string | null; param?: string | null; detail: string };
const rows: Row[] = [];

async function probe(id: string, name: string, expect: string, fn: () => Promise<string>) {
  log(`${id} ${name}`);
  try {
    const detail = await fn();
    rows.push({ id, case: name, expect, ok: true, detail });
  } catch (e) {
    const d = describeError(e);
    rows.push({ id, case: name, expect, ok: false, status: d.status, code: d.code, param: d.param, detail: d.message });
  }
  const r = rows.at(-1)!;
  log(`  → ${r.ok ? "200 OK" : `ERROR ${r.status ?? ""} ${r.code ?? ""}`} : ${r.detail.slice(0, 200)}`);
  jsonl(OUT, { ts: new Date().toISOString(), model: MODEL, ...r });
}

// キャッシュ確認用に 1,024 トークンを確実に超える固定プレフィックス
const CACHE_PREFIX = Array.from({ length: 120 }, (_, i) => `規約第${i + 1}条: 本サービスの利用者は、第${i + 1}項に定める条件に同意したものとみなす。`).join("\n");

const base = { model: MODEL, max_output_tokens: 64 } as const;

await probe("2-1", "temperature=0.2", "400", async () => {
  const r = await client.responses.create({ ...base, temperature: 0.2, input: "1+1は?" });
  return `accepted; output_text=${r.output_text.slice(0, 40)}`;
});

await probe("2-2", "top_p=0.9", "400", async () => {
  const r = await client.responses.create({ ...base, top_p: 0.9, input: "1+1は?" });
  return `accepted; output_text=${r.output_text.slice(0, 40)}`;
});

await probe("2-3", "reasoning.effort=none", "400", async () => {
  const r = await client.responses.create({ ...base, reasoning: { effort: "none" }, input: "1+1は?" });
  return `accepted; output_text=${r.output_text.slice(0, 40)}`;
});

await probe("2-4", "reasoning.effort=low", "200", async () => {
  const r = await client.responses.create({ ...base, reasoning: { effort: "low" }, input: "1+1は?" });
  return `output_text=${r.output_text.slice(0, 40)} reasoning_tokens=${r.usage?.output_tokens_details?.reasoning_tokens}`;
});

await probe("2-5", "prompt_cache_retention=24h (旧パラメータ)", "400 or ignored", async () => {
  const r = await client.responses.create({ ...base, prompt_cache_retention: "24h", input: "1+1は?" });
  return `accepted (ignored?) id=${r.id}`;
});

await probe("2-6", "prompt_cache_options.ttl=30m を同一 prompt で 2 連打", "2回目 cached_tokens>0", async () => {
  const req = () =>
    client.responses.create({
      ...base,
      instructions: CACHE_PREFIX,
      input: "上記規約は全部で何条ありますか。数字のみ答えて。",
      prompt_cache_key: "gpt6-verify:cache-test:v1",
      prompt_cache_options: { ttl: "30m" },
    });
  const a = await req();
  const b = await req();
  const d = (r: typeof a) => r.usage?.input_tokens_details;
  return `1st cached=${d(a)?.cached_tokens} write=${d(a)?.cache_write_tokens} / 2nd cached=${d(b)?.cached_tokens} write=${d(b)?.cache_write_tokens} (input=${b.usage?.input_tokens})`;
});

await probe("2-7", "Chat Completions + tools", "400 (tool calling は Responses 必須)", async () => {
  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: "東京の天気を調べて" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  });
  return `accepted; finish_reason=${r.choices[0]?.finish_reason} tool_calls=${JSON.stringify(r.choices[0]?.message.tool_calls ?? null).slice(0, 120)}`;
});

await probe("2-7b", "Chat Completions (tools なし)", "200", async () => {
  const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "1+1は?" }], max_completion_tokens: 32 });
  return `content=${r.choices[0]?.message.content?.slice(0, 40)}`;
});

await probe("2-8", "configuration_update で effort low→high、キャッシュ維持の確認", "cached_tokens が維持される", async () => {
  const common = { model: MODEL, instructions: CACHE_PREFIX, prompt_cache_key: "gpt6-verify:cfg-update:v1", prompt_cache_options: { ttl: "30m" as const }, max_output_tokens: 64 };
  const first = await client.responses.create({ ...common, reasoning: { effort: "low" }, input: "第3条の内容を一文で。" });
  // A: request-level effort は low のまま、configuration_update item で high に上げる(推奨パターン)
  const viaItem = await client.responses.create({
    ...common,
    reasoning: { effort: "low" },
    previous_response_id: first.id,
    input: [{ type: "configuration_update", reasoning: { effort: "high" } }, { role: "user", content: "第5条の内容を一文で。" }],
  });
  // B: request-level effort を直接 high に変える(比較用)
  const viaParam = await client.responses.create({
    ...common,
    reasoning: { effort: "high" },
    previous_response_id: first.id,
    input: "第5条の内容を一文で。",
  });
  const c = (r: typeof first) => `cached=${r.usage?.input_tokens_details?.cached_tokens}/${r.usage?.input_tokens} reasoning_tokens=${r.usage?.output_tokens_details?.reasoning_tokens}`;
  saveJson("01_config_update_detail.json", { first: first.usage, viaItem: viaItem.usage, viaParam: viaParam.usage });
  return `first ${c(first)} | configuration_update ${c(viaItem)} | request-level ${c(viaParam)}`;
});

saveJson("01_breaking_changes_summary.json", rows);
console.log("\n| # | ケース | 期待 | 結果 | 詳細 |\n|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.id} | ${r.case} | ${r.expect} | ${r.ok ? "200" : `${r.status ?? "ERR"} ${r.code ?? ""}`} | ${r.detail.replace(/\|/g, "\\|").slice(0, 160)} |`);
}
