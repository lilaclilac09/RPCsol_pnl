# Unified Apples-to-Apples Leaderboard

Generated: 2026-04-13T06:10:56.722Z
Repeats per candidate: 4

| Rank | Candidate | Mean Score | Std | P50 | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | V4 PRIME | 0.6246 | 0.0698 | 0.5871 | 1620.3 | 1703.2 | 16.0 | 1.00 |
| 2 | V10 Bayesian | 0.5963 | 0.0921 | 0.5127 | 1717.6 | 1950.5 | 18.0 | 1.00 |
| 3 | V11 Bayesian | 0.5955 | 0.0458 | 0.5649 | 1688.4 | 1770.3 | 29.8 | 1.00 |
| 4 | V4 Bayesian | 0.5768 | 0.0605 | 0.5697 | 1753.5 | 1755.4 | 16.0 | 1.00 |
| 5 | V3 PRIME | 0.5584 | 0.0701 | 0.5331 | 1817.1 | 1875.8 | 26.0 | 1.00 |
| 6 | V3 Bayesian | 0.3955 | 0.1139 | 0.4004 | 2829.2 | 2497.7 | 22.0 | 1.00 |
| 7 | V8 Bayesian | 0.3699 | 0.0146 | 0.3595 | 2707.6 | 2781.3 | 21.0 | 1.00 |
| 8 | V2 Bayesian | 0.3506 | 0.0473 | 0.3614 | 2913.7 | 2767.4 | 16.0 | 1.00 |
| 9 | Codex blockTime BO | 0.2489 | 0.0528 | 0.2506 | 4240.8 | 3991.0 | 214.0 | 1.00 |
| 10 | Codex blockTime default | 0.2008 | 0.0504 | 0.1860 | 5297.0 | 5376.1 | 127.0 | 1.00 |
| 11 | V2 Codex SA | 0.1990 | 0.1111 | 0.0937 | 7272.6 | 10674.5 | 18.0 | 1.00 |

## Failure Modes

### V2 Bayesian
- score<0.4 on 4/4 runs
- median score below 0.45 in current conditions

### V2 Codex SA
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- high score variance (std > 0.08)
- median score below 0.45 in current conditions

### V3 Bayesian
- score<0.4 on 1/4 runs
- latency jitter >1.5x between min/max runs
- high score variance (std > 0.08)
- median score below 0.45 in current conditions

### V3 PRIME
- no major instability in sampled repeats

### V4 Bayesian
- no major instability in sampled repeats

### V4 PRIME
- no major instability in sampled repeats

### V8 Bayesian
- score<0.4 on 4/4 runs
- median score below 0.45 in current conditions

### V10 Bayesian
- high score variance (std > 0.08)

### V11 Bayesian
- no major instability in sampled repeats

### Codex blockTime default
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions

### Codex blockTime BO
- score<0.4 on 4/4 runs
- latency jitter >1.5x between min/max runs
- median score below 0.45 in current conditions