# The snapshot feed: the dry run (task 967)

Run 2026-10-23T18:18:19.708Z with `npx tsx src/league/feed/dryrun.ts`: two runtimes with the real loop, feed and backoff, each on a made-up wallet (0x0000…a11c, 0x0000…a22c) with the fake signer and chain of `src/league/prompt/fakes.ts`, a throwaway home under the system's temp folder, and one virtual clock that moves only when both loops sleep (830.0 s of it, from 2026-10-26T12:00:00.000Z). feast.meme's `/api/v1/snapshot` and the indexer's `/v1/events` and `/v1/board` are a stub on 127.0.0.1 (`<stub>` below); every coin, wallet, event and hash is made up. Nothing reached a network, a wallet or a chain; nothing was signed, launched or bought. Addresses and hashes are abbreviated 6+4.

## The phases

| From | Phase | The stub |
| --- | --- | --- |
| 0.0 s | the start | the snapshot, with its ETag; each agent waits its own start jitter before its first read |
| 30.0 s | steady | the same; a quiet market, so a new generation (and ETag) every 10 s: a 200 when it moved, a 304 when not |
| 90.0 s | the outage | every snapshot GET answers 429, with Retry-After: 5 |
| 135.0 s | the recovery | the snapshot answers again |
| 180.0 s | the 404 fallback | the route answers 404, as before tasks 965 and 966 deploy; the indexer's legacy routes answer |
| 720.0 s | the route deployed | the snapshot answers 200 again; each agent sees it at its 10-minute recheck |

The start jitter drawn for each (FL start draws U(0, 120) s; here kept under 30 s so the run stays short): momentum 28.5 s, prompt 13.7 s.

## 1. momentum (preset)

Outcome: finished (the run's time is up). Requests to the stub: 122.

| Phase | Snapshot GETs (200 / 304 / 429 / 404) | Legacy GETs (events / board) | Gaps between snapshot GETs |
| --- | --- | --- | --- |
| the start (0.0 s) | 1 (1 / 0 / 0 / 0) | 0 / 0 | — |
| steady (30.0 s) | 8 (6 / 2 / 0 / 0) | 0 / 0 | 6.0 s – 8.0 s |
| the outage (90.0 s) | 5 (0 / 0 / 5 / 0) | 0 / 0 | 5.0 s – 14.0 s |
| the recovery (135.0 s) | 4 (3 / 1 / 0 / 0) | 0 / 0 | 6.0 s – 31.0 s |
| the 404 fallback (180.0 s) | 1 (0 / 0 / 0 / 1) | 77 / 9 | 6.0 s – 6.0 s |
| the route deployed (720.0 s) | 7 (5 / 2 / 0 / 0) | 9 / 1 | 6.0 s – 601.0 s |

The log's feed lines (and the start, the jitter's end and the autopilot):

```text
+  0.0 s started {"track":"preset","preset":"momentum","feed":"snapshot","pollMs":5000,"startJitterMs":28498}
+ 29.0 s jitter.done {"afterMs":29000}
+ 93.0 s feed.backoff {"status":429,"reason":"HTTP 429"}
+103.0 s feed.stale {"failures":3,"status":429,"reason":"HTTP 429"}
+156.0 s feed.ok {"afterMs":63000,"failures":5}
+181.0 s snapshot.unavailable {"status":404,"fallback":"the indexer's /v1/events and /v1/board, at the same interval","recheckMinutes":10}
+782.0 s snapshot.available {"after":"the legacy reads"}
```

Notifications:

```text
+  0.0 s [demo] started: preset momentum running; tick 60 s
+103.0 s [demo] market: feast.meme's market data is not answering (HTTP 429): the agent decides on its last good read, marked stale, and asks again with a growing wait; its exits and the drawdown halt read the chain
```

<details><summary>Every request, in order</summary>

