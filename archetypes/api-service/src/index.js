import { createApp } from "./app.js";
import { Store } from "./store.js";

const port = Number(process.env.PORT ?? 8901);

const server = createApp(new Store());
server.listen(port, () => {
	const address = server.address();
	// The acceptance runner parses this line to learn the ephemeral port; keep the exact shape.
	console.log(`listening on ${typeof address === "object" && address !== null ? address.port : port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		server.close();
		process.exit(0);
	});
}
