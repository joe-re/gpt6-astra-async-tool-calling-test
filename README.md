# GPT-6 Astra: async tool calling / mid-turn steering 検証コード

GPT-6 Astra(`gpt-6-astra`)の async tool calling と mid-turn steering の挙動を、Node.js から Responses API を叩いて実測するためのスクリプト集です。

## 環境

| 項目 | バージョン |
|---|---|
| Node.js | v26.8.2(`--env-file-if-exists` を使用。`.tool-versions` で指定) |
| openai(npm) | 7.13.0 |
| ws | 8.21.3 |
| TypeScript | 7.0.2(実行は tsx 4.23.13) |

## 準備

```bash
npm install
echo 'OPENAI_API_KEY=sk-...' > .env.local
npm run typecheck
```

`.env.local` には `OPENAI_API_KEY` を置きます。`OPEN_AI_API_KEY` という名前でも読み込みます。

- Node.js 26 の `--env-file-if-exists` で `.env.local` を読むため、dotenv は不要です。各スクリプトは `node --env-file-if-exists=.env.local --import tsx src/02_async_basic.ts` のように実行します(`npm run 0N` に同じコマンドを登録済み)。
- WebSocket を使うスクリプト(04・05)は、Node.js 組み込みの `WebSocket` ではなく `ws` パッケージを使います。SDK の `ResponsesWS` が内部で `ws` を import するためです。

## スクリプト

| コマンド | 内容 | 目安コスト |
|---|---|---|
| `npm run 02` | async tool calling の基本挙動。公式サンプルの移植と sync との対照、異常系。`-- --lang=en` で英語版 | $0.05 |
| `npm run 03` | sync vs async のベンチ(mode × 遅延 × effort × N)。`-- --n=1 --delays=3000 --efforts=low` で小さく試せる | $1.5(N=5 全条件) |
| `npm run 06` | 03 の回答を gpt-6-astra で採点する | $0.5 |
| `npm run 04` | mid-turn steering。`-- --scenario=basic\|timed\|double\|long --steer_at=2000` | $0.3 / 回 |
| `npm run 05` | async tool + steering。`-- --deliver=create\|steer --variant=default\|toolfirst\|syncpending --delay=8000 --steer_at=1500` | $0.3 / 回 |
| `npm run 07` | ツール遅延を 0s / 10s / 60s / 180s に振り、sync / async の 1つ目のレスポンスと継続を比較。`-- --delays=0,10000` で短縮 | $0.1 |
| `npm run 08` | 従来(sync)の tool calling を最小構成で再現。ツール 2 本を並列に呼び、1つ目が function_call だけで終わることを見る | $0.02 |
| `npm run 09` | 03 と同条件で sync を 1 回実行し、1つ目のレスポンスの output を生のまま保存する | $0.01 |
| `npm run 01` | GPT-5.x からの破壊的変更のスモークテスト(temperature / top_p / effort none / prompt_cache_options / configuration_update)。記事では扱っていない | $0.3 |

結果は `results/` に JSON / JSONL / ログとして保存されます。`results/node23/` は Node.js 23 + openai 7.10.0 で実行した旧結果、`results/old_wording/` は instructions の文言を変更する前に実行した旧結果です。記事の数値は Node.js 26.8.2 + openai 7.13.0 での実行(2026-09-10)に基づきます。

## 構成

```
src/
├── common.ts               # クライアント生成、usage 集計、費用計算、JSONL 出力、模擬ツール
├── 01_breaking_changes.ts
├── 02_async_basic.ts
├── 03_benchmark.ts
├── 04_steering.ts
├── 05_async_steer.ts
├── 06_judge.ts
├── 07_slow_tool.ts
├── 08_sync_basic.ts
└── 09_bench_sync_sample.ts
```

## 参考

- [Model guidance | OpenAI API](https://developers.openai.com/api/docs/guides/latest-model)
- [Async tool calling | OpenAI API](https://developers.openai.com/api/docs/guides/async-tool-calling)
- [Mid-turn steering | OpenAI API](https://developers.openai.com/api/docs/guides/steering)
- [Responses WebSocket events | OpenAI API Reference](https://developers.openai.com/api/reference/resources/responses/websocket-events)
