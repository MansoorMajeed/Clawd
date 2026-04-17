---
name: irreversible-action-checklist
description: "This skill should be used when about to perform an irreversible or hard-to-undo action on a device, system, or production environment. Trigger when deploying payloads, flashing firmware, writing to hardware, modifying boot sequences, overwriting files on embedded devices, sending destructive USB commands, triggering device reboots with staged changes, or any action where failure means bricking or requiring physical recovery. Also applies to database migrations, production deployments, and any 'point of no return' operation."
---

# Irreversible Action Checklist

Prevent bricking devices, corrupting systems, and creating unrecoverable states by enforcing verification gates before any action that cannot be easily undone.

## When This Skill Applies

This skill activates before any operation where:
- A failure means physical access, specialized tools, or expert intervention to recover
- The target system cannot be easily restored to its prior state
- The action deploys code, firmware, or configuration to a device or production system
- A reboot or restart will activate staged changes
- The change affects boot sequences, shared libraries, or init scripts

## Core Principle: Evidence Before Action

Never assume. Never skip verification. Never document success before confirming it.

## The Checklist

Execute these gates **in order** before performing the irreversible action. Each gate must pass before proceeding to the next. If any gate fails, STOP and resolve it before continuing.

### Gate 1: Understand the Interface Contract

Before replacing, modifying, or deploying any artifact:

- **List all consumers** of the artifact being modified (binaries, services, scripts that load/use it)
- **Verify the interface** the consumers expect (symbol exports, file format, config schema, API endpoints)
- **Confirm the replacement satisfies the contract** by checking against the original

For shared libraries: run `readelf --dyn-syms` (or equivalent) on the original and verify the replacement exports every required symbol.
For config files: validate against the schema or parser that will consume it.
For firmware: verify checksums, signatures, and partition layout match expectations.

### Gate 2: Verify Rollback Path Exists

Before deploying, confirm a concrete way to undo the change:

- **Document the exact rollback procedure** (not "we can undo it later" but the specific commands/steps)
- **Test the rollback mechanism works** if possible (mount the volume, verify write access, confirm tools exist)
- **Identify the recovery time window** -- how long after deployment can rollback still happen?
- **If no rollback exists**, escalate to the user and explain the risk explicitly

Examples of rollback verification:
- **Git (code changes)**: Before making destructive changes, ensure the working tree is clean (`git status`) and commit or stash any uncommitted work -- `git reset --hard` destroys uncommitted changes permanently. Prefer working on a **dedicated branch** (`git checkout -b pre-<action>`) over `git reset` as the rollback mechanism: branches preserve history and don't risk losing other work. Use `git revert <commit>` (creates a new undo commit) instead of `git reset --hard` when the changes have already been pushed or when other commits exist on top. Only use `git reset --hard` on local unpushed work where nothing else has been committed after the rollback point. Always run `git stash list` and `git log --oneline -5` before any reset to confirm nothing will be lost.
- USB mass storage: mount it, write a test file, read it back, delete it
- Network access: confirm the port is open, auth works, write/delete test file
- Firmware: confirm dual-partition layout, verify inactive partition is bootable

### Gate 3: Preflight the Deployment

Simulate or verify the deployment without committing:

- **Dry-run the exact deployment steps** if the system supports it
- **Verify file sizes, checksums, and permissions** match expectations
- **Confirm the target path is correct** (read back what is currently there)
- **Check disk space** on the target

### Gate 4: Ask Before Executing

Present the user with a clear summary before the point of no return:

```
IRREVERSIBLE ACTION SUMMARY:
- Action: [what will happen]
- Target: [device/system/path]
- Artifact: [file/config/firmware being deployed]
- Interface contract: [verified/not verified] -- [details]
- Rollback: [how to undo] -- [tested/untested]
- Risk if failure: [what breaks]

Proceed? [requires explicit user confirmation]
```

### Gate 5: Verify Immediately After

After executing, verify the outcome **before** doing anything else:

- **Confirm the action succeeded** by checking the target state directly (not by inferring)
- **Test the expected behavior** (service responds, port opens, device boots)
- **Wait for the full cycle** (reboot completes, service restarts, init finishes)
- **Never document success until verified** -- update status/docs only after confirmed working

## Anti-Patterns to Avoid

| Anti-Pattern | Consequence | Correct Approach |
|---|---|---|
| Deploy without checking interface contract | Service crashes, boot loop | Gate 1: verify all consumers and exports |
| "We can fix it after reboot" | Device unreachable after reboot | Gate 2: test rollback before deploying |
| Update docs claiming success before verification | False records, confusion | Gate 5: verify first, document after |
| Send multiple destructive commands hoping one works | Unpredictable state | One action at a time, verify each |
| Assume the replacement is compatible | Missing symbols, wrong format | Gate 1: compare original vs replacement |
| Skip user confirmation on hardware actions | Bricked device | Gate 4: always ask |

## Quick Reference for Common Scenarios

### Deploying a Shared Library to Embedded Device

1. `readelf --dyn-syms original.so` -- capture all exports
2. Build replacement, run `readelf --dyn-syms replacement.so` -- compare
3. Verify SONAME matches: `readelf -d replacement.so | grep SONAME`
4. Mount target filesystem, verify current state
5. Confirm rollback: can the original be restored after reboot?
6. Present summary to user, get confirmation
7. Deploy, reboot, verify service starts

### Triggering a Device Reboot with Staged Changes

1. Verify staged files are correct (checksums, permissions, paths)
2. Confirm the boot sequence will find and use the staged files
3. Document what the device should do on next boot
4. Confirm rollback: can staged files be removed if boot fails?
5. Present summary to user, get confirmation
6. Trigger reboot, monitor boot process if possible
7. Verify device reaches expected state

### Destructive Code Changes (Refactors, Migrations, Large Rewrites)

1. Ensure working tree is clean: `git status` -- if dirty, commit or `git stash` first
2. Check for stashed work: `git stash list` -- note any stashes that could be affected
3. Create a rollback branch: `git checkout -b pre-<action>-backup` then switch back
4. Verify: `git log --oneline -5` to confirm the backup branch/commit exists
5. Make the changes on a working branch
6. Verify the result compiles/passes tests before merging
7. If broken: `git checkout pre-<action>-backup` -- the safe state is intact on its own branch

**Never use `git reset --hard` if:**
- There are uncommitted changes (they will be permanently lost)
- Other commits exist after the rollback target (they will be removed from history)
- The commits have been pushed (use `git revert` instead to preserve shared history)

### Writing to Device Flash/eMMC

1. Read current contents, save backup
2. Verify write tool and parameters
3. Confirm target partition/offset is correct
4. Present summary to user, get confirmation
5. Write, read back, compare to expected

## Additional Resources

### Reference Files

For detailed case studies and failure analysis from real sessions:
- **`references/case-studies.md`** -- Documented failures and what went wrong
