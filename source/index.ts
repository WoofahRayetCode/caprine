import path from 'node:path';
import {readFileSync, existsSync} from 'node:fs';
import {
	app,
	nativeImage,
	screen as electronScreen,
	session,
	ipcMain,
	BrowserWindow,
	Menu,
	Notification,
	MenuItemConstructorOptions,
	systemPreferences,
	nativeTheme,
} from 'electron';
import {ipcMain as ipc} from 'electron-better-ipc';
import {autoUpdater} from 'electron-updater';
import electronDl from 'electron-dl';
import electronContextMenu from 'electron-context-menu';
import electronLocalshortcut from 'electron-localshortcut';
import electronDebug from 'electron-debug';
import {is} from 'electron-util';
import doNotDisturb from '@sindresorhus/do-not-disturb';
import updateAppMenu from './menu';
import config, {StoreType} from './config';
import tray from './tray';
import {
	sendAction,
	setMainWindow,
	stripTrackingFromUrl,
} from './util';
import {process as processEmojiUrl} from './emoji';
import {setUpMenuBarMode} from './menu-bar-mode';
import {caprineIconPath} from './constants';
import {classifyUrl, isMessagesThreadUrl, isMessagesUrl} from './navigation';
import {configureNavigation, loadMessages, openExternal} from './window-navigation';

ipc.setMaxListeners(100);

electronDebug({
	isEnabled: true, // TODO: This is only enabled to allow `Command+R` because Facebook Messages sometimes gets stuck after computer waking up
	showDevTools: false,
});

electronDl();
electronContextMenu({
	showCopyImageAddress: true,
	prepend(defaultActions) {
		/*
		TODO: Use menu option or use replacement of options (https://github.com/sindresorhus/electron-context-menu/issues/70)
		See explanation for this hacky solution here: https://github.com/sindresorhus/caprine/pull/1169
		*/
		defaultActions.copyLink({
			transform: stripTrackingFromUrl,
		});

		return [];
	},
});

app.setAppUserModelId('com.sindresorhus.caprine');

if (!config.get('hardwareAcceleration')) {
	app.disableHardwareAcceleration();
}

if (!is.development && config.get('autoUpdate')) {
	const checkForUpdates = (): void => {
		void autoUpdater.checkForUpdatesAndNotify().catch(console.error);
	};

	setInterval(checkForUpdates, 1000 * 60 * 60 * 4);
	checkForUpdates();
}

let mainWindow: BrowserWindow;
let isQuitting = false;
let previousMessageCount = 0;
let isDNDEnabled = false;

if (!app.requestSingleInstanceLock()) {
	app.quit();
}

app.on('second-instance', () => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}

		mainWindow.show();
	}
});

// Preserves the window position when a display is removed and Caprine is moved to a different screen.
app.on('ready', () => {
	electronScreen.on('display-removed', () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			const [x, y] = mainWindow.getPosition();
			mainWindow.setPosition(x, y);
		}
	});
});

async function updateBadge(messageCount: number): Promise<void> {
	if (!is.windows) {
		app.badgeCount = config.get('showUnreadBadge') && !isDNDEnabled ? messageCount : 0;

		if (
			is.macos
			&& !isDNDEnabled
			&& config.get('bounceDockOnMessage')
			&& previousMessageCount < messageCount
		) {
			app.dock?.bounce('informational');
		}
	}

	if (!is.macos && config.get('flashWindowOnMessage')) {
		mainWindow.flashFrame(messageCount > previousMessageCount && !mainWindow.isFocused());
	}

	previousMessageCount = messageCount;
	tray.update(config.get('showUnreadBadge') ? messageCount : 0);

	if (is.windows) {
		if (!config.get('showUnreadBadge') || messageCount === 0) {
			mainWindow.setOverlayIcon(null, '');
		} else {
			// Delegate drawing of overlay icon to renderer process
			const overlay = await ipc.callRenderer<number, {data: string; text: string}>(mainWindow, 'render-overlay-icon', messageCount);
			if (previousMessageCount === messageCount) {
				updateOverlayIcon(overlay);
			}
		}
	}
}

