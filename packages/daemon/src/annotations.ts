import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Annotation } from "@tower/core";

/** Limits that keep a note a note: a quote is a selection, a note is a paragraph. */
export const QUOTE_MIN = 4;
export const QUOTE_MAX = 300;
export const NOTE_MAX = 1000;

const file = (cardDir: string) => join(cardDir, "annotations.json");

/** A class for request problems the HTTP layer turns into a 400. */
export class AnnotationError extends Error {}

export function loadAnnotations(cardDir: string): Annotation[] {
	if (!existsSync(file(cardDir))) return [];
	try {
		const raw = JSON.parse(readFileSync(file(cardDir), "utf8")) as Annotation[];
		if (!Array.isArray(raw)) return [];
		return raw.filter((a) => typeof a?.id === "string" && typeof a?.artifact === "string" && typeof a?.quote === "string" && typeof a?.note === "string");
	} catch {
		return [];
	}
}

export function saveAnnotations(cardDir: string, annotations: Annotation[]): void {
	mkdirSync(cardDir, { recursive: true });
	writeFileSync(file(cardDir), `${JSON.stringify(annotations, null, "\t")}\n`);
	writeFileSync(join(cardDir, "annotations.md"), renderAnnotationsMarkdown(annotations));
}

export function addAnnotation(cardDir: string, input: { artifact: string; quote: string; note: string }): Annotation {
	const quote = input.quote.trim().replaceAll(/\s+/g, " ");
	const note = input.note.trim();
	if (quote.length < QUOTE_MIN) throw new AnnotationError(`Select a little more text — a quote is at least ${QUOTE_MIN} characters`);
	if (quote.length > QUOTE_MAX) throw new AnnotationError(`A quote is at most ${QUOTE_MAX} characters — take the sentence, not the section`);
	if (note === "") throw new AnnotationError("Write the note");
	if (note.length > NOTE_MAX) throw new AnnotationError(`A note is at most ${NOTE_MAX} characters`);
	const annotation: Annotation = { id: randomUUID().replaceAll("-", "").slice(0, 8), artifact: input.artifact, quote, note, resolved: false, createdAt: Date.now() };
	const annotations = loadAnnotations(cardDir);
	annotations.push(annotation);
	saveAnnotations(cardDir, annotations);
	return annotation;
}

export function setAnnotationResolved(cardDir: string, annotationId: string, resolved: boolean): Annotation[] {
	const annotations = loadAnnotations(cardDir);
	const target = annotations.find((a) => a.id === annotationId);
	if (!target) throw new AnnotationError(`There is no annotation ${annotationId} on this card`);
	target.resolved = resolved;
	saveAnnotations(cardDir, annotations);
	return annotations;
}

export function deleteAnnotation(cardDir: string, annotationId: string): Annotation[] {
	const annotations = loadAnnotations(cardDir);
	const remaining = annotations.filter((a) => a.id !== annotationId);
	if (remaining.length === annotations.length) throw new AnnotationError(`There is no annotation ${annotationId} on this card`);
	saveAnnotations(cardDir, remaining);
	return remaining;
}

/**
 * The agents' view of the notes, on the record in the card's folder: grouped by artifact, unresolved
 * ones first-class, resolved ones remembered. The prompts point here; the files are the truth.
 */
function renderAnnotationsMarkdown(annotations: Annotation[]): string {
	if (annotations.length === 0) return "# Margin notes\n\nNone.\n";
	const byArtifact = new Map<string, Annotation[]>();
	for (const annotation of annotations) {
		const list = byArtifact.get(annotation.artifact) ?? [];
		list.push(annotation);
		byArtifact.set(annotation.artifact, list);
	}
	const lines = ["# Margin notes", "", "Notes a person pinned to text on this card. Unresolved notes are requests: honor them in your work.", ""];
	for (const [artifact, list] of byArtifact) {
		lines.push(`## ${artifact}`, "");
		for (const annotation of list) {
			const status = annotation.resolved ? "*(resolved)*" : "**(open)**";
			lines.push(`- ${status} On “${annotation.quote}”: ${annotation.note}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

/** The unresolved notes as prompt text; empty when there is nothing a person is still asking for. */
export function unresolvedAnnotationsBlock(cardDir: string): string {
	const open = loadAnnotations(cardDir).filter((a) => !a.resolved);
	if (open.length === 0) return "";
	const notes = open.map((a) => `- On “${a.quote}” (\`${a.artifact}\`): ${a.note}`).join("\n");
	return `# Margin notes\n\nThe person read ${open.length === 1 ? "this text" : "these texts"} and pinned notes to it — these are requests, not observations. Honor every one of them in your work; if one cannot be honored, say why in your result.\n\n${notes}\n\nThe full notes live at \`${join(cardDir, "annotations.md")}\`.`;
}

/** Composes a gate rejection's feedback with the person's open notes, so a note is never lost. */
export function feedbackWithAnnotations(feedback: string, cardDir: string): string {
	const open = loadAnnotations(cardDir).filter((a) => !a.resolved);
	if (open.length === 0) return feedback;
	const notes = open.map((a) => `- On “${a.quote}” (\`${a.artifact}\`): ${a.note}`).join("\n");
	const block = `The person's margin notes come with this:\n\n${notes}`;
	return feedback.trim() ? `${feedback.trim()}\n\n${block}` : block;
}
