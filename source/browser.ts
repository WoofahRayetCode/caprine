/* eslint-disable n/prefer-global/process -- Electron supplies process to sandboxed preloads. */
import {ipcRenderer as ipc} from 'electron-better-ipc';
import selectors, {getConversationLinks, getConversationUrl} from './browser/selectors';
import {toggleVideoAutoplay} from './autoplay';
import {observeConversationList, sendConversationList} from './browser/conversation-list';
import {
	classifyUrl, externalUrl, isMessagesThreadUrl, isMessagesUrl, messagesUrl,
} from './navigation';
import {callMain} from './renderer-ipc';
import {IToggleSounds} from './types';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const waitTimeout = 2000;
const waitInterval = 50;

function isMessagesPage(): boolean {
	return window.top === window && isMessagesUrl(location.href);
}

function answerInMessages<Data, Result>(channel: string, handler: (data: Data) => Result): void {
	ipc.answerMain(channel, (data: Data) => {
		if (isMessagesPage()) {
			return handler(data);
		}

		return undefined;
	});
}

async function waitFor<T>(find: () => T | undefined): Promise<T | undefined> {
	if (!isMessagesPage()) {
		return undefined;
	}

	const immediate = find();
	if (immediate) {
		return immediate;
	}

	return new Promise(resolve => {
		const timer = setInterval(() => {
			const onMessages = isMessagesPage();
			const found = onMessages ? find() : undefined;
			if (found !== undefined || !onMessages) {
				clearInterval(timer);
				clearTimeout(deadline);
				resolve(found);
			}
		}, waitInterval);
		const deadline = setTimeout(() => {
			clearInterval(timer);
			resolve(undefined);
		}, waitTimeout);
	});
}

function query(selector: string, root: ParentNode = document): HTMLElement | undefined {
	return root.querySelector<HTMLElement>(selector) ?? undefined;
}

function queryConversationNavigation(): HTMLElement | undefined {
	return query(selectors.conversationNavigation);
}

function accessibleName(element: HTMLElement): string {
	return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
}

async function selectFromMenu(button: HTMLElement | undefined, findItem: (items: HTMLElement[]) => HTMLElement | undefined): Promise<boolean> {
	if (!button) {
		return false;
	}

	const getItems = () => [...document.querySelectorAll<HTMLElement>(selectors.menuItem)];
	const oldItems = button.getAttribute('aria-expanded') === 'true' ? [] : getItems();

	if (button.getAttribute('aria-expanded') !== 'true') {
		button.click();
	}

	const item = await waitFor(() => findItem(getItems().filter(item => !oldItems.includes(item))));
	item?.click();
	return Boolean(item);
}

function findMenuItem(items: HTMLElement[], path: string, label: string): HTMLElement | undefined {
	return items.find(item => accessibleName(item) === label || item.querySelector(`path[d^="${path}"]`));
}

async function selectSettingsItem(path: string, label: string): Promise<boolean> {
	const navigation = queryConversationNavigation();
	const button = navigation && query(selectors.settingsMenu, navigation);
	return selectFromMenu(button, items => findMenuItem(items, path, label));
}

async function openPreferences(): Promise<HTMLElement | undefined> {
	const dialog = query(selectors.preferencesDialog);
	if (dialog) {
		return dialog;
	}

	if (await selectSettingsItem('M10 5.75', 'Preferences')) {
		return waitFor(() => query(selectors.preferencesDialog));
	}

	return undefined;
}

async function toggleSounds({checked}: IToggleSounds): Promise<void> {
	const root = document.documentElement;
	const existingDialog = query(selectors.preferencesDialog);
	if (!existingDialog) {
		root.classList.add('hide-preferences-window');
	}

	try {
		const dialog = existingDialog ?? await openPreferences();
		if (!dialog || !isMessagesPage()) {
			return;
		}

		// Facebook places the notification sounds switch first in Messenger Preferences.
		const soundSwitch = query('[role=switch]', dialog);
		const setting = soundSwitch?.getAttribute('aria-checked');
		if ((setting === 'true' || setting === 'false') && (checked === undefined || checked !== (setting === 'true'))) {
			soundSwitch?.click();
		}

		if (!existingDialog) {
			query('[aria-label=Close], [role=button][aria-label=Back]', dialog)?.click();
		}
	} finally {
		root.classList.remove('hide-preferences-window');
	}
}

