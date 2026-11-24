import path from 'node:path';
import {BrowserWindow, dialog, shell} from 'electron';
import {
	classifyUrl,
	externalUrl,
	isMessagesUrl,
	messagesUrl,
} from './navigation';

export function configureNavigation(window: BrowserWindow): void {
	const {webContents} = window;
	const callWindows = new Set<Electron.WebContents>();
	let retryDialogOpen = false;
	let lastRoute: ReturnType<typeof classifyUrl> = 'external';
	let returnFromLogin = false;

	webContents.on('will-navigate', event => {
		const {url} = event;
		const route = classifyUrl(url);
		if (route !== 'messages' && route !== 'account') {
			event.preventDefault();
			openExternal(url);
		}
	});

	webContents.on('will-redirect', event => {
		const route = classifyUrl(event.url);
		if (event.isMainFrame && route !== 'messages' && route !== 'account') {
			event.preventDefault();
		}
	});

	webContents.on('did-navigate', (_event, url) => {
		const route = classifyUrl(url);
		const fromAccountPage = lastRoute === 'account';
		lastRoute = route;
		if (route === 'messages') {
			returnFromLogin = false;
		} else if (fromAccountPage && !returnFromLogin && route === 'account' && new URL(url).pathname === '/') {
			// Some sign-in flows finish at Facebook's home page instead of honoring next.
			returnFromLogin = true;
			void webContents.session.cookies.get({url: messagesUrl, name: 'c_user'}).then(cookies => {
				if (cookies.length > 0 && !window.isDestroyed() && webContents.getURL() === url) {
					loadMessages(window);
				}
			}).catch(console.error);
		}
	});

	webContents.on('did-fail-load', async (_event, errorCode, errorDescription, _url, isMainFrame) => {
		if (!isMainFrame || errorCode === -3 || retryDialogOpen || window.isDestroyed()) {
			return;
		}

		retryDialogOpen = true;
		try {
			window.show();
			const {response} = await dialog.showMessageBox(window, {
				type: 'error',
				message: 'Caprine could not load Facebook Messages.',
				detail: errorDescription,
				buttons: ['Retry', 'Dismiss'],
				cancelId: 1,
			});
			if (response === 0 && !window.isDestroyed()) {
				loadMessages(window);
			}
		} finally {
			retryDialogOpen = false;
		}
	});

	webContents.setWindowOpenHandler(details => {
		const route = classifyUrl(details.url);
		const legacyCall = details.disposition === 'new-window' && details.url === 'about:blank' && Boolean(details.frameName) && details.frameName !== 'about:blank';
		if (isMessagesUrl(webContents.getURL()) && (route === 'call' || legacyCall)) {
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					show: true,
					titleBarStyle: 'default',
					webPreferences: {
						nodeIntegration: false,
						contextIsolation: true,
						sandbox: true,
						preload: path.join(__dirname, 'browser-call.js'),
					},
				},
			};
		}

		if (route === 'messages' || route === 'account') {
			void webContents.loadURL(details.url).catch(console.error);
		} else {
			openExternal(details.url);
		}

		return {action: 'deny'};
	});

	webContents.on('did-create-window', child => {
		const contents = child.webContents;
		callWindows.add(contents);
		contents.once('destroyed', () => callWindows.delete(contents));
		contents.setWindowOpenHandler(() => ({action: 'deny'}));
		const guardCallNavigation = (event: Electron.Event & {url: string; isMainFrame?: boolean}): void => {
			if (event.isMainFrame !== false && classifyUrl(event.url) !== 'call') {
				event.preventDefault();
			}
		};

		contents.on('will-navigate', guardCallNavigation);
		contents.on('will-redirect', guardCallNavigation);
	});

	const isAllowedPermission = (contents: Electron.WebContents | undefined, permission: string, raw: string): boolean => {
		const route = classifyUrl(raw);
		const messages = contents === webContents && route === 'messages';
		const call = Boolean(contents && callWindows.has(contents) && route === 'call');
		return (permission === 'fullscreen' || permission === 'media' || permission === 'clipboard-sanitized-write') && (messages || call);
	};

	webContents.session.setPermissionRequestHandler((contents, permission, callback, {requestingUrl, isMainFrame}) => {
		callback(isMainFrame && isAllowedPermission(contents, permission, requestingUrl));
	});
	webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, {requestingUrl, isMainFrame}) => {
		// Some checks supply the origin without the full requesting URL.
		const url = requestingUrl ?? contents?.getURL();
		return Boolean(isMainFrame && url && isAllowedPermission(contents ?? undefined, permission, url) && requestingOrigin.replace(/\/$/, '') === new URL(url).origin);
	});
}

export function loadMessages(window: BrowserWindow): void {
	if (window && !window.isDestroyed()) {
		void window.loadURL(messagesUrl).catch(console.error);
	}
}

export function openExternal(raw: string): void {
	const url = externalUrl(raw);
	if (url) {
		void shell.openExternal(url).catch(console.error);
	}
}
