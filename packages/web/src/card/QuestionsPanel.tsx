import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client.ts";
import { button, field } from "../ui.ts";

interface Question {
	question: string;
	options: string[];
}

const OWN = "__own__";

/**
 * What the agent needs decided, as questions you answer with a click. The first option is the agent's suggestion.
 * Sending the answers continues the same session, so nothing it has already worked out is lost.
 * Lives in the card drawer by default; `className` re-homes it, e.g. inside a Focus row.
 */
export function QuestionsPanel({ cardId, summary, questions, className }: { cardId: string; summary: string | null; questions: Question[]; className?: string }) {
	const [picked, setPicked] = useState<Record<number, string>>({});
	const [own, setOwn] = useState<Record<number, string>>({});
	const answerTo = (index: number) => (picked[index] === OWN || questions[index]?.options.length === 0 ? (own[index] ?? "").trim() : (picked[index] ?? ""));
	const complete = questions.every((_question, index) => answerTo(index) !== "");
	const send = useMutation({ mutationFn: () => api.answer(cardId, questions.map((q, index) => ({ question: q.question, answer: answerTo(index) }))) });

	return (
		<form
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				if (complete) send.mutate();
			}}
			className={className ?? "flex max-h-[70%] shrink-0 flex-col border-b border-rule"}
		>
			{summary && (
				<p className="shrink-0 bg-caution-soft px-4 py-2 text-[14px]">The agent stopped to ask{questions.length === 1 ? " a question" : ` ${questions.length} questions`}. {summary}</p>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				<ol className="flex flex-col gap-5">
					{questions.map((q, index) => (
						<li key={q.question}>
							<fieldset>
								<legend className="mb-2 font-semibold">
									<span className="mr-1.5 text-slate">{index + 1}.</span>
									{q.question}
								</legend>
								<div className="flex flex-col gap-1.5">
									{q.options.map((option, optionIndex) => (
										<Choice key={option} name={`q${index}`} checked={picked[index] === option} onPick={() => setPicked({ ...picked, [index]: option })}>
											{option}
											{optionIndex === 0 && <span className="ml-2 rounded bg-primary-soft px-1.5 py-px text-[12px] font-semibold text-primary">Suggested</span>}
										</Choice>
									))}
									{q.options.length > 0 && (
										<Choice name={`q${index}`} checked={picked[index] === OWN} onPick={() => setPicked({ ...picked, [index]: OWN })}>
											Something else
										</Choice>
									)}
									{(picked[index] === OWN || q.options.length === 0) && (
										<textarea
											autoFocus={q.options.length > 0}
											value={own[index] ?? ""}
											onChange={(event) => setOwn({ ...own, [index]: event.target.value })}
											rows={2}
											aria-label={`Your answer to: ${q.question}`}
											placeholder="Your answer"
											className={`${field} mt-0.5 resize-y`}
										/>
									)}
								</div>
							</fieldset>
						</li>
					))}
				</ol>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-rule bg-sheet px-4 py-3">
				<button type="submit" disabled={!complete || send.isPending} className={button.primary}>
					Send {questions.length === 1 ? "answer" : "answers"} and continue
				</button>
				{!complete && <span className="text-[13px] text-slate">Answer every question to continue.</span>}
				{send.error && <span className="text-[14px] text-danger">{send.error.message}</span>}
			</div>
		</form>
	);
}

function Choice({ name, checked, onPick, children }: { name: string; checked: boolean; onPick: () => void; children: React.ReactNode }) {
	return (
		// The whole row is the target, not just the dot.
		<label className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 ${checked ? "border-primary bg-primary-soft" : "border-rule bg-sheet hover:bg-wash"}`}>
			<input type="radio" name={name} checked={checked} onChange={onPick} className="size-4 accent-[var(--primary)]" />
			<span className="min-w-0">{children}</span>
		</label>
	);
}