```text
+ 29.0 s GET /api/v1/snapshot → 200
+ 36.0 s GET /api/v1/snapshot → 200
+ 42.0 s GET /api/v1/snapshot → 200
+ 49.0 s GET /api/v1/snapshot → 304
+ 57.0 s GET /api/v1/snapshot → 200
+ 65.0 s GET /api/v1/snapshot → 200
+ 71.0 s GET /api/v1/snapshot → 200
+ 78.0 s GET /api/v1/snapshot → 304
+ 86.0 s GET /api/v1/snapshot → 200
+ 93.0 s GET /api/v1/snapshot → 429
+ 98.0 s GET /api/v1/snapshot → 429
+103.0 s GET /api/v1/snapshot → 429
+111.0 s GET /api/v1/snapshot → 429
+125.0 s GET /api/v1/snapshot → 429
+156.0 s GET /api/v1/snapshot → 200
+162.0 s GET /api/v1/snapshot → 200
+168.0 s GET /api/v1/snapshot → 304
+175.0 s GET /api/v1/snapshot → 200
+181.0 s GET /api/v1/snapshot → 404
+188.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAxNywiaSI6MH0&limit=200 → 200
+196.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAxOCwiaSI6MH0&limit=199 → 200
+202.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAxOSwiaSI6MH0&limit=198 → 200
+208.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMCwiaSI6MH0&limit=197 → 200
+209.0 s GET /idx/v1/board?limit=100 → 200
+214.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMCwiaSI6MH0&limit=196 → 200
+221.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMSwiaSI6MH0&limit=195 → 200
+228.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMiwiaSI6MH0&limit=194 → 200
+236.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMiwiaSI6MH0&limit=193 → 200
+242.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMywiaSI6MH0&limit=192 → 200
+248.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNCwiaSI6MH0&limit=191 → 200
+255.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNCwiaSI6MH0&limit=190 → 200
+262.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNSwiaSI6MH0&limit=189 → 200
+269.0 s GET /idx/v1/board?limit=100 → 200
+270.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNiwiaSI6MH0&limit=188 → 200
+276.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNywiaSI6MH0&limit=187 → 200
+284.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNywiaSI6MH0&limit=186 → 200
+291.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOCwiaSI6MH0&limit=200 → 200
+299.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOSwiaSI6MH0&limit=199 → 200
+307.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOSwiaSI6MH0&limit=198 → 200
+313.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMCwiaSI6MH0&limit=197 → 200
+321.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMSwiaSI6MH0&limit=196 → 200
+327.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMiwiaSI6MH0&limit=195 → 200
+329.0 s GET /idx/v1/board?limit=100 → 200
+333.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMiwiaSI6MH0&limit=194 → 200
+340.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMywiaSI6MH0&limit=193 → 200
+346.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNCwiaSI6MH0&limit=192 → 200
+352.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNCwiaSI6MH0&limit=191 → 200
+360.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNSwiaSI6MH0&limit=190 → 200
+367.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNiwiaSI6MH0&limit=189 → 200
+373.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNiwiaSI6MH0&limit=188 → 200
+379.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNywiaSI6MH0&limit=187 → 200
+385.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNywiaSI6MH0&limit=186 → 200
+389.0 s GET /idx/v1/board?limit=100 → 200
+392.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzOCwiaSI6MH0&limit=200 → 200
+400.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzOSwiaSI6MH0&limit=199 → 200
+406.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MCwiaSI6MH0&limit=198 → 200
+414.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MCwiaSI6MH0&limit=197 → 200
+422.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MSwiaSI6MH0&limit=196 → 200
+429.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MiwiaSI6MH0&limit=195 → 200
+435.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MiwiaSI6MH0&limit=194 → 200
+443.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MywiaSI6MH0&limit=193 → 200
+449.0 s GET /idx/v1/board?limit=100 → 200
+451.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NCwiaSI6MH0&limit=192 → 200
+459.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NSwiaSI6MH0&limit=191 → 200
+467.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NSwiaSI6MH0&limit=190 → 200
+475.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NiwiaSI6MH0&limit=189 → 200
+483.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NywiaSI6MH0&limit=188 → 200
+491.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OCwiaSI6MH0&limit=187 → 200
+497.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OSwiaSI6MH0&limit=186 → 200
+503.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OSwiaSI6MH0&limit=200 → 200
+509.0 s GET /idx/v1/board?limit=100 → 200
+511.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MCwiaSI6MH0&limit=199 → 200
+517.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MSwiaSI6MH0&limit=198 → 200
+525.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MSwiaSI6MH0&limit=197 → 200
+532.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MiwiaSI6MH0&limit=196 → 200
+540.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MywiaSI6MH0&limit=195 → 200
+548.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NCwiaSI6MH0&limit=194 → 200
+554.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NCwiaSI6MH0&limit=193 → 200
+562.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NSwiaSI6MH0&limit=192 → 200
+569.0 s GET /idx/v1/board?limit=100 → 200
+570.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NiwiaSI6MH0&limit=191 → 200
+576.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NywiaSI6MH0&limit=190 → 200
+584.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NywiaSI6MH0&limit=189 → 200
+590.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OCwiaSI6MH0&limit=188 → 200
+597.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OSwiaSI6MH0&limit=187 → 200
+603.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OSwiaSI6MH0&limit=186 → 200
+610.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MCwiaSI6MH0&limit=200 → 200
+616.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MSwiaSI6MH0&limit=199 → 200
+623.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MSwiaSI6MH0&limit=198 → 200
+629.0 s GET /idx/v1/board?limit=100 → 200
+630.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MiwiaSI6MH0&limit=197 → 200
+637.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MywiaSI6MH0&limit=196 → 200
+643.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MywiaSI6MH0&limit=195 → 200
+651.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NCwiaSI6MH0&limit=194 → 200
+659.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NSwiaSI6MH0&limit=193 → 200
+665.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NSwiaSI6MH0&limit=192 → 200
+671.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NiwiaSI6MH0&limit=191 → 200
+677.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NywiaSI6MH0&limit=190 → 200
+685.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NywiaSI6MH0&limit=189 → 200
+689.0 s GET /idx/v1/board?limit=100 → 200
+691.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OCwiaSI6MH0&limit=188 → 200
+697.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OSwiaSI6MH0&limit=187 → 200
+704.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OSwiaSI6MH0&limit=186 → 200
+711.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MCwiaSI6MH0&limit=200 → 200
+717.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MSwiaSI6MH0&limit=199 → 200
+723.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MSwiaSI6MH0&limit=198 → 200
+729.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MiwiaSI6MH0&limit=197 → 200
+735.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MiwiaSI6MH0&limit=196 → 200
+741.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MywiaSI6MH0&limit=195 → 200
+749.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NCwiaSI6MH0&limit=194 → 200
+749.0 s GET /idx/v1/board?limit=100 → 200
+756.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NCwiaSI6MH0&limit=193 → 200
+762.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NSwiaSI6MH0&limit=192 → 200
+769.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NiwiaSI6MH0&limit=191 → 200
+776.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NiwiaSI6MH0&limit=190 → 200
+782.0 s GET /api/v1/snapshot → 200
+790.0 s GET /api/v1/snapshot → 200
+796.0 s GET /api/v1/snapshot → 304
+804.0 s GET /api/v1/snapshot → 200
+812.0 s GET /api/v1/snapshot → 200
+820.0 s GET /api/v1/snapshot → 200
+826.0 s GET /api/v1/snapshot → 304
```

