// 共通ユーティリティ: クライアント生成、usage 集計、費用計算、JSONL 出力、計時
import OpenAI from "openai";
import type { Response, ResponseUsage, ResponseOutputItem } from "openai/resources/responses/responses";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

export const MODEL = process.env.MODEL ?? "gpt-6-astra";
export const RESULTS_DIR = new URL("../results/", import.meta.url).pathname;

export function makeClient(): OpenAI {
  // .env.local では OPEN_AI_API_KEY という名前で置かれているので吸収する
  if (!process.env.OPENAI_API_KEY && process.env.OPEN_AI_API_KEY) process.env.OPENAI_API_KEY = process.env.OPEN_AI_API_KEY;
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY が未設定です。.env に書いて `node --env-file-if-exists=.env.local --import tsx src/xx.ts` で実行してください。");
    process.exit(1);
  }
  return new OpenAI({ maxRetries: 0 });
}

// gpt-6-astra Standard 価格 (USD / 1M tokens)。272K 超の長文倍率は本検証では発生しないので無視
export const PRICE = { input: 10, cached: 1, cacheWrite: 12.5, output: 50 };

export type UsageSum = {
  requests: number;
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
};

export function emptyUsage(): UsageSum {
  return { requests: 0, input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
}

export function addUsage(sum: UsageSum, usage: ResponseUsage | null | undefined): UsageSum {
  sum.requests += 1;
  if (!usage) return sum;
  sum.input_tokens += usage.input_tokens ?? 0;
  sum.cached_tokens += usage.input_tokens_details?.cached_tokens ?? 0;
  sum.cache_write_tokens += usage.input_tokens_details?.cache_write_tokens ?? 0;
  sum.output_tokens += usage.output_tokens ?? 0;
  sum.reasoning_tokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
  return sum;
}

export function costUsd(u: UsageSum): number {
  // 通常入力 = 入力合計 - キャッシュ読み込み - キャッシュ書き込み(公式の費用計算例に合わせる)
  const uncached = u.input_tokens - u.cached_tokens - u.cache_write_tokens;
  return (
    (uncached * PRICE.input + u.cached_tokens * PRICE.cached + u.cache_write_tokens * PRICE.cacheWrite + u.output_tokens * PRICE.output) /
    1_000_000
  );
}

export function jsonl(file: string, obj: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS_DIR + file, JSON.stringify(obj) + "\n");
}

export function saveJson(file: string, obj: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(RESULTS_DIR + file, JSON.stringify(obj, null, 2) + "\n");
}

export const now = (): number => performance.now();
export const ms = (t: number): number => Math.round(t);

// API エラーを表に載せられる形に潰す
export function describeError(e: unknown): { status?: number; code?: string | null; param?: string | null; message: string } {
  if (e instanceof OpenAI.APIError) {
    return { status: e.status, code: e.code ?? null, param: e.param ?? null, message: e.message };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

// response.output を人間が読める要約にする
export function summarizeOutput(output: ResponseOutputItem[]) {
  return output.map((item) => {
    if (item.type === "function_call") {
      return { type: item.type, name: item.name, call_id: item.call_id, async: (item as { async?: boolean }).async ?? null, arguments: item.arguments };
    }
    if (item.type === "message") {
      const text = item.content.map((c) => (c.type === "output_text" ? c.text : `[${c.type}]`)).join("");
      return { type: item.type, text };
    }
    if (item.type === "reasoning") {
      return { type: item.type, summary: item.summary?.map((s) => s.text).join("\n") ?? "" };
    }
    return { type: item.type };
  });
}

export function outputText(res: Response): string {
  return res.output_text ?? "";
}

export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...args);
}

// ベンチで使う「遅い外部 API」の模擬ツール群
export const DEMO_RATES: Record<string, number> = { "USD/JPY": 150.25, "EUR/JPY": 162.5, "GBP/JPY": 190.1 };

export async function fetchExchangeRate(pair: string, delayMs: number) {
  await sleep(delayMs);
  const rate = DEMO_RATES[pair];
  if (rate === undefined) return { error: `unknown pair: ${pair}`, source: "demo" };
  return { pair, rate, as_of: "2026-09-07T00:00:00Z", source: "demo fixture (not live)" };
}

export async function fetchCompanyProfile(ticker: string, delayMs: number) {
  await sleep(delayMs);
  return { ticker, name: `${ticker} Demo Corp`, sector: "Demo", employees: 1234, source: "demo fixture (not live)" };
}

export function calc(expression: string) {
  if (!/^[\d\s+\-*/().]+$/.test(expression)) return { error: "invalid expression" };
  try {
    return { expression, result: Function(`"use strict"; return (${expression});`)() as number };
  } catch (e) {
    return { error: String(e) };
  }
}
