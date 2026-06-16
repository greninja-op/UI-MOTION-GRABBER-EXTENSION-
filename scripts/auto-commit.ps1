# Auto-commit hook script for UI Motion Grabber.
# Stages all changes, commits with a timestamped message, and pushes to origin
# on the current branch. Exits cleanly (0) when there is nothing to commit.

$ErrorActionPreference = "Stop"

# Move to the repository root (script lives in <repo>/scripts).
Set-Location -Path (Join-Path $PSScriptRoot "..")

git add -A

# `git diff --cached --quiet` exits 0 when there are NO staged changes.
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Output "auto-commit: nothing to commit."
    exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
git commit -m "auto: kiro checkpoint $timestamp"

$branch = (git branch --show-current).Trim()
git push origin $branch

exit 0