function updateOverlayIcon({data, text}: {data: string; text: string}): void {
	const img = nativeImage.createFromDataURL(data);
	mainWindow.setOverlayIcon(img, text);
}

function initRequestsFiltering(): void {
	session.defaultSession.webRequest.onBeforeRequest({
		urls: [
			'https://*.fbcdn.net/images/emoji.php/v9/*',
			'https://*.facebook.com/images/emoji.php/v9/*',
		],
	}, async ({url, webContentsId}, callback) => {
		if (webContentsId !== mainWindow.webContents.id || !isMessagesUrl(mainWindow.webContents.getURL())) {
			callback({});
			return;
		}

		try {
			callback(await processEmojiUrl(url));
		} catch (error) {
			console.error(error);
			callback({});
		}
	});
}

function answerRenderer<Data = unknown, Result = unknown>(
	channel: string,
	callback: (data: Data) => Result | Promise<Result>,
	allowAccountPage = false,
): void {
	ipcMain.handle(channel, async (event, data: Data) => {
		const {sender, senderFrame} = event;
		if (!mainWindow || sender !== mainWindow.webContents || !senderFrame || senderFrame !== sender.mainFrame) {
			return undefined;
		}

		const route = classifyUrl(senderFrame.url);
		if (route === 'messages' || (allowAccountPage && route === 'account')) {
			return callback(data);
		}

		return undefined;
	});
}

