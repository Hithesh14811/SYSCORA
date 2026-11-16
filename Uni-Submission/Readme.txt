Readme.txt

PROJECT TITLE
SYSCORA: An Intent-Aware Semantic Modeling and Predictive Execution Framework
for Autonomous Operating System Management

TEAM NUMBER      : ______
TEAM MEMBERS
  1. Hithesh D Shetty   USN: 4CB23AI034
  2. Nishal K           USN: 4CB23AI060
PROJECT GUIDE    : Mr. Vinod Kumar B, Assistant Professor, Dept. of AI & ML
DEPARTMENT       : Artificial Intelligence and Machine Learning,
                   Canara Engineering College, Mangaluru (VTU), 2026-27

SYSTEM NUMBER IN AIL06 WHERE THE PROJECT IS INSTALLED : ______

PROJECT DESCRIPTION
SYSCORA is a Windows 11 agent that takes requests by text or voice, operates
real applications (through UI Automation, OCR and a controlled browser) and
reports success only when a different capability has independently verified
the outcome. Risky actions are classified ALLOW / ASK / DENY and wait for the
user's approval. It is an Electron application with a local Node.js server.

SOFTWARE / LINKS
  Source code : https://github.com/Hithesh14811/SYSCORA
  Requires    : Windows 11, Node.js (LTS), PowerShell 5.1, Git, an LLM API key
                (configured in .syscora/, never committed)
  Install     : npm install
  Run (web UI): npm run mvp:ui   (opens on http://127.0.0.1:4317)
  Run (desktop): npm run desktop:dev
  Tests       : npm test
  Evaluation  : npm run eval   (npm run eval -- --mock runs without a model)

EXECUTABLE CODE
  JavaScript (.js) / Node.js, PowerShell host scripts (.ps1).
  Entry points: apps/daemon/src/server.js (server), apps/desktop (UI),
  packages/fast-agent/src/index.js (agent loop).

DATASET USED
  None. The project does not train a model; it calls a hosted LLM.

DATASET GENERATED
  No ML dataset. For evaluation, a 24-task suite run against the real machine
  (tests/eval/, results described in the report) was created. It was run three
  times (median 4.7 s per task, 96% of rows passed every run) and also with
  injected faults to measure false success claims (0% with SYSCORA).

REPORT
  Report_Syscora.pdf (included in this folder)
