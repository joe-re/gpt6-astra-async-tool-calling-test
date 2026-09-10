// 手順 6: async tool + mid-turn steering の組み合わせ (WebSocket)
// 実行: node --env-file-if-exists=.env.local --import tsx src/05_async_steer.ts [--delay=8000] [--steer_at=1500] [--deliver=create|steer]
//   deliver=create: ツール結果は response.create(previous_response_id) で返す(型コメントが示す正規パターン)。
//                   steer 入力が queued のままなら response.steer.pending が来て、continuation に自動で前置されるはず
//   deliver=steer : 実験。response.steer の input に function_call_output を入れて in_progress 中の response に投入する。
//                   型定義は許容するが docstring は「tool outputs は非対応」と言っており、どちらが正しいかを実測する
import { ResponsesWS } from "openai/resources/responses/ws";
import type { FunctionTool, ResponsesServerEvent } from "openai/resources/responses/responses";
import { makeClient, MODEL, jsonl, saveJson, log, now, ms, sleep, fetchExchangeRate, DEMO_RATES } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const DELAY = Number(args.delay ?? 8000);
const STEER_AT = Number(args.steer_at ?? 1500);
const DELIVER = (args.deliver ?? "create") as "steer" | "create";
const VARIANT = (args.variant ?? "default") as "default" | "toolfirst" | "syncpending"; // toolfirst: ツール呼び出しを先に出させ、その後に長い独立回答を書かせる(ツール完了時に response が in_progress である状況を作る)。syncpending: sync ツール待ちで response を止め steer.pending を観測する
const OUT = "05_async_steer.jsonl";
const IDLE_MS = 8000; // 最後の completed から新イベントが来なければ終了

const tools: FunctionTool[] = [{
  type: "function", name: "fetch_exchange_rate", async: VARIANT !== "syncpending", strict: true, // syncpending: sync ツールで response を止め、steer が pending になるかを見る
  description: "為替レートを外部 API から取得する(数秒かかる)。pair は 'USD/JPY' 形式。",
  parameters: { type: "object", properties: { pair: { type: "string" } }, required: ["pair"], additionalProperties: false },
}];
const INSTRUCTIONS = "ツール結果を待たずに、独立した質問には先に答えてください。レートはツール結果が届いてからのみ書き、推測しないこと。日本語で。";
const PROMPT =
  VARIANT === "syncpending"
    ? "USD/JPY のレートを取得して、100 万円が何ドルになるか計算してください。"
    : VARIANT === "toolfirst"
    ? "最初に USD/JPY のレート取得ツールを呼んでください。その後、ツール結果を待たずに、日本からアメリカへ海外送金する手段を 5 つ、それぞれ 200 字程度で詳しく説明してください。"
    : "USD/JPY のレートを取得してください。その間に、日本からアメリカへ海外送金する一般的な手段を 3 つ説明してください。";
const STEER_TEXT = VARIANT === "syncpending" ? "追加: 手数料 2% を差し引いた後の金額も併記してください。" : "追加: 送金手段の説明は、それぞれ手数料の目安も添えてください。";

const ws = new ResponsesWS(client, { handshakeTimeout: 10_000 });
const t0 = now();
const events: Record<string, unknown>[] = [];
const texts = new Map<string, string>();
const statuses = new Map<string, string>();
let initialId = "";
let currentId = "";
let steerSentAt: number | null = null;
let steerOutcome: string | null = null;
let pendingCall: { call_id: string; pair: string; async: boolean | undefined } | null = null;
let toolOutput: string | null = null;
let toolDoneAt: number | null = null;
let delivered: { via: string; at_ms: number; target: string } | null = null;
let steerPendingRequiredInput: unknown = null;
let steerDeliveryRejected: unknown = null; // steer 経由のツール結果投入が拒否されたときのエラー本文
let idleTimer: NodeJS.Timeout | null = null;
let finish: () => void = () => {};

const elapsed = () => ms(now() - t0);
const inProgress = (id: string) => statuses.get(id) === "in_progress";

function record(ev: ResponsesServerEvent) {
  const c: Record<string, unknown> = { t_ms: elapsed(), type: ev.type };
  if ("response" in ev && ev.response) { c.response_id = ev.response.id; c.status = ev.response.status; c.incomplete = ev.response.incomplete_details ?? null; }
  if ("item" in ev && ev.item) c.item = { type: ev.item.type, name: (ev.item as { name?: string }).name, async: (ev.item as { async?: boolean }).async, call_id: (ev.item as { call_id?: string }).call_id };
  if ("steer" in ev) c.steer = ev.steer;
  if ("error" in ev) c.error = ev.error;
  if ("reason" in ev) c.reason = (ev as { reason: unknown }).reason;
  if ("required_input" in ev) c.required_input = (ev as { required_input: unknown }).required_input;
  events.push(c);
  if (!ev.type.endsWith(".delta")) log(JSON.stringify(c));
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { log(`idle ${IDLE_MS}ms → finish`); finish(); }, IDLE_MS);
}