</details>

## 2. prompt mode, sniper autopilot after 1 min

Outcome: finished (the run's time is up). Requests to the stub: 106.

| Phase | Snapshot GETs (200 / 304 / 429 / 404) | Legacy GETs (events / board) | Gaps between snapshot GETs |
| --- | --- | --- | --- |
| the start (0.0 s) | 0 (0 / 0 / 0 / 0) | 0 / 0 | — |
| steady (30.0 s) | 5 (3 / 2 / 0 / 0) | 0 / 0 | 6.0 s – 8.0 s |
| the outage (90.0 s) | 5 (0 / 0 / 5 / 0) | 0 / 0 | 5.0 s – 19.0 s |
| the recovery (135.0 s) | 4 (3 / 1 / 0 / 0) | 0 / 0 | 6.0 s – 26.0 s |
| the 404 fallback (180.0 s) | 1 (0 / 0 / 0 / 1) | 75 / 0 | 8.0 s – 8.0 s |
| the route deployed (720.0 s) | 7 (5 / 2 / 0 / 0) | 9 / 0 | 6.0 s – 600.0 s |

The log's feed lines (and the start, the jitter's end and the autopilot):

```text
+  0.0 s started {"track":"prompt","preset":"sniper","feed":"snapshot","pollMs":5000,"startJitterMs":13704}
+ 14.0 s jitter.done {"afterMs":14000}
+ 60.0 s autopilot.on {"preset":"sniper","idleMinutes":1,"silentMs":60000}
+ 95.0 s feed.backoff {"status":429,"reason":"HTTP 429"}
+105.0 s feed.stale {"failures":3,"status":429,"reason":"HTTP 429"}
+158.0 s feed.ok {"afterMs":63000,"failures":5}
+187.0 s snapshot.unavailable {"status":404,"fallback":"the indexer's /v1/events and /v1/board, at the same interval","recheckMinutes":10}
+787.0 s snapshot.available {"after":"the legacy reads"}
```

