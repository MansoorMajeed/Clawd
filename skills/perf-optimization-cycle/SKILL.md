---
name: perf-optimization-cycle
description: "Structured performance optimization workflow: edit, benchmark, compare, decide (keep/revert). Prevents common anti-patterns like over-tuning, re-deriving known results, and missing reverts."
---

# Performance Optimization Cycle

Disciplined workflow for performance optimization that prevents wasted effort and ensures every change is measured.

## Before Starting

1. **Check project memory files** for previous optimization results. Do NOT re-try approaches already marked as failed or ineffective.
2. **Establish baseline** by running the benchmark 3 times and recording the median.
3. **Identify the target**: which function/section, what metric (latency, throughput), what's the goal.

## The Cycle

For each optimization attempt, follow this exact sequence:

### 1. Hypothesize (1-2 sentences max)
State what you expect to improve and roughly why. If you can't articulate a clear hypothesis, stop and think more before coding.

### 2. Edit
Make the minimal change to test the hypothesis. One concept per attempt — do NOT bundle multiple ideas.

### 3. Verify Correctness
Run `cargo test` (or equivalent). If tests fail, fix or revert immediately. Never benchmark broken code.

### 4. Benchmark
Run the benchmark 3 times, record all 3 results and the median. Use the same benchmark command every time within a session.

### 5. Compare & Decide
- **> 2% improvement**: Keep. Record in memory/journal.
- **< 2% or within noise**: Revert with `git checkout -- <files>`. Record as "no measurable effect" in memory.
- **Regression**: Revert immediately. Record the regression amount in memory.

### 6. Record
After each attempt, update the project memory file with:
```
- <description>: <before>ms → <after>ms (<percent>%) — kept/reverted
```

## Anti-Patterns to Avoid

- **Over-tuning**: Once you hit the target or plateau (3 consecutive no-effect results), STOP. Diminishing returns are real.
- **Re-deriving**: If MEMORY.md says "X was tried and failed", do NOT try X again unless you have a specific new reason.
- **Bundling**: One change per cycle. If you change two things and get a speedup, you don't know which one helped.
- **Analysis paralysis**: Limit thinking to ~2 minutes per hypothesis. If you're unsure, just try it and measure.
- **Forgetting to revert**: If a change doesn't help, revert it before trying the next idea. Stacking neutral changes adds complexity.
- **Benchmark noise**: If results vary > 5% across 3 runs, something is wrong (background load, thermal throttling). Wait and re-run.

## Assembly Analysis (Optional)

Only look at assembly when:
- You have a specific theory about what the compiler is doing
- You've already exhausted algorithmic improvements
- The benchmark shows the function is clearly the bottleneck

Use: `cargo asm --rust qoaudio::function_name` or equivalent disassembly tool.

## Session Checklist

At the end of an optimization session:
- [ ] All reverts applied for failed attempts
- [ ] Memory file updated with all results (wins AND losses)
- [ ] Code compiles and all tests pass
- [ ] `cargo fmt` applied
- [ ] Changes committed with `perf:` prefix
