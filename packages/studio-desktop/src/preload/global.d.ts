interface OmpStudioApi {
	openExternal(url: string): Promise<void>;
	selectWorkspace(): Promise<string | null>;
	notify(title: string, body: string): Promise<void>;
	getWindowState(): Promise<unknown>;
	windowControl(action: string): Promise<void>;
	onWindowStateChange(listener: (state: unknown) => void): () => void;
	getDesktopRuntime(): Promise<unknown>;
	relocateState(): Promise<unknown>;
	resetStateRoot(): Promise<unknown>;
	repairSidecar(): Promise<unknown>;
	installShims(): Promise<unknown>;
}

interface Window {
	ompStudio: OmpStudioApi;
}