Notifications:

```text
+  0.0 s [demo] started: prompt mode; your agent decides; autopilot sniper after 1 min of silence
+ 60.0 s [demo] autopilot: your agent has been silent for 1 min: autopilot sniper trades until it acts
+105.0 s [demo] market: feast.meme's market data is not answering (HTTP 429): the agent decides on its last good read, marked stale, and asks again with a growing wait; its exits and the drawdown halt read the chain
```

<details><summary>Every request, in order</summary>

```text
+ 60.0 s GET /api/v1/snapshot → 200
+ 68.0 s GET /api/v1/snapshot → 304
+ 74.0 s GET /api/v1/snapshot → 200
+ 80.0 s GET /api/v1/snapshot → 200
+ 87.0 s GET /api/v1/snapshot → 304
+ 95.0 s GET /api/v1/snapshot → 429
+100.0 s GET /api/v1/snapshot → 429
+105.0 s GET /api/v1/snapshot → 429
+113.0 s GET /api/v1/snapshot → 429
+132.0 s GET /api/v1/snapshot → 429
+158.0 s GET /api/v1/snapshot → 200
+166.0 s GET /api/v1/snapshot → 200
+172.0 s GET /api/v1/snapshot → 200
+179.0 s GET /api/v1/snapshot → 304
+187.0 s GET /api/v1/snapshot → 404
+194.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAxNywiaSI6MH0&limit=200 → 200
+200.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAxOSwiaSI6MH0&limit=199 → 200
+208.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMCwiaSI6MH0&limit=198 → 200
+215.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMCwiaSI6MH0&limit=197 → 200
+223.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMSwiaSI6MH0&limit=196 → 200
+229.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMiwiaSI6MH0&limit=195 → 200
+237.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMiwiaSI6MH0&limit=194 → 200
+243.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyMywiaSI6MH0&limit=193 → 200
+249.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNCwiaSI6MH0&limit=192 → 200
+255.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNCwiaSI6MH0&limit=191 → 200
+261.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNSwiaSI6MH0&limit=190 → 200
+269.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNiwiaSI6MH0&limit=189 → 200
+276.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNiwiaSI6MH0&limit=188 → 200
+283.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyNywiaSI6MH0&limit=187 → 200
+291.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOCwiaSI6MH0&limit=186 → 200
+297.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOSwiaSI6MH0&limit=200 → 200
+304.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAyOSwiaSI6MH0&limit=199 → 200
+311.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMCwiaSI6MH0&limit=198 → 200
+317.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMSwiaSI6MH0&limit=197 → 200
+324.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMSwiaSI6MH0&limit=196 → 200
+330.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMiwiaSI6MH0&limit=195 → 200
+336.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMywiaSI6MH0&limit=194 → 200
+344.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzMywiaSI6MH0&limit=193 → 200
+352.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNCwiaSI6MH0&limit=192 → 200
+358.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNSwiaSI6MH0&limit=191 → 200
+366.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNSwiaSI6MH0&limit=190 → 200
+372.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNiwiaSI6MH0&limit=189 → 200
+380.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzNywiaSI6MH0&limit=188 → 200
+387.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzOCwiaSI6MH0&limit=187 → 200
+393.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzOCwiaSI6MH0&limit=186 → 200
+401.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDAzOSwiaSI6MH0&limit=200 → 200
+407.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MCwiaSI6MH0&limit=199 → 200
+415.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MCwiaSI6MH0&limit=198 → 200
+423.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MSwiaSI6MH0&limit=197 → 200
+431.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MiwiaSI6MH0&limit=196 → 200
+438.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MywiaSI6MH0&limit=195 → 200
+446.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0MywiaSI6MH0&limit=194 → 200
+452.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NCwiaSI6MH0&limit=193 → 200
+460.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NSwiaSI6MH0&limit=192 → 200
+468.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NiwiaSI6MH0&limit=191 → 200
+476.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NiwiaSI6MH0&limit=190 → 200
+483.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0NywiaSI6MH0&limit=189 → 200
+490.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OCwiaSI6MH0&limit=188 → 200
+496.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OSwiaSI6MH0&limit=187 → 200
+504.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA0OSwiaSI6MH0&limit=186 → 200
+512.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MCwiaSI6MH0&limit=200 → 200
+519.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MSwiaSI6MH0&limit=199 → 200
+525.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MSwiaSI6MH0&limit=198 → 200
+533.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MiwiaSI6MH0&limit=197 → 200
+541.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1MywiaSI6MH0&limit=196 → 200
+548.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NCwiaSI6MH0&limit=195 → 200
+555.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NCwiaSI6MH0&limit=194 → 200
+561.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NSwiaSI6MH0&limit=193 → 200
+569.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NiwiaSI6MH0&limit=192 → 200
+575.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NiwiaSI6MH0&limit=191 → 200
+582.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1NywiaSI6MH0&limit=190 → 200
+590.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OCwiaSI6MH0&limit=189 → 200
+598.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OSwiaSI6MH0&limit=188 → 200
+606.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA1OSwiaSI6MH0&limit=187 → 200
+613.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MCwiaSI6MH0&limit=186 → 200
+619.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MSwiaSI6MH0&limit=200 → 200
+626.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MSwiaSI6MH0&limit=199 → 200
+633.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MiwiaSI6MH0&limit=198 → 200
+641.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2MywiaSI6MH0&limit=197 → 200
+649.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NCwiaSI6MH0&limit=196 → 200
+655.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NCwiaSI6MH0&limit=195 → 200
+661.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NSwiaSI6MH0&limit=194 → 200
+668.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NiwiaSI6MH0&limit=193 → 200
+675.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NiwiaSI6MH0&limit=192 → 200
+681.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2NywiaSI6MH0&limit=191 → 200
+687.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OCwiaSI6MH0&limit=190 → 200
+695.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OCwiaSI6MH0&limit=189 → 200
+701.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA2OSwiaSI6MH0&limit=188 → 200
+709.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MCwiaSI6MH0&limit=187 → 200
+716.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MCwiaSI6MH0&limit=186 → 200
+723.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MSwiaSI6MH0&limit=200 → 200
+730.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MiwiaSI6MH0&limit=199 → 200
+738.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MywiaSI6MH0&limit=198 → 200
+745.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3MywiaSI6MH0&limit=197 → 200
+753.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NCwiaSI6MH0&limit=196 → 200
+759.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NSwiaSI6MH0&limit=195 → 200
+765.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NSwiaSI6MH0&limit=194 → 200
+773.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NiwiaSI6MH0&limit=193 → 200
+779.0 s GET /idx/v1/events?types=launch,trade&cursor=eyJiIjo1MDA3NywiaSI6MH0&limit=192 → 200
+787.0 s GET /api/v1/snapshot → 200
+795.0 s GET /api/v1/snapshot → 200
+802.0 s GET /api/v1/snapshot → 200
+808.0 s GET /api/v1/snapshot → 304
+814.0 s GET /api/v1/snapshot → 200
+821.0 s GET /api/v1/snapshot → 200
+827.0 s GET /api/v1/snapshot → 304
```

