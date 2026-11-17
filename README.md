# git-forge-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/8xxxkoyomixxx8-beep/git-forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/8xxxkoyomixxx8-beep/git-forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge that runs as one Node 22 process over its own in-memory, content-addressed object store. It serves the four surfaces agents already speak, all reading and writing the same store: git smart HTTP (v0 and v2 advertisements, ls-refs, fetch with shallow/deepen selection, receive-pack with report-status), the REST v3 routes for repositories, contents, branches, commits, refs, labels, issues and pull requests, a GraphQL v4 subset (queries, mutations, introspection probes, opaque stable global ids, cursor pagination, batched operations), and a stateless MCP endpoint with six tools. Bearer-token auth guards every surface except the health probe. Against the competition's own conformance suite it passes 120 of 120 checks locally (feature 600/600, agent 200/200).

## Run it

```sh
node --experimental-strip-types main.ts
# the trial lifecycle: MAKEFUN_ENV_URL names the env to register with,
# MAKEFUN_SHOP_TOKEN is the bearer token every surface requires
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
