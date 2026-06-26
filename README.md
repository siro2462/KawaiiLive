# KawaiiLive

Local VTuber-style chat/radio prototype using Ollama and Irodori TTS.

## Start

```powershell
.\start-control-panel.cmd
```

The launcher uses the bundled portable PowerShell 7 at
`work\tools\PowerShell\pwsh.exe` when available, with console I/O fixed to UTF-8.
Windows Terminal should use the `KawaiiLive PowerShell 7` profile by default.

GUI:

```text
http://127.0.0.1:14520
```

## Structure

```text
app/
  web/                     control panel UI
  api/                     local HTTP API
  core/                    runtime, generation, memory, TTS, talk core
  scripts/                 app-specific checks and evaluation
assets/                    source assets, transcripts, Live2D models
data/                      SQLite databases and runtime logs
library/                   external libraries such as Irodori
work/                      temporary files
docs/                      notes and specs
scripts/                   root execution and maintenance commands
node_modules/              npm dependencies
```

## Evaluation

```powershell
npm.cmd run radio:evaluate -- 10
npm.cmd run radio:analyze -- data\logs\generated-talk.jsonl 10
```