</details>

## What it shows

- **The start jitter.** Momentum's first read came at 29.0 s (jitter 28.5 s); the prompt agent's at 60.0 s, when its autopilot came on (60.0 s; jitter 13.7 s): with the autopilot off it reads nothing.
- **Steady.** Gaps between snapshot GETs 6.0 s–8.0 s (5–8 s drawn, then the loop's 1 s step); with If-None-Match, 4 of the steady reads were 304s.
- **The outage** (90.0 s–135.0 s). The wait after each 429, momentum: 5.0 s, 5.0 s, 8.0 s, 14.0 s, 31.0 s; the prompt agent: 5.0 s, 5.0 s, 8.0 s, 19.0 s, 26.0 s (attempt k waits 2 s × 2^k × U(0.75, 1.25), Retry-After: 5 raising the first ones to 5 s, never under 3 s; the last wait is the one the recovery ended, plus the loop's 1 s step). Each logged one `feed.backoff`, one `feed.stale` after its third failure, gave one notification, and one `feed.ok` with the outage's length. Meanwhile a strategy reads the last snapshot's rows with `stale` set (`feed/runtime.test.ts`), and L6, L8 and the inbox never wait on it.
- **The 404.** One `snapshot.unavailable` each, then the indexer's `/v1/events` at 6.0 s–8.0 s (the same interval; its `limit` cycling), and its board on momentum's ticks only. The recheck, 10 minutes on: momentum 181.0 s (404) then 782.0 s (200); prompt 187.0 s (404) then 787.0 s (200); `snapshot.available` once each, and the events go on from the legacy poller's cursor (the route was deployed at 720.0 s).

