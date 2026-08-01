<p align="center">
  <img src="./profile/fleet-banner.jpg" alt="Agentic coding fleet" width="100%" />
</p>

<h1 align="center">Hi, I'm Jonathan Huang 👋</h1>

<p align="center">
  <strong>Airline pilot ✈️ &amp; former Sr. Software Engineer — now shipping code with a fleet of AI agents.</strong><br/>
  <sub>機師 × 軟體工程師,現在用一支 AI agent 艦隊把 code 交付出去。</sub>
</p>

<p align="center">
  <a href="https://www.linkedin.com/in/jonatw/"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white"></a>
  <a href="https://about.me/jonatw"><img src="https://img.shields.io/badge/about.me-jonatw-0057FF?style=flat-square&logo=aboutdotme&logoColor=white"></a>
  <img src="https://img.shields.io/badge/Based_in-Taiwan-lightgrey?style=flat-square">
  <img src="https://komarev.com/ghpvc/?username=jonatw&style=flat-square&color=blue&label=Profile+views">
  &nbsp;🇹🇼
</p>

---

### 🤖 From writing every line to orchestrating agents that do

I've shipped software since 2010. Over the past year my workflow changed shape:
I design the system, set the guardrails, and let **autonomous coding agents** handle
implementation, pull requests, reviews and infra — end to end. My recent commit
history is increasingly **agent-authored, human-reviewed**.

The point isn't fewer engineers — it's a **higher altitude**. I spend my time on
architecture and judgment; the mechanical work is delegated and verified.

```mermaid
flowchart LR
    J["🧑‍✈️ Jonathan<br/><sub>architecture · guardrails · review</sub>"]
    L["🦅 Lead agent<br/><sub>triage · dispatch</sub>"]
    subgraph FLEET["🤖 Executor agents"]
      direction TB
      A["Feature<br/>agent"]
      B["Infra / IaC<br/>agent"]
      C["Data &amp; backtest<br/>agent"]
      D["Quality / CI<br/>agent"]
    end
    J -- intent & guardrails --> L
    L -- tickets --> FLEET
    A --> O["📦 PRs · deploys<br/>pipelines · green CI"]
    B --> O
    C --> O
    D --> O
    O -- review & merge --> J
```

Two layers: a **lead agent** that triages and opens the tickets, and **executor
agents** that pick them up, write the code, open PRs and review each other. I set
the guardrails, read the diffs, and land the plane.

📖 **[flightdeck](https://github.com/jonatw/flightdeck)** — how it's wired, how
work gets dispatched, and where the human stays in the loop. Written down so it's
less of a black box.

---

### 🛠️ Built with

![JavaScript](https://img.shields.io/badge/JavaScript-323330?style=flat-square&logo=javascript&logoColor=F7DF1E)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?style=flat-square&logo=amazonaws&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat-square&logo=playwright&logoColor=white)

---

### 📌 Selected work

- **[flightdeck](https://github.com/jonatw/flightdeck)** — field log of running a fleet of AI coding agents in production
- **[1min-cloudflare-gateway](https://github.com/jonatw/1min-cloudflare-gateway)** — high-performance Cloudflare Workers API gateway
- **[apple-store-scrape](https://github.com/jonatw/apple-store-scrape)** — cross-region Apple price comparison (Python + Workers)
- **[pdf-processor](https://github.com/jonatw/pdf-processor)** — browser-side PDF toolchain (PyMuPDF → WASM)
- **[finlab-txd](https://github.com/jonatw/finlab-txd)** — quantitative trading research on Taiwan index futures

---

### 📊 How my code actually gets written

<p align="center">
  <img src="./metrics/agentic-coding.svg" alt="Who ships the code — commits, lines, pull requests and issues broken down by how autonomously they were produced, last 90 days" width="760" />
</p>

The **delegated** slice is genuinely the fleet's work — not mine with extra steps.
The **paired** slice is mine: git records me as the author and Claude as
co-author, because that's what happened — I was on the controls for every turn.

<sub align="center">Self-hosted, auto-updated daily. Aggregate counts across every repo I own, public and private — no repository names and no agent account names are ever emitted. Commits classified by author identity &amp; co-author trailers; PRs and issues by who opened them.</sub>

<p align="center">
  <img src="https://streak-stats.demolab.com/?user=jonatw&hide_border=true" />
</p>
