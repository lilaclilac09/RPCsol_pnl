# Unified Apples-to-Apples Leaderboard

Generated: 2026-04-13T04:58:24.762Z
Repeats per candidate: 4

| Rank | Candidate | Mean Score | Std | P50 | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | V3 PRIME | 0.5019 | 0.0450 | 0.5004 | 2009.8 | 1998.3 | 26.0 | 1.00 |
| 2 | V4 Bayesian | 0.4552 | 0.1403 | 0.4767 | 2549.8 | 2097.9 | 16.0 | 1.00 |
| 3 | V4 PRIME | 0.4549 | 0.0515 | 0.4463 | 2227.7 | 2240.7 | 16.0 | 1.00 |
| 4 | V3 Bayesian | 0.4231 | 0.0741 | 0.3674 | 2436.9 | 2722.2 | 22.0 | 1.00 |
| 5 | V2 Bayesian | 0.3926 | 0.0383 | 0.3583 | 2571.8 | 2791.1 | 16.0 | 1.00 |
| 6 | V2 Codex SA | 0.3765 | 0.0323 | 0.3518 | 2674.8 | 2842.3 | 18.0 | 1.00 |
| 7 | V8 Bayesian | 0.3090 | 0.0674 | 0.3386 | 3453.1 | 2953.4 | 21.0 | 1.00 |
| 8 | Codex blockTime BO | 0.1950 | 0.0405 | 0.2002 | 5391.6 | 4994.3 | 214.0 | 1.00 |
| 9 | Codex blockTime default | 0.1462 | 0.0364 | 0.1263 | 7330.3 | 7916.6 | 127.0 | 1.00 |

## Failure Modes

### V2 Bayesian
- score<0.4 on 2/4 runs
- median score below 0.45 in current conditions

### V2 Codex SA
- score<0.4 on 3/4 runs
- median score below 0.45 in current conditions

### V3 Bayesian
- score<0.4 on 2/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### V3 PRIME
- no major instability in sampled repeats

### V4 Bayesian
- score<0.4 on 1/4 runs
- latency jitter >1.5x between min/max runs
- high score variance (std > 0.08)

### V4 PRIME
- score<0.4 on 1/4 runs
- median score below 0.45 in current conditions

### V8 Bayesian
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### Codex blockTime default
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### Codex blockTime BO
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions