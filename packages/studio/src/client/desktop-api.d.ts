interface OmpStudioDesktopApi {
	getWindowState(): Promise<unknown>;
	notify(title: string, body: string): Promise<void>;
	onWindowStateChange(listener: (state: unknown) => void): () => void;
	openExternal(url: string): Promise<void>;
	selectWorkspace(): Promise<string | null>;
	windowControl(action: string): Promise<void>;
}

interface Window {
	ompStudio?: OmpStudioDesktopApi;
}