async function logOut(): Promise<void> {
	const root = document.documentElement;
	root.classList.add('caprine-account-menu');
	let selectedLogout = false;

	try {
		const buttons = document.querySelectorAll<HTMLElement>(selectors.profileButton);
		const button = buttons[buttons.length - 1];
		if (!button) {
			return;
		}

		const expanded = button.getAttribute('aria-expanded') === 'true';
		const previousDialogs = expanded ? [] : [...document.querySelectorAll('[role=dialog]')];
		if (!expanded) {
			button.click();
		}

		const action = await waitFor(() => {
			const items = document.querySelectorAll<HTMLElement>('[role=dialog] :is(a[href], button, [role=button], [role=menuitem])');
			return [...items].find(item => {
				const dialog = item.closest('[role=dialog]');
				if (dialog && previousDialogs.includes(dialog)) {
					return false;
				}

				const href = item.getAttribute('href');
				if (href && URL.canParse(href, location.href)) {
					const url = new URL(href, location.href);
					if (classifyUrl(url.href) === 'account' && /^\/logout(?:\.php)?\/?$/.test(url.pathname)) {
						return true;
					}
				}

				return accessibleName(item) === 'Log out';
			});
		});

		if (action) {
			selectedLogout = true;
			action.click();
		}
	} finally {
		// Keep the native menu visible if its logout control could not be identified.
		if (selectedLogout || !isMessagesPage()) {
			root.classList.remove('caprine-account-menu');
		}
	}
}

async function searchInConversation(): Promise<void> {
	const search = query(selectors.searchInConversation);
	if (search) {
		search.click();
		return;
	}

	const info = query(selectors.conversationInfo);
	if (info?.getAttribute('aria-expanded') !== 'true') {
		info?.click();
	}

	const searchButton = await waitFor(() => query(selectors.searchInConversation));
	searchButton?.click();
}

type ConversationAction = 'mute' | 'archive' | 'delete';

async function actOnConversation(action: ConversationAction): Promise<void> {
	const conversation = getConversationLinks().find(link => link.getAttribute('aria-current') === 'page');
	const row = conversation?.closest('[role=row]');
	if (!row) {
		return;
	}

	const menuButton = query('[role=button][aria-haspopup=menu], [role=button][aria-label=Menu]', row)
		?? [...row.querySelectorAll<HTMLElement>('[role=button]')].find(button => button.parentElement?.classList.contains('html-div'));

	await selectFromMenu(menuButton, items => {
		if (action === 'mute') {
			return findMenuItem(items, 'M109.362 211', 'Mute notifications');
		}

		if (action === 'delete') {
			return findMenuItem(items, 'M8.75', 'Delete chat');
		}

		return items.find(item => ['Archive chat', 'Archive'].includes(accessibleName(item)));
	});
}

function selectConversation(index: number): void {
	getConversationLinks()[index]?.click();
}

function stepConversation(offset: number): void {
	const links = getConversationLinks();
	const index = links.findIndex(link => link.getAttribute('aria-current') === 'page');
	if (index >= 0) {
		links[(index + offset + links.length) % links.length].click();
	}
}

