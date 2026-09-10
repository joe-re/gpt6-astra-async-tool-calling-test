// 手順 5: mid-turn steering (WebSocket)
// 実行: node --env-file-if-exists=.env.local --import tsx src/04_steering.ts [--scenario=basic|timed|double|long] [--steer_at=2000]
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import { makeClient, MODEL, jsonl, saveJson, log, now, ms, sleep } from "./common.js";

const client = makeClient();
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SCENARIO = args.scenario ?? "basic";
const STEER_AT = Number(args.steer_at ?? 0); // timed シナリオで steer を送るまでの ms
const OUT = `04_steering_${SCENARIO}.jsonl`;

const PROMPT = "タスク管理アプリを作るためのプロジェクト計画書を、機能一覧・アーキテクチャ・スケジュール・リスクの 4 章構成で 2,000 字程度で書いてください。";
const STEER_SHORT = "スコープを開発者 1 人・2 週間に収まる規模に絞ってください。";
const STEER_LONG =
  "追加制約です。開発者は 1 人、期間は 2 週間、予算はゼロ、外部 SaaS は使わず、認証は不要、オフライン優先、データベースは SQLite、UI は最小限、テストはユニットテストのみ、デプロイは単一バイナリ配布とします。この条件を満たすように全章を書き直してください。";

const ws = new ResponsesWS(client, { handshakeTimeout: 10_000 });
const t0 = now();
const responses = new Map<string, { created_at: number; text: string; status?: string; reason?: string }>();
let initialId = "";
let currentId = "";
let steersSent = 0;
const eventLog: unknown[] = [];

function record(ev: ResponsesServerEvent) {
  const t = ms(now() - t0);
  const compact: Record<string, unknown> = { t_ms: t, type: ev.type };
  if ("response" in ev && ev.response) compact.response_id = ev.response.id, compact.status = ev.response.status, compact.incomplete = ev.response.incomplete_details ?? null;
  if ("steer" in ev) compact.steer = ev.steer;
  if ("error" in ev) compact.error = ev.error;
  if ("reason" in ev) compact.reason = (ev as { reason: unknown }).reason;
  if ("required_input" in ev) compact.required_input = (ev as { required_input: unknown }).required_input;
  if (ev.type === "response.output_text.delta") compact.delta_len = ev.delta.length;
  eventLog.push(compact);
  if (ev.type !== "response.output_text.delta" && ev.type !== "response.reasoning_summary_text.delta") log(JSON.stringify(compact));
}

function sendSteer(text: string) {
  steersSent++;
  log(`>>> response.steer #${steersSent} (${text.length} chars) at ${ms(now() - t0)}ms`);
  ws.send({ type: "response.steer", previous_response_id: initialId, input: text });
}

const done = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => { reject(new Error("timeout 180s")); ws.close(); }, 180_000);
  ws.on("event", (ev) => {
    record(ev);
    if (ev.type === "response.created") {
      currentId = ev.response.id;
      responses.set(ev.response.id, { created_at: ms(now() - t0), text: "" });
      if (!initialId) {
        initialId = ev.response.id;
        if (SCENARIO === "basic") sendSteer(STEER_SHORT);
        if (SCENARIO === "long") sendSteer(STEER_LONG);
        if (SCENARIO === "double") { sendSteer(STEER_SHORT); sendSteer("さらに、技術スタックは TypeScript と SQLite に限定してください。"); }
        if (SCENARIO === "timed") sleep(STEER_AT).then(() => sendSteer(STEER_SHORT));
      }
    } else if (ev.type === "response.output_text.delta") {
      const r = responses.get(currentId);
      if (r) r.text += ev.delta;
    } else if (ev.type === "response.incomplete" || ev.type === "response.completed" || ev.type === "response.failed") {
      const r = responses.get(ev.response.id);
      if (r) { r.status = ev.response.status ?? ev.type; r.reason = ev.response.incomplete_details?.reason ?? undefined; }
      if (ev.type === "response.failed") { clearTimeout(timeout); reject(new Error(JSON.stringify(ev))); }
      // 継続 response(initial 以外)が completed したら終了。steer 未受理で initial が completed した場合も終了
      if (ev.type === "response.completed" && (ev.response.id !== initialId || steersSent === 0)) { clearTimeout(timeout); resolve(); }
    } else if (ev.type === "error") {
      log("error event:", JSON.stringify(ev));
      // steer 拒否等でも initial が完走するケースがあるので即終了はしない
    }
  });
  ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
});

log(`scenario=${SCENARIO} steer_at=${STEER_AT}`);
ws.send({ type: "response.create", model: MODEL, reasoning: { effort: "low" }, input: PROMPT, stream: true });

try {
  await done;
} catch (e) {
  log("finished with error:", e instanceof Error ? e.message : e);
} finally {
  ws.close();
}

const summary = {
  scenario: SCENARIO, steer_at_ms: STEER_AT, steers_sent: steersSent, initial_id: initialId,
  responses: [...responses.entries()].map(([id, r]) => ({ id, created_at_ms: r.created_at, status: r.status, incomplete_reason: r.reason, text_len: r.text.length, text_head: r.text.slice(0, 200) })),
  event_types: eventLog.reduce<Record<string, number>>((acc, e) => { const t = (e as { type: string }).type; acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}),
};
console.log(JSON.stringify(summary, null, 2));
saveJson(`04_steering_${SCENARIO}_events.json`, eventLog);
saveJson(`04_steering_${SCENARIO}_texts.json`, [...responses.entries()].map(([id, r]) => ({ id, ...r })));
jsonl(OUT, { ts: new Date().toISOString(), ...summary });
