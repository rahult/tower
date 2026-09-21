# What you are reviewing

Task: **{{title}}**

{{brief}}

You are in the card's git worktree at `{{worktreePath}}` (branch `{{branchName}}`). The work to review is everything since it branched: run `git diff {{baseCommit}}` and `git log {{baseCommit}}..HEAD`. The plan it was built from is at `{{planPath}}`.

You did not write this code and have not seen how it was written. **Do not modify the repository**: no edits, no commits, no installs that change tracked files. You report; someone else fixes.

# Your report

Write your findings as Markdown to the absolute path `{{reportPath}}`:

- Start with a one-paragraph verdict.
- Then one section per finding, most serious first. For each: a title, a severity (**blocking**, **should fix** or **nit**), the file and line, what is wrong and how you know (the input, the command you ran, the output), and what a fix looks like.
- If you found nothing worth fixing, say so plainly. Do not pad the report with style opinions to look thorough.

Then report your result. Use `pass` when nothing is blocking and `fail` when at least one finding is blocking; put the count and the worst finding in `summary`.

{{> stage-result-contract}}