answerInMessages('show-preferences', async () => {
	await openPreferences();
});
answerInMessages('new-conversation', () => {
	const navigation = queryConversationNavigation();
	if (navigation) {
		query(selectors.newConversation, navigation)?.click();
	}
});
answerInMessages('log-out', logOut);
answerInMessages('find', () => {
	const navigation = queryConversationNavigation();
	if (navigation) {
		query(selectors.conversationSearch, navigation)?.focus();
	}
});
answerInMessages('search', searchInConversation);
answerInMessages('insert-gif', () => query(selectors.gif)?.click());
answerInMessages('insert-emoji', () => query(selectors.emoji)?.click());
answerInMessages('insert-sticker', () => query(selectors.sticker)?.click());
answerInMessages('attach-files', () => query(selectors.attachment)?.click());
answerInMessages('focus-text-input', () => query(selectors.composer)?.focus());
answerInMessages('next-conversation', () => {
	stepConversation(1);
});
answerInMessages('previous-conversation', () => {
	stepConversation(-1);
});
answerInMessages('jump-to-conversation', (key: number) => {
	if (Number.isSafeInteger(key) && key >= 1) {
		selectConversation(key - 1);
	}
});
answerInMessages('mute-conversation', async () => actOnConversation('mute'));
answerInMessages('archive-conversation', async () => actOnConversation('archive'));
answerInMessages('delete-conversation', async () => actOnConversation('delete'));
answerInMessages('toggle-sounds', toggleSounds);
answerInMessages('show-chats-view', () => {
	if (location.href !== messagesUrl) {
		location.assign(messagesUrl);
	}
});
answerInMessages('show-requests-view', async () => selectSettingsItem('M95.5 219.208', 'Message requests'));
answerInMessages('show-archive-view', async () => selectSettingsItem('M109.5 207.75', 'Archived chats'));
answerInMessages('toggle-video-autoplay', toggleVideoAutoplay);
ipc.answerMain('reload', () => {
	location.reload();
});

type ThemeSource = 'light' | 'dark' | 'system';
let useDarkColors: boolean | undefined;

function applyTheme(): void {
	if (!isMessagesPage() || useDarkColors === undefined) {
		return;
	}

	const {classList} = document.documentElement;
	classList.toggle('dark-mode', useDarkColors);
	classList.toggle('light-mode', !useDarkColors);
	classList.toggle('__fb-dark-mode', useDarkColors);
	classList.toggle('__fb-light-mode', !useDarkColors);

	const oppositeTheme = useDarkColors ? '__fb-light-mode' : '__fb-dark-mode';
	for (const element of document.querySelectorAll(`.${oppositeTheme}`)) {
		element.classList.remove(oppositeTheme);
	}
}

async function setTheme(): Promise<void> {
	const theme = await callMain<undefined, ThemeSource>('get-config-theme');
	const dark = theme === 'dark' || (theme === 'system' && await callMain<undefined, boolean>('get-system-dark-mode'));
	if (isMessagesPage()) {
		useDarkColors = dark;
		applyTheme();
		await updateVibrancy();
	}
}

async function updateVibrancy(): Promise<void> {
	if (!isMac) {
		return;
	}

	const vibrancy = await callMain<undefined, 'sidebar' | 'none' | 'full'>('get-config-vibrancy');
	if (!isMessagesPage()) {
		return;
	}

	const {classList} = document.documentElement;
	classList.toggle('sidebar-vibrancy', vibrancy === 'sidebar');
	classList.toggle('full-vibrancy', vibrancy === 'full');
	await callMain('set-vibrancy');
}

async function setPrivateMode(): Promise<void> {
	const privateMode = await callMain<undefined, boolean>('get-config-privateMode');
	if (!isMessagesPage()) {
		return;
	}

	document.documentElement.classList.toggle('private-mode', privateMode);
	if (isMac) {
		await sendConversationList();
	}
}

async function updateSidebar(): Promise<void> {
	const sidebar = await callMain<undefined, 'default' | 'hidden' | 'narrow' | 'wide'>('get-config-sidebar');
	if (!isMessagesPage()) {
		return;
	}

	const {classList} = document.documentElement;
	classList.toggle('sidebar-hidden', sidebar === 'hidden');
	classList.toggle('sidebar-force-narrow', sidebar === 'narrow');
	classList.toggle('sidebar-force-wide', sidebar === 'wide');
}

async function updateMessageButtons(): Promise<void> {
	const showMessageButtons = await callMain<undefined, boolean>('get-config-showMessageButtons');
	if (isMessagesPage()) {
		document.body?.classList.toggle('show-message-buttons', !showMessageButtons);
	}
}

answerInMessages('update-sidebar', updateSidebar);
answerInMessages('set-theme', setTheme);
answerInMessages('set-private-mode', setPrivateMode);
answerInMessages('update-vibrancy', updateVibrancy);
answerInMessages('toggle-message-buttons', updateMessageButtons);

