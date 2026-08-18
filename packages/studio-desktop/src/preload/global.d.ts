interface OmpStudioApi {
	openExternal(url: string): Promise<void>;
	selectWorkspace(): Promise<string | null>;
	notify(title: string, body: string): Promise<void>;
}

interface Window {
	ompStudio: OmpStudioApi;
}