function createMainWindow(): BrowserWindow {
	const lastWindowState = config.get('lastWindowState');

	const win = new BrowserWindow({
		title: app.name,
		show: false,
		x: lastWindowState.x,
		y: lastWindowState.y,
		width: lastWindowState.width,
		height: lastWindowState.height,
		icon: is.linux ? caprineIconPath : undefined,
		minWidth: 400,
		minHeight: 200,
		alwaysOnTop: config.get('alwaysOnTop'),
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: {
			x: 80,
			y: 20,
		},
		autoHideMenuBar: config.get('autoHideMenuBar'),
		webPreferences: {
			preload: path.join(__dirname, 'browser-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: config.get('isSpellCheckerEnabled'),
		},
	});

	if (is.macos) {
		win.setSheetOffset(40);
	}

	win.on('close', event => {
		if (isQuitting) {
			return;
		}

		if (config.get('quitOnWindowClose')) {
			app.quit();
			return;
		}

		// Workaround for https://github.com/electron/electron/issues/20263
		// Closing the app window when on full screen leaves a black screen
		// Exit fullscreen before closing
		if (is.macos && mainWindow.isFullScreen()) {
			mainWindow.once('leave-full-screen', () => {
				mainWindow.hide();
			});
			mainWindow.setFullScreen(false);
		}

		if (!isQuitting) {
			event.preventDefault();

			// Workaround for https://github.com/electron/electron/issues/10023
			win.blur();
			if (is.macos) {
				// On macOS we're using `app.hide()` in order to focus the previous window correctly
				app.hide();
			} else {
				win.hide();
			}
		}
	});

	win.on('focus', () => {
		if (config.get('flashWindowOnMessage')) {
			// This is a security in the case where messageCount is not reset by page title update
			win.flashFrame(false);
		}
	});

	win.on('resize', () => {
		const {isMaximized} = config.get('lastWindowState');
		config.set('lastWindowState', {...win.getNormalBounds(), isMaximized});
	});

	win.on('maximize', () => {
		config.set('lastWindowState.isMaximized', true);
	});

	win.on('unmaximize', () => {
		config.set('lastWindowState.isMaximized', false);
	});

	return win;
}

async function initialize(): Promise<void> {
	await app.whenReady();
	await updateAppMenu();
	mainWindow = createMainWindow();
	setMainWindow(mainWindow);

	const {webContents} = mainWindow;
	configureNavigation(mainWindow);
	initRequestsFiltering();

	// Workaround for https://github.com/electron/electron/issues/5256
	electronLocalshortcut.register(mainWindow, 'CommandOrControl+=', () => {
		sendAction('zoom-in');
	});

	setUpMenuBarMode(mainWindow);
	const {dock} = app;
	if (dock) {
		const muteItem: MenuItemConstructorOptions = {
			label: 'Mute Notifications',
			type: 'checkbox',
			checked: config.get('notificationsMuted'),
			click(menuItem) {
				config.set('notificationsMuted', menuItem.checked);
				const appMenuItem = Menu.getApplicationMenu()?.getMenuItemById('mute-notifications');
				if (appMenuItem) {
					appMenuItem.checked = menuItem.checked;
				}
			},
		};

		let menuItems: MenuItemConstructorOptions[] = [];
		const updateDockMenu = (): void => {
			muteItem.checked = config.get('notificationsMuted');
			const separator: MenuItemConstructorOptions[] = menuItems.length > 0 ? [{type: 'separator'}] : [];
			dock.setMenu(Menu.buildFromTemplate([muteItem, ...separator, ...menuItems]));
		};

		updateDockMenu();
		config.onDidChange('notificationsMuted', updateDockMenu);
		if (config.get('showDockIcon')) {
			dock.show();
		}

		const {updateTouchBar} = await import('./touch-bar');
		answerRenderer('conversations', (conversations: Conversation[]) => {
			menuItems = conversations.map(({label, icon}, index) => ({
				label,
				icon: nativeImage.createFromDataURL(icon),
				click() {
					mainWindow.show();
					sendAction('jump-to-conversation', index + 1);
				},
			}));

			updateDockMenu();
			updateTouchBar(conversations);
		});
		webContents.on('did-navigate', () => {
			menuItems = [];
			updateDockMenu();
			updateTouchBar([]);
		});

		void doNotDisturb.isEnabled().then((enabled: boolean) => {
			isDNDEnabled = enabled;
		}).catch(console.error);
		doNotDisturb.on('change', (enabled: boolean) => {
			isDNDEnabled = enabled;
		});
	}

	answerRenderer('update-tray-icon', async (count: number) => {
		if (Number.isSafeInteger(count) && count >= 0) {
			await updateBadge(count);
		}
	});

	nativeTheme.on('updated', () => {
		if (isMessagesUrl(webContents.getURL())) {
			sendAction('set-theme');
		}
	});

	const styles = ['browser.css', 'dark-mode.css', 'vibrancy.css', 'code-blocks.css', 'autoplay.css', 'scrollbar.css']
		.map(file => path.join(__dirname, '..', 'css', file));
	const customStyle = path.join(app.getPath('userData'), 'custom.css');
	let styleKey: string | undefined;
	let stylesInMessages = false;
	let styleRevision = 0;

	async function applyStyles(url: string, newDocument = false): Promise<void> {
		const inMessages = isMessagesUrl(url);
		if (!newDocument && inMessages === stylesInMessages) {
			return;
		}

		stylesInMessages = inMessages;
		const revision = ++styleRevision;
		const previousKey = styleKey;
		styleKey = undefined;
		if (!newDocument && previousKey) {
			await webContents.removeInsertedCSS(previousKey);
		}

		if (inMessages) {
			const css = [...styles, customStyle].filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8')).join('\n');
			const key = await webContents.insertCSS(css);
			if (revision === styleRevision) {
				styleKey = key;
			} else {
				await webContents.removeInsertedCSS(key);
			}
		}
	}

	webContents.on('dom-ready', () => {
		mainWindow.setTitle(app.name);
		void applyStyles(webContents.getURL(), true).catch(console.error);
	});
	webContents.on('page-title-updated', event => {
		event.preventDefault();
	});
	webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
		if (isMainFrame) {
			void applyStyles(url).catch(console.error);
		}
	});
	webContents.on('did-navigate', () => {
		for (const notification of notifications.values()) {
			notification.close();
		}

		notifications.clear();
		void updateBadge(0).catch(console.error);
	});

	mainWindow.once('ready-to-show', () => {
		if (config.get('launchMinimized')) {
			tray.create(mainWindow);
		} else {
			if (config.get('lastWindowState').isMaximized) {
				mainWindow.maximize();
			}

			mainWindow.show();
		}
	});
	loadMessages(mainWindow);
}

