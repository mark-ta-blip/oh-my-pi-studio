interface OmpStudioApi {
	openExternal(url: string): Promise<void>;
	selectWorkspace(): Promise<string | null>;
	notify(title: string, body: string): Promise<void>;
	getWindowState(): Promise<unknown>;
	windowControl(action: string): Promise<void>;
	onWindowStateChange(listener: (state: unknown) => void): () => void;
}

interface Window {
	ompStudio: OmpStudioApi;
}
