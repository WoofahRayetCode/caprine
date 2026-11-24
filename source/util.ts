import {
	app,
	BrowserWindow,
	dialog,
	Menu,
} from 'electron';
import {ipcMain} from 'electron-better-ipc';
import {is} from 'electron-util';
import config from './config';
import tray from './tray';
import {externalUrl, isMessagesUrl} from './navigation';

let mainWindow: BrowserWindow;

export function setMainWindow(window: BrowserWindow): void {
	mainWindow = window;
}

export function getWindow(): BrowserWindow {
	return mainWindow;
}

export function sendAction<T>(action: string, arguments_?: T): void {
	const win = getWindow();
	if (!win || win.isDestroyed()) {
		return;
	}

	if (is.macos) {
		win.restore();
	}

	if (action === 'reload') {
		win.webContents.reload();
	} else if (isMessagesUrl(win.webContents.getURL()) || action.startsWith('zoom-')) {
		void ipcMain.callRenderer(win, action, arguments_).catch(console.error);
	}
}

export async function sendBackgroundAction<T, ReturnValue>(action: string, arguments_?: T): Promise<ReturnValue> {
	return ipcMain.callRenderer<T, ReturnValue>(getWindow(), action, arguments_);
}

export function showRestartDialog(message: string): void {
	const buttonIndex = dialog.showMessageBoxSync(
		getWindow(),
		{
			message,
			detail: 'Do you want to restart the app now?',
			buttons: [
				'Restart',
				'Ignore',
			],
			defaultId: 0,
			cancelId: 1,
		},
	);

	if (buttonIndex === 0) {
		app.relaunch();
		app.quit();
	}
}

export function stripTrackingFromUrl(url: string): string {
	return externalUrl(url) ?? url;
}

export const toggleTrayIcon = (): void => {
	const showTrayIconState = config.get('showTrayIcon');
	config.set('showTrayIcon', !showTrayIconState);

	if (showTrayIconState) {
		tray.destroy();
	} else {
		tray.create(getWindow());
	}
};

export const toggleLaunchMinimized = (menu: Menu): void => {
	config.set('launchMinimized', !config.get('launchMinimized'));
	const showTrayIconItem = menu.getMenuItemById('showTrayIcon')!;

	if (config.get('launchMinimized')) {
		if (!config.get('showTrayIcon')) {
			toggleTrayIcon();
		}

		disableMenuItem(showTrayIconItem, true);

		dialog.showMessageBox({
			type: 'info',
			message: 'The “Show Tray Icon” setting is force-enabled while the “Launch Minimized” setting is enabled.',
			buttons: ['OK'],
		});
	} else {
		showTrayIconItem.enabled = true;
	}
};

const disableMenuItem = (menuItem: Electron.MenuItem, checked: boolean): void => {
	menuItem.enabled = false;
	menuItem.checked = checked;
};
