import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

const WINDOW_STATE_CHANGE_CHANNEL = "omp-studio:window-state-change";

const api = {
	openExternal: (url: string): Promise<void> => ipcRenderer.invoke("omp-studio:open-external", url),
	selectWorkspace: (): Promise<string | null> => ipcRenderer.invoke("omp-studio:select-workspace"),
	notify: (title: string, body: string): Promise<void> => ipcRenderer.invoke("omp-studio:notify", title, body),
	getWindowState: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:window-state"),
	windowControl: (action: string): Promise<void> => ipcRenderer.invoke("omp-studio:window-control", action),
	getDesktopRuntime: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:desktop-runtime"),
	relocateState: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:relocate-state"),
	resetStateRoot: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:reset-state-root"),
	repairSidecar: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:repair-sidecar"),
	installShims: (): Promise<unknown> => ipcRenderer.invoke("omp-studio:install-shims"),
	/**
	 * Subscribe to window state the client did not cause: a snap gesture, a
	 * double-click on the drag region, or an OS shortcut. Returns the unsubscribe so
	 * a remounting title bar cannot accumulate listeners.
	 */
	onWindowStateChange: (listener: (state: unknown) => void): (() => void) => {
		const handler = (_event: IpcRendererEvent, state: unknown): void => listener(state);
		ipcRenderer.on(WINDOW_STATE_CHANGE_CHANNEL, handler);
		return () => {
			ipcRenderer.off(WINDOW_STATE_CHANGE_CHANNEL, handler);
		};
	},
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