ipc.answerMain('render-overlay-icon', (messageCount: number): {data: string; text: string} => {
	const canvas = document.createElement('canvas');
	canvas.width = 128;
	canvas.height = 128;
	const context = canvas.getContext('2d')!;
	context.fillStyle = '#f42020';
	context.beginPath();
	context.ellipse(64, 64, 64, 64, 0, 0, 2 * Math.PI);
	context.fill();
	context.textAlign = 'center';
	context.fillStyle = 'white';
	context.font = '90px sans-serif';
	context.fillText(String(Math.min(99, messageCount)), 64, 96);
	return {data: canvas.toDataURL(), text: String(messageCount)};
});

ipc.answerMain('render-native-emoji', (emoji: string): string => {
	const canvas = document.createElement('canvas');
	canvas.width = 256;
	canvas.height = 256;
	const context = canvas.getContext('2d')!;
	const systemFont = isLinux ? 'emoji, system-ui' : 'system-ui';
	context.textAlign = 'center';
	context.textBaseline = isMac ? 'middle' : 'bottom';
	context.font = `${isMac ? 256 : 225}px ${systemFont}`;
	context.fillText(emoji, 128, isMac ? 154 : 256);
	return canvas.toDataURL();
});

function applyZoom(zoomFactor: number): void {
	if (isMessagesPage() && Number.isFinite(zoomFactor)) {
		document.documentElement.style.setProperty('--caprine-conversation-zoom', String(zoomFactor));
	}
}

async function setZoom(zoomFactor: number): Promise<void> {
	applyZoom(zoomFactor);
	if (isMessagesPage()) {
		await callMain<number, void>('set-config-zoomFactor', zoomFactor);
	}
}

async function stepZoom(amount: number): Promise<void> {
	const zoom = await callMain<undefined, number>('get-config-zoomFactor');
	const next = Math.round((zoom + amount) * 10) / 10;
	if (next >= 0.8 && next <= 1.5) {
		await setZoom(next);
	}
}

answerInMessages('zoom-reset', async () => setZoom(1));
answerInMessages('zoom-in', async () => stepZoom(0.1));
answerInMessages('zoom-out', async () => stepZoom(-0.1));

function updateLayout(): void {
	if (!isMessagesPage()) {
		document.documentElement.classList.remove('caprine-messages');
		return;
	}

	const {classList} = document.documentElement;
	if (!classList.contains('caprine-messages')) {
		classList.add('caprine-messages');
	}

	const container = queryConversationNavigation()?.parentElement;
	if (container && !container.classList.contains('caprine-thread-list-container')) {
		container.classList.add('caprine-thread-list-container');
	}

	const titlebar = query('[role=navigation] .x78zum5.xdt5ytf.xzd29fr');
	if (titlebar && !titlebar.classList.contains('caprine-titlebar')) {
		titlebar.classList.add('caprine-titlebar');
	}

	applyTheme();
}

function initialize(): void {
	const root = document.documentElement;
	root.classList.add(`os-${process.platform}`);
	let initialized = false;
	let updatePending = false;

	function update(): void {
		updateLayout();
		if (!isMessagesPage() || initialized) {
			return;
		}

		initialized = true;
		void Promise.all([
			callMain<undefined, number>('get-config-zoomFactor').then(applyZoom),
			setTheme(),
			setPrivateMode(),
			updateSidebar(),
			updateMessageButtons(),
			toggleVideoAutoplay(),
		]).catch(error => {
			console.error('Could not restore Caprine Messages settings', error);
		});
		observeConversationList();
	}

	const observer = new MutationObserver(() => {
		if (!updatePending) {
			updatePending = true;
			requestAnimationFrame(() => {
				updatePending = false;
				update();
			});
		}
	});

	observer.observe(root, {attributes: true, attributeFilter: ['class']});
	observer.observe(document.body, {childList: true, subtree: true});
	update();
}

document.addEventListener('DOMContentLoaded', initialize, {once: true});

document.addEventListener('animationstart', event => {
	if (isMessagesPage() && event.animationName === 'nodeInserted') {
		event.target?.dispatchEvent(new Event('mouseover', {bubbles: true}));
	}
});

