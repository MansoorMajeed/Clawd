# Experimental archive

These extensions are preserved for reference, **disabled by default and unsupported**. The package discovers only the root `extensions/` and `skills/` directories. Nothing in this archive is automatically loaded.

Archived: `ai-knowledge`, `journal-advisor`, `continue`, `handoff`, `control`, `loop`, `answer`, `todos`, `todos-status`, and `prompt-editor`.

Known problems include lost concurrent journal entries, overwritten continuation artifacts, stale Pi APIs, isolated task state, and TUI/RPC lifecycle assumptions. Moving the code here does not fix these problems. Existing dedicated tests are preserved under `experimental/tests/` but excluded from the active `make check` suite; passing them would not establish current-Pi compatibility.

No user vaults, sessions, todo files, or mode settings were deleted or moved. The active `/clear` command only reminds users to use native `/new`; it does not alias `/new` or change the current session. Native edit replaces the removed `multi-edit` override (without cross-file batches or Codex patches).

Original attribution remains in the source and root README. Restore or explicitly load archived code only after addressing its known defects and checking the supported Pi version.
