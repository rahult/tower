import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { applyTheme } from "./theme.ts";

// Before the first paint, so a chosen theme never flashes the other one.
applyTheme();

/**
 * Last resort under App: a render crash anywhere otherwise whites out the whole page with no way to know
 * what happened. This keeps the message on screen, with a reload one click away.
 */
class Guard extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	componentDidCatch(error: Error) {
		console.error(error);
	}
	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3 bg-wash p-6 text-center">
				<p className="display text-[20px] font-extrabold">The board hit a problem it could not render.</p>
				<p className="max-w-[60ch] font-mono text-[13px] break-words text-slate">{this.state.error.message}</p>
				<button type="button" onClick={() => window.location.reload()} className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[14px] font-bold text-primary-ink hover:brightness-110">
					Reload the board
				</button>
			</div>
		);
	}
}

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<Guard>
				<App />
			</Guard>
		</QueryClientProvider>
	</StrictMode>,
);
