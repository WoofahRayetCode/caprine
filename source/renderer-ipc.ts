import {ipcRenderer} from 'electron';

export async function callMain<Data = unknown, Result = unknown>(channel: string, data?: Data): Promise<Result> {
	return ipcRenderer.invoke(channel, data) as Promise<Result>;
}
