# Codex Apples-to-Apples Leaderboard

Generated: 2026-04-13T04:08:09.024Z
Repeats per method: 5

| Rank | Method | Mean Score | Std | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness | Key config |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | Simulated Annealing | 0.4613 | 0.0589 | 2205.7 | 2345.7 | 18.0 | 1.00 | anchor=80 window=70 c=6 oracle=on skipZero=off |
| 2 | Differential Evolution | 0.4009 | 0.0427 | 2522.7 | 2753.9 | 24.0 | 1.00 | anchor=54 window=45 c=10 oracle=on skipZero=off |
| 3 | TPE-style | 0.3493 | 0.0572 | 2942.6 | 3433.9 | 18.0 | 1.00 | anchor=66 window=72 c=16 oracle=on skipZero=off |

## Per-method failure modes

### TPE-style
- Score degradation (<0.4) on 4/5 runs

### Differential Evolution
- Score degradation (<0.4) on 3/5 runs

### Simulated Annealing
- Score degradation (<0.4) on 1/5 runs