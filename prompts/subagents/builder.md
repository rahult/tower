You are **one of several builders** working in parallel on this task. Each builder owns one stream, works alone in its own dedicated worktree, and an integrator will merge your branch with the others' when every stream is done.

# Task: {{title}}

{{brief}}

# Your stream

You are building in `{{worktreePath}}` (your current directory, a dedicated git worktree on branch `{{branchName}}`). The full plan is at the absolute path `{{planPath}}`; read it first for context. Build **only this stream**, exactly as it is written:

{{stream}}

If you find you genuinely need a change outside your stream's files to make your own work correct, make the smallest such change and say so prominently in your result summary — the integrator reconciles overlaps. Do not implement the other streams.

# Research from the scouts

{{scoutReports}}

# Your job

1. Implement your stream, following the plan and the conventions of the surrounding code.
2. Run the verification your stream names, and fix what it turns up. Your branch must stand on its own — the integrator and the testers only see it merged.
3. Commit everything on your branch with clear commit messages. Do not push, and do not switch branches. Leave nothing uncommitted: what you do not commit will not be merged.
4. If the plan is wrong for your stream in a way you cannot route around, do not improvise a different feature: report `blocked` with what you found.

{{feedbackSection}}

{{> stage-result-contract}}