void initialize().catch(error => {
	console.error(error);
	app.quit();
});

if (is.macos) {
	answerRenderer('set-vibrancy', () => {
		mainWindow.setBackgroundColor('#80FFFFFF'); // Transparent, workaround for vibrancy issue.
		mainWindow.setVibrancy('sidebar');
	});
}

function toggleMaximized(): void {
	if (mainWindow.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow.maximize();
	}
}

answerRenderer('titlebar-doubleclick', () => {
	if (is.macos) {
		const doubleClickAction = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');

		if (doubleClickAction === 'Minimize') {
			mainWindow.minimize();
		} else if (doubleClickAction === 'Maximize') {
			toggleMaximized();
		}
	} else {
		toggleMaximized();
	}
});

app.on('activate', () => {
	if (mainWindow) {
		mainWindow.show();
	}
});

app.on('before-quit', () => {
	isQuitting = true;

	// Checking whether the window exists to work around an Electron race issue:
	// https://github.com/sindresorhus/caprine/issues/809
	if (mainWindow) {
		const {isMaximized} = config.get('lastWindowState');
		config.set('lastWindowState', {...mainWindow.getNormalBounds(), isMaximized});
	}
});

const notifications = new Map<number, Notification>();

answerRenderer('notification', (event: NotificationEvent) => {
	if (
		!event
		|| !Number.isSafeInteger(event.id)
		|| typeof event.title !== 'string'
		|| typeof event.body !== 'string'
		|| typeof event.conversationUrl !== 'string'
		|| !isMessagesThreadUrl(event.conversationUrl)
		|| config.get('notificationsMuted')
		|| isDNDEnabled
		|| mainWindow.isFocused()
	) {
		return;
	}

	const {id, title, body, icon, silent, conversationUrl} = event;
	const notification = new Notification({
		title,
		body: config.get('notificationMessagePreview') ? body : 'You have a new message',
		hasReply: is.macos,
		icon: typeof icon === 'string' && icon.startsWith('data:image/png;base64,')
			? nativeImage.createFromDataURL(icon)
			: caprineIconPath,
		silent,
	});

	notifications.get(id)?.close();
	notifications.set(id, notification);

	function forget(): void {
		if (notifications.get(id) === notification) {
			notifications.delete(id);
		}
	}

	notification.on('click', () => {
		mainWindow.show();
		void mainWindow.loadURL(conversationUrl).catch(console.error);
		forget();
	});
	notification.on('reply', (_event, reply) => {
		if (isMessagesUrl(mainWindow.webContents.getURL())) {
			void ipc.callRenderer(mainWindow, 'notification-reply-callback', {conversationUrl, reply}).catch(console.error);
		}

		forget();
	});
	notification.on('close', forget);
	notification.show();
});

type ThemeSource = typeof nativeTheme.themeSource;

answerRenderer('open-external', (url: string) => {
	if (typeof url === 'string' && classifyUrl(url) === 'external') {
		openExternal(url);
	}
});
answerRenderer('get-system-dark-mode', () => nativeTheme.shouldUseDarkColors, true);
answerRenderer('get-config-showMessageButtons', () => config.get('showMessageButtons'));
answerRenderer<undefined, ThemeSource>('get-config-theme', () => config.get('theme'));
answerRenderer('get-config-privateMode', () => config.get('privateMode'));
answerRenderer('get-config-vibrancy', () => config.get('vibrancy'));
answerRenderer('get-config-sidebar', () => config.get('sidebar'));
answerRenderer('get-config-zoomFactor', () => config.get('zoomFactor'), true);
answerRenderer('set-config-zoomFactor', (zoomFactor: number) => {
	if (Number.isFinite(zoomFactor) && zoomFactor > 0) {
		config.set('zoomFactor', zoomFactor);
	}
}, true);
answerRenderer('get-config-autoplayVideos', () => config.get('autoplayVideos'));
answerRenderer('get-config-emojiStyle', () => config.get('emojiStyle'));
answerRenderer('set-config-emojiStyle', (emojiStyle: StoreType['emojiStyle']) => {
	config.set('emojiStyle', emojiStyle);
});