// ツール結果を返せる状態なら返す。呼ばれるタイミング: ツール完了時 / response 終了時 / steer 失敗時
function tryDeliver() {
  if (delivered || toolOutput === null || !pendingCall) return;
  const item = { type: "function_call_output" as const, call_id: pendingCall.call_id, output: toolOutput };
  if (DELIVER === "steer" && !steerDeliveryRejected && inProgress(currentId)) {
    delivered = { via: "steer", at_ms: elapsed(), target: currentId };
    log(`>>> deliver via response.steer(function_call_output) → ${currentId}`);
    ws.send({ type: "response.steer", previous_response_id: currentId, input: [item] });
    return;
  }
  if (!inProgress(currentId)) {
    delivered = { via: "create", at_ms: elapsed(), target: currentId };
    log(`>>> deliver via response.create(previous_response_id=${currentId})`);
    ws.send({ type: "response.create", model: MODEL, tools, instructions: INSTRUCTIONS, reasoning: { effort: "low" }, previous_response_id: currentId, input: [item], stream: true });
    return;
  }
  log("deliver deferred: current response still in_progress");
}

const done = new Promise<void>((resolve, reject) => {
  const hard = setTimeout(() => reject(new Error("timeout 180s")), 180_000);
  finish = () => { clearTimeout(hard); if (idleTimer) clearTimeout(idleTimer); resolve(); };
  ws.on("event", (ev) => {
    record(ev);
    switch (ev.type) {
      case "response.created":
        if (idleTimer) clearTimeout(idleTimer);
        currentId = ev.response.id; statuses.set(currentId, "in_progress"); texts.set(currentId, "");
        if (!initialId) {
          initialId = currentId;
          if (STEER_AT < 0) { steerOutcome = "disabled"; }
          else sleep(STEER_AT).then(() => {
            if (!inProgress(initialId)) { steerOutcome = "skipped: initial already finished"; log(steerOutcome); return; }
            steerSentAt = elapsed();
            log(`>>> response.steer(user text) → ${initialId} at ${steerSentAt}ms`);
            ws.send({ type: "response.steer", previous_response_id: initialId, input: STEER_TEXT });
          });
        }
        break;
      case "response.output_item.done":
        if (ev.item.type === "function_call" && !pendingCall) {
          pendingCall = { call_id: ev.item.call_id, pair: (JSON.parse(ev.item.arguments) as { pair: string }).pair, async: (ev.item as { async?: boolean }).async };
          log(`tool call detected async=${pendingCall.async} → start fetch (${DELAY}ms)`);
          fetchExchangeRate(pendingCall.pair, DELAY).then((r) => { toolOutput = JSON.stringify(r); toolDoneAt = elapsed(); log(`tool finished at ${toolDoneAt}ms`); tryDeliver(); });
        }
        break;
      case "response.output_text.delta":
        texts.set(currentId, (texts.get(currentId) ?? "") + ev.delta);
        break;
      case "response.steer.accepted":
        if (!steerOutcome) steerOutcome = "accepted";
        break;
      case "response.steer.pending":
        steerPendingRequiredInput = (ev as { required_input: unknown }).required_input;
        steerOutcome = `pending (${(ev as { reason: string }).reason})`;
        tryDeliver();
        break;
      case "response.steer.failed":
        if (delivered?.via === "steer") { log("function_call_output via steer was rejected → fallback to response.create after the response ends"); steerDeliveryRejected = (ev as { error: unknown }).error; delivered = null; }
        else steerOutcome = `failed: ${JSON.stringify((ev as { error: unknown }).error)}`;
        break;
      case "response.incomplete":
      case "response.completed":
        statuses.set(ev.response.id, ev.response.status ?? ev.type);
        tryDeliver();
        armIdle();
        break;
      case "response.failed":
        clearTimeout(hard); reject(new Error(JSON.stringify(ev)));
        break;
      case "error":
        log("error event", JSON.stringify(ev));
        armIdle();
        break;
    }
  });
  ws.on("error", (e) => { clearTimeout(hard); reject(e); });
});

log(`delay=${DELAY} steer_at=${STEER_AT} deliver=${DELIVER} variant=${VARIANT}`);
ws.send({ type: "response.create", model: MODEL, tools, instructions: INSTRUCTIONS, reasoning: { effort: "low" }, input: PROMPT, stream: true });

try { await done; } catch (e) { log("finished with error:", e instanceof Error ? e.message : e); } finally { ws.close(); }

const allText = [...texts.values()].join("\n");
const summary = {
  delay_ms: DELAY, steer_at_ms: STEER_AT, deliver_mode: DELIVER, variant: VARIANT,
  steer_sent_at_ms: steerSentAt, steer_outcome: steerOutcome, steer_pending_required_input: steerPendingRequiredInput, steer_tool_output_rejected: steerDeliveryRejected,
  initial_id: initialId, tool_call: pendingCall, tool_done_at_ms: toolDoneAt, delivered,
  final_uses_tool_rate: allText.includes(String(DEMO_RATES["USD/JPY"])),
  final_mentions_fee: /手数料/.test([...texts.values()].at(-1) ?? ""),
  responses: [...texts.entries()].map(([id, t]) => ({ id, status: statuses.get(id), len: t.length, head: t.slice(0, 300), text: t })),
  event_types: events.reduce<Record<string, number>>((acc, e) => { const t = e.type as string; acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}),
};
console.log(JSON.stringify(summary, null, 2));
saveJson(`05_async_steer_${DELIVER}_${VARIANT}_events.json`, events);
jsonl(OUT, { ts: new Date().toISOString(), ...summary });
