interface OmpStudioDesktopApi {
	notify(title: string, body: string): Promise<void>;
	openExternal(url: string): Promise<void>;
	selectWorkspace(): Promise<string | null>;
}

interface Window {
	ompStudio?: OmpStudioDesktopApi;
}
