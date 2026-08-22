import { contextBridge, ipcRenderer } from "electron";

const api = {
	openExternal: (url: string): Promise<void> => ipcRenderer.invoke("omp-studio:open-external", url),
	selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("omp-studio:select-workspace"),
	notify: (title: string, body: string): Promise<void> => ipcRenderer.invoke("omp-studio:notify", title, body),
};

/**
 * Startup surface for the splash document.
 *
 * The window keeps one preload across both documents it loads, so these channels
 * are also reachable from the Studio client. The main process rejects them once
 * the client has loaded, which is where that boundary is actually enforced.
 */
const splashApi = {
	copyFailure: (): Promise<void> => ipcRenderer.invoke("omp-studio:copy-startup-failure"),
	onState: (listener: (state: unknown) => void): void => {
		ipcRenderer.on("omp-studio:startup-state", (_event, state: unknown) => listener(state));
	},
	openLogFolder: (): Promise<void> => ipcRenderer.invoke("omp-studio:open-log-folder"),
	requestState: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:startup-state"),
	retry: (): Promise<void> => ipcRenderer.invoke("omp-studio:retry-startup"),
};

contextBridge.exposeInMainWorld("ompStudio", api);
contextBridge.exposeInMainWorld("ompStudioSplash", splashApi);
