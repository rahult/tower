import { createApp } from "./app.ts";
import { Db } from "./db.ts";

const port = Number(process.env.PORT ?? 8787);

const server = createApp(new Db());
server.listen(port, () => {
	const address = server.address();
	// The acceptance runner parses this line to learn the ephemeral port; keep the exact shape.
	console.log(`listening on ${typeof address === "object" && address !== null ? address.port : port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		process.exit(0);
	});
}
