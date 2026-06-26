# AGENTS.md

## Shell and Encoding

- Prefer PowerShell 7 (`pwsh`) for all commands in this repository.
- Avoid Windows PowerShell 5.1 for Japanese text inspection because it can display UTF-8 files as mojibake even when the files are valid.
- Keep console input/output fixed to UTF-8 before reading or printing Japanese text:

```powershell
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null
```

- When writing text files from PowerShell, explicitly use UTF-8:

```powershell
Set-Content -Encoding utf8 <path> <content>
Out-File -Encoding utf8 <path>
```

- If terminal output looks broken, verify the file with Node.js or an editor before assuming the source file is corrupted.
- Do not fix apparent mojibake by rewriting source files unless the bytes on disk are confirmed to be wrong.

