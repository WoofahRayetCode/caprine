/* eslint-disable n/prefer-global/process -- Electron supplies process to sandboxed preloads. */
import {isMessagesThreadUrl, isMessagesUrl} from '../navigation';
import {callMain} from '../renderer-ipc';
import selectors, {getConversationLinks, getConversationUrl} from './selectors';

type ConversationRow = {
	url: string;
	title: string;
	body: string;
	avatar: string;
	unread: boolean;
	muted: boolean;
	selected: boolean;
};

const imageTimeout = 2000;
const rowUpdateDelay = 100;
let updateVersion = 0;

function getText(element: Element | undefined): string {
	if (!element) {
		return '';
	}

	const clone = element.cloneNode(true) as Element;
	for (const image of clone.querySelectorAll('img')) {
		const alt = image.alt.toLowerCase() === '(y)' ? '👍' : image.alt;
		image.replaceWith(alt);
	}

	return clone.textContent?.trim() ?? '';
}

function isUnreadConversation(link: HTMLAnchorElement): boolean {
	if (link.querySelector('[aria-label="Mark as Read" i]')) {
		return true;
	}

	// The unread status is a visually hidden label inside a span wrapper.
	for (const label of link.querySelectorAll<HTMLElement>('.html-span > :is(div, span)')) {
		if (label.childElementCount > 0 || !label.textContent?.trim()) {
			continue;
		}

		const style = window.getComputedStyle(label);
		if (style.position === 'absolute' && style.width === '1px' && style.height === '1px' && style.overflow === 'hidden') {
			return true;
		}
	}

	return false;
}

function getAvatar(link: HTMLAnchorElement): string {
	const avatar = link.querySelector('img, svg image');
	if (avatar instanceof HTMLImageElement) {
		return avatar.currentSrc || avatar.src;
	}

	return avatar?.getAttribute('href') ?? avatar?.getAttribute('xlink:href') ?? '';
}

function getConversationRows(): ConversationRow[] {
	return getConversationLinks().flatMap(link => {
		const url = getConversationUrl(link);
		if (!url) {
			return [];
		}

		const textNodes = [...link.querySelectorAll(`${selectors.conversationLabel}, ${selectors.conversationPreview}`)];
		const title = getText(textNodes[0]);
		const preview = textNodes.find(element => element !== textNodes[0] && element.matches(selectors.conversationPreview));
		const row = link.closest('[role=row]');

		return [{
			url,
			title: title.length > 0 ? title : (link.getAttribute('aria-label') ?? ''),
			body: getText(preview),
			avatar: getAvatar(link),
			unread: isUnreadConversation(link),
			muted: Boolean(row?.querySelector(selectors.mutedConversation)),
			selected: link.getAttribute('aria-current') === 'page',
		}];
	});
}

async function loadAvatar(url: string): Promise<HTMLImageElement | undefined> {
	if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
		return undefined;
	}

	return new Promise(resolve => {
		const image = new Image();
		image.crossOrigin = 'anonymous';

		const timer = setTimeout(resolve, imageTimeout);
		image.addEventListener('load', () => {
			clearTimeout(timer);
			resolve(image);
		}, {once: true});
		image.addEventListener('error', () => {
			clearTimeout(timer);
			resolve(undefined);
		}, {once: true});

		image.src = url;
	});
}

async function createIcon(url: string, unread: boolean): Promise<string> {
	const image = await loadAvatar(url);
	if (!image) {
		return '';
	}

	const canvas = document.createElement('canvas');
	canvas.width = 50;
	canvas.height = 56;
	const context = canvas.getContext('2d');
	if (!context) {
		return '';
	}

	context.save();
	context.beginPath();
	context.arc(25, 28, 25, 0, Math.PI * 2);
	context.clip();
	context.drawImage(image, 0, 3, 50, 50);
	context.restore();

	if (unread) {
		context.fillStyle = '#f42020';
		context.beginPath();
		context.arc(42, 8, 8, 0, 2 * Math.PI);
		context.fill();
	}

	return canvas.toDataURL();
}