window.addEventListener('blur', () => {
	document.documentElement.classList.add('is-window-inactive');
});
window.addEventListener('focus', () => {
	document.documentElement.classList.remove('is-window-inactive');
});

window.addEventListener('dblclick', event => {
	if (isMessagesPage() && event.target instanceof Element && event.target.closest('.caprine-titlebar')) {
		void callMain('titlebar-doubleclick');
	}
}, {passive: true});

document.addEventListener('click', event => {
	if (!event.isTrusted || !isMessagesPage() || !(event.target instanceof Element) || !event.target.closest('[role=main]')) {
		return;
	}

	const link = event.target.closest<HTMLAnchorElement>('a[href]');
	if (!link || link.hasAttribute('download') || event.target.closest('img')) {
		return;
	}

	const href = link.getAttribute('href');
	if (!href || href.startsWith('#') || classifyUrl(link.href) !== 'external') {
		return;
	}

	const url = externalUrl(link.href);
	if (url && classifyUrl(url) === 'external') {
		event.preventDefault();
		event.stopPropagation();
		void callMain('open-external', url);
	}
}, {capture: true});

document.addEventListener('keydown', event => {
	const combineKey = isMac ? event.metaKey : event.ctrlKey && !event.altKey;
	if (!isMessagesPage() || !combineKey || event.defaultPrevented || event.isComposing) {
		return;
	}

	if (event.key === '[' || event.key === ']') {
		event.preventDefault();
		stepConversation(event.key === '[' ? -1 : 1);
	} else if (/^[1-9]$/.test(event.key)) {
		event.preventDefault();
		selectConversation(Number(event.key) - 1);
	}
});

function sameConversation(left: string, right: string): boolean {
	if (!isMessagesThreadUrl(left) || !isMessagesThreadUrl(right)) {
		return false;
	}

	const normalize = (url: string) => new URL(url).pathname.replace(/\/$/, '');
	return normalize(left) === normalize(right);
}

function findConversation(conversationUrl: string): HTMLAnchorElement | undefined {
	return getConversationLinks().find(link => {
		const url = getConversationUrl(link);
		return url && sameConversation(url, conversationUrl);
	});
}

async function replyToConversation(conversationUrl: string, reply: string): Promise<void> {
	const link = findConversation(conversationUrl);
	if (!link) {
		return;
	}

	const previousComposer = query(selectors.composer);
	const changingConversation = !sameConversation(location.href, conversationUrl);
	if (changingConversation) {
		link.click();
	}

	const composer = await waitFor(() => {
		const current = query(selectors.composer);
		if (sameConversation(location.href, conversationUrl)
			&& findConversation(conversationUrl)?.getAttribute('aria-current') === 'page'
			&& (!changingConversation || previousComposer !== current)) {
			return current;
		}

		return undefined;
	});

	if (!composer) {
		return;
	}

	const hasDraft = (composer.textContent ?? '').trim().length > 0 || Boolean(composer.querySelector('img, [contenteditable=false]'));
	if (hasDraft || query(selectors.send)) {
		return;
	}

	composer.focus();
	if (document.activeElement !== composer || !document.execCommand('insertText', false, reply)) {
		return;
	}

	const canSend = () => sameConversation(location.href, conversationUrl)
		&& query(selectors.composer) === composer
		&& composer.textContent === reply;
	const send = await waitFor(() => canSend() ? query(selectors.send) : undefined);
	if (send && canSend()) {
		send.click();
	} else if (canSend() && document.activeElement === composer) {
		document.getSelection()?.selectAllChildren(composer);
		document.execCommand('delete');
	}
}

let replyInProgress = false;
answerInMessages('notification-reply-callback', async ({conversationUrl, reply}: {conversationUrl: string; reply: string}) => {
	if (replyInProgress || !isMessagesThreadUrl(conversationUrl) || typeof reply !== 'string' || !reply.trim()) {
		return;
	}

	replyInProgress = true;
	try {
		await replyToConversation(conversationUrl, reply);
	} finally {
		replyInProgress = false;
	}
});
