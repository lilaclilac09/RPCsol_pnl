# Unified Apples-to-Apples Leaderboard

Generated: 2026-04-13T05:10:25.935Z
Repeats per candidate: 6

| Rank | Candidate | Mean Score | Std | P50 | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | V4 PRIME | 0.5733 | 0.0474 | 0.5812 | 1756.4 | 1949.9 | 16.0 | 1.00 |
| 2 | V3 Bayesian | 0.5547 | 0.0812 | 0.5535 | 1842.5 | 2189.8 | 22.0 | 1.00 |
| 3 | V4 Bayesian | 0.4102 | 0.0668 | 0.4060 | 2502.5 | 2577.3 | 16.0 | 1.00 |
| 4 | V2 Bayesian | 0.3549 | 0.0561 | 0.3714 | 2914.1 | 2824.0 | 16.0 | 1.00 |
| 5 | V2 Codex SA | 0.3312 | 0.0353 | 0.3165 | 3052.3 | 3384.6 | 18.0 | 1.00 |
| 6 | V3 PRIME | 0.3249 | 0.1147 | 0.3317 | 3534.7 | 5115.2 | 26.0 | 1.00 |
| 7 | V8 Bayesian | 0.3079 | 0.1265 | 0.2688 | 3993.2 | 4479.0 | 21.0 | 1.00 |
| 8 | Codex blockTime BO | 0.1500 | 0.0605 | 0.1247 | 7647.2 | 8438.3 | 214.0 | 1.00 |
| 9 | Codex blockTime default | 0.1286 | 0.0427 | 0.1131 | 8559.7 | 10887.3 | 127.0 | 1.00 |

## Failure Modes

### V2 Bayesian
- score<0.4 on 6/6 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### V2 Codex SA
- score<0.4 on 6/6 runs
- median score below 0.45 in current conditions

### V3 Bayesian
- high score variance (std > 0.08)

### V3 PRIME
- score<0.4 on 5/6 runs
- latency jitter >1.5x between min/max runs
- high score variance (std > 0.08)
- median score below 0.45 in current conditions

### V4 Bayesian
- score<0.4 on 2/6 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### V4 PRIME
- no major instability in sampled repeats

### V8 Bayesian
- score<0.4 on 4/6 runs
- latency jitter >1.5x between min/max runs
- high score variance (std > 0.08)
- median score below 0.45 in current conditions

### Codex blockTime default
- score<0.4 on 6/6 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### Codex blockTime BO
- score<0.4 on 6/6 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions