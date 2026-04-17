---
name: ship
description: Ship — run checks, bump version, changelog, push, create PR.
---

# Ship

Automated shipping workflow. Runs checks, bumps version, updates changelog, pushes, creates PR.

## Pre-flight

1. **Verify branch:** Must NOT be on main/master. If on main, stop and tell the user.

```bash
git branch --show-current
```

2. **Check for uncommitted changes:**

```bash
git status --short
```

If there are uncommitted changes, ask the user: commit them first, or stash?

3. **Run checks:**

```bash
make check
```

If checks fail, **stop**. Fix the issues first. Do not proceed with failing tests.

## Merge Base

4. **Pull latest main and merge:**

```bash
git fetch origin main
git merge origin/main
```

If there are merge conflicts, show them and **stop**. The user needs to resolve these.

5. **Re-test after merge:**

```bash
make check
```

Code changed after the merge — tests might break. If they fail, stop.

## Version & Changelog

6. **Version bump** (only if `VERSION` file exists):

Look at commit messages on this branch to suggest a version bump:
- `fix:` commits → suggest **patch**
- `feat:` commits → suggest **minor**
- Breaking changes → suggest **major**

Ask the user to confirm the bump level. Update the `VERSION` file.

7. **Changelog** (only if `CHANGELOG.md` exists):

Generate a changelog entry from commits on this branch:

```bash
git log main..HEAD --oneline --no-merges
```

Format as:
```markdown
## [version] - YYYY-MM-DD

- Summary of changes (grouped by type if many commits)
```

Prepend to `CHANGELOG.md`.

8. **Commit version + changelog:**

```bash
git add VERSION CHANGELOG.md
git commit -m "chore: bump version to X.Y.Z and update changelog"
```

## Documentation Sync

9. **Update docs if needed:**

Quick check — do any `llm-context/` files describe code that was changed on this branch?

```bash
git diff main --name-only
```

If yes: update the stale llm-context files and the CLAUDE.md index. Commit the doc updates.

## Push & PR

10. **Push:**

```bash
git push -u origin $(git branch --show-current)
```

Never force push. If push fails, show the error and stop.

11. **Create PR:**

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
- <bullet points summarizing changes>

## Test Plan
- [ ] `make check` passes
- [ ] <specific test scenarios>
EOF
)"
```

Title: derive from branch name or first commit message. Keep under 70 chars.

12. **Output:** Print the PR URL.
