---
name: ship
description: Ship — run checks, bump version, changelog, push, create PR.
---

# Ship

Automated shipping workflow. Runs checks, bumps version, updates changelog, pushes, creates PR.

## Pre-flight

1. **Verify branch:** Must not be the release base branch (commonly main/master). If it is, stop and tell the user; if the base is not yet known, resolve it in Step 4 before changing anything.

```bash
git branch --show-current
```

2. **Check for uncommitted changes:**

```bash
git status --short
```

If there are uncommitted changes, ask the user: commit them first, or stash?

3. **Run the project's check command** (prefer `make check` when present):

```bash
make check
```

If checks fail, **stop**. Fix the issues first. Do not proceed with failing tests.

## Resolve and Merge the Base

4. **Resolve one base branch and remote ref.** Use the user-supplied/PR target when available; otherwise derive it from `origin/HEAD` or ask if ambiguous. Do not assume `main` or `master`. Record `BASE_BRANCH` and use `BASE_REF="origin/$BASE_BRANCH"` consistently below.

Fetch and merge that base only because invoking this shipping workflow is explicit authorization for its network shipping steps:

```bash
git fetch origin "$BASE_BRANCH"
git merge "$BASE_REF"
```

If there are merge conflicts, show them and **stop**. The user needs to resolve these.

5. **Re-test after merge** with the same project check command:

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
git log "$BASE_REF"..HEAD --oneline --no-merges
```

Format as:
```markdown
## [version] - YYYY-MM-DD

- Summary of changes (grouped by type if many commits)
```

Prepend to `CHANGELOG.md`.

Follow an existing changelog heading convention. If there is no `VERSION` file and no established convention, use `## Unreleased - YYYY-MM-DD` instead of an undefined version.

8. **Commit only release files that exist and actually changed.** Build the staging list from `VERSION` and `CHANGELOG.md`; if neither changed, skip the release commit. Do not run an unconditional `git add VERSION CHANGELOG.md`.

```bash
release_files=()
for file in VERSION CHANGELOG.md; do
  if [[ -f "$file" ]] && ! git diff --quiet -- "$file"; then
    release_files+=("$file")
  fi
done
if (( ${#release_files[@]} )); then
  git add -- "${release_files[@]}"
  git commit -m "chore: update release metadata"
fi
```

## Documentation Sync

9. **Update docs if needed:**

Check whether the project's established documentation describes code changed on this branch:

```bash
git diff "$BASE_REF"...HEAD --name-only
```

If yes, use `/skill:update-docs` with this base range and commit only the approved documentation updates.

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
- [ ] `<project check command>` passes
- [ ] <specific test scenarios>
EOF
)"
```

Title: derive from branch name or first commit message. Keep under 70 chars.

12. **Output:** Print the PR URL.
