# Spike D — embeddings on CPU, local and remote endpoints

2026-10-27T15:46:46.985Z · AMD Ryzen 9 9900X 12-Core Processor (24 logical CPUs) · 62 GB RAM
Model: `nomic-embed-text-v1.5.Q4_K_M.gguf` (stand-in; planned: Qwen3-Embedding-0.6B-Q8_0) · llama-server on CPU (`--device none`, -np 4, -c 8192, pooling mean)
Input: 388 chunks (≤ 1200 characters) from 388 corpus documents, batches of 64

## 1. Throughput and memory by thread limit (local endpoint)

| Threads | Tokens/s | Chunks/s | Time | Process memory |
|---|---|---|---|---|
| 4 | 2451 | 16.8 | 23.0 s | 577 MB |
| 8 | 3801 | 26.1 | 14.9 s | 579 MB |
| 12 | 4661 | 32.0 | 12.1 s | 581 MB |

## 2. Local + second endpoint together

Two llama-server processes with 6 threads each, on the same machine (the CPU is shared: a real remote host adds its own CPU).

- Combined throughput: 5073 tokens/s, 34.8 chunks/s
- Split of the work (items): local 204 · remote-1 206
- Interactive query (priority 0) during the backfill: p50 365 ms · p95 646 ms · max 646 ms
- Query timeline (start → latency, * = backfill still running; backfill ended at 11.1 s): 0.0s→579ms* 0.7s→460ms* 1.4s→393ms* 1.9s→398ms* 2.5s→317ms* 2.9s→511ms* 3.6s→350ms* 4.1s→345ms* 4.6s→393ms* 5.2s→365ms* 5.7s→415ms* 6.3s→590ms* 7.0s→646ms* 7.8s→305ms* 8.3s→134ms* 8.6s→106ms* 8.8s→104ms* 9.1s→108ms* 9.3s→108ms* 9.6s→101ms*
- Dispatcher rules: 1 slot per endpoint reserved for interactive jobs; background batches split into requests of 2 texts (callers pass batches of 64).

## 3. Identity check

- Endpoint with `nomic-embed-text-v1.5.q4_k_m` while EMBED_MODEL_ID is Qwen3-Embedding-0.6B: status **mismatch** — model nomic-embed-text-v1.5.q4_k_m is different from the expected qwen3-embedding-0.6b-q8_0

## 4. Retrieval sanity on the corpus questions

hit@5 = the expected source document is among the first 5 documents (131 questions, 388 chunks, 768 dimensions).

| Question kind | nomic-embed-text-v1.5.Q4_K_M | Mock (lexical hashing) |
|---|---|---|
| lookup (61) | 74% | 43% |
| updated (23) | 26% | 48% |
| decision (19) | 58% | 21% |
| contradiction (5) | 80% | 0% |
| relational (23) | 83% | 83% |
| **total** | **65%** | **46%** |

Note: "updated" questions expect the newest source; vector search alone cannot know which value is current — that is the job of the compiled page (current state (`Stato attuale`) + timeline).