const readIcons = new Map<string, Promise<string>>();
const unreadIcons = new Map<string, Promise<string>>();

async function getIcon(avatar: string, unread: boolean): Promise<string> {
	if (!avatar) {
		return '';
	}

	const cache = unread ? unreadIcons : readIcons;
	const cached = cache.get(avatar);
	if (cached) {
		return cached;
	}

	// Limit memory use across long sessions even when profile URLs rotate.
	if (cache.size >= 100) {
		const oldest = cache.keys().next().value;
		if (oldest) {
			cache.delete(oldest);
		}
	}

	const pending = createIcon(avatar, unread).catch(() => '');
	cache.set(avatar, pending);
	return pending;
}

export async function sendConversationList(rows = getConversationRows()): Promise<void> {
	if (!isMessagesUrl(location.href)) {
		return;
	}

	const version = ++updateVersion;
	const visibleRows = document.documentElement.classList.contains('private-mode') ? [] : rows;
	const conversations = await Promise.all(visibleRows.map(async row => ({
		label: row.title || 'Conversation',
		selected: row.selected,
		unread: row.unread,
		icon: await getIcon(row.avatar, row.unread),
	})));

	if (version === updateVersion && isMessagesUrl(location.href)) {
		await callMain('conversations', conversations);
	}
}

function notificationId(url: string): number {
	let hash = 0;
	for (const character of url) {
		hash = ((hash * 31) + character.codePointAt(0)!) % 2_147_483_647;
	}

	return -(hash + 1);
}

function isChatListPage(): boolean {
	return isMessagesUrl(location.href)
		&& (/^\/messages(?:\/new)?\/?$/.test(location.pathname) || isMessagesThreadUrl(location.href));
}

async function notify(row: ConversationRow, isCurrent: () => boolean): Promise<void> {
	const icon = await getIcon(row.avatar, false);
	if (isChatListPage() && isCurrent()) {
		await callMain('notification', {
			id: notificationId(row.url),
			title: row.title,
			body: row.body,
			icon,
			silent: false,
			conversationUrl: row.url,
		});
	}
}

export function observeConversationList(): void {
	let grid: Element | undefined;
	let previousRows = new Map<string, ConversationRow>();
	let previousCount: number | undefined;
	let pending = false;

	function refresh(initial: boolean): void {
		if (!grid?.isConnected || !isMessagesUrl(location.href)) {
			return;
		}

		const rows = getConversationRows();
		const oldRows = previousRows;
		previousRows = new Map(rows.map(row => [row.url, row]));

		if (process.platform === 'darwin') {
			void sendConversationList(rows);
		}

		if (!isChatListPage()) {
			return;
		}

		const unreadRows = rows.filter(row => row.unread && !row.muted);
		if (unreadRows.length !== previousCount) {
			previousCount = unreadRows.length;
			void callMain('update-tray-icon', previousCount);
		}

		if (initial || document.hasFocus()) {
			return;
		}

		for (const row of unreadRows) {
			const previous = oldRows.get(row.url);
			if (row.title && (!previous?.unread || (previous.body && previous.body !== row.body))) {
				void notify(row, () => {
					const latest = previousRows.get(row.url);
					return Boolean(latest?.unread && !latest.muted && latest.body === row.body);
				});
			}
		}
	}

	const gridObserver = new MutationObserver(() => {
		if (!pending) {
			pending = true;
			setTimeout(() => {
				pending = false;
				refresh(false);
			}, rowUpdateDelay);
		}
	});

	function attachToGrid(): void {
		const nextGrid = isMessagesUrl(location.href) ? (document.querySelector(selectors.conversationList) ?? undefined) : undefined;
		if (nextGrid === grid) {
			return;
		}

		gridObserver.disconnect();
		grid = nextGrid;

		if (grid) {
			gridObserver.observe(grid, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: ['alt', 'aria-current', 'aria-label', 'class', 'href', 'src', 'style'],
			});
			refresh(true);
		}
	}

	const layoutObserver = new MutationObserver(attachToGrid);
	layoutObserver.observe(document.body, {childList: true, subtree: true});
	attachToGrid();
}
