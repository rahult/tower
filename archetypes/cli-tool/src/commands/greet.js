// The worked example: the smallest command that shows the shape — pure, exported, tested.
export function greet(name) {
	if (typeof name !== "string" || name.trim() === "") {
		return { message: "usage: cli greet <name>", exitCode: 64, error: true };
	}
	return { message: `Hello, ${name.trim()}!`, exitCode: 0 };
}
