import {isMessagesThreadUrl} from '../navigation';

const newConversation = 'a[href="/messages/new/"], a[href="/messages/new"]';
const conversationNavigation = `[role=navigation]:has([role=grid]), [role=navigation]:has(${newConversation})`;
const conversationList = '[role=navigation] [role=grid]';
const conversationLink = 'a[role=link][href]';
const menuItem = '[role=menu] [role=menuitem]';
const preferencesDialog = '[role=dialog]:has(h2):has([role=switch])';

export default {
	conversationNavigation,
	conversationList,
	conversationLink,
	conversationSelector: '[role=main] [role=grid]',
	conversationPreview: '.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft',
	conversationLabel: '.x1lliihq.x6ikm8r.x10wlt62.xlyipyv.xuxw1ft',
	mutedConversation: 'svg.x1tzjh5l:not(.x1k90msu)',
	newConversation,
	conversationSearch: 'input[type=search]',
	conversationInfo: '[role=button]:has(path[d^="M18,10 C16.6195"]), [role=button].x6s0dn4.x3nfvp2.x1fgtraw.xl56j7k.x1n2onr6.xgd8bvy',
	searchInConversation: '[role=main] [role=button]:has(path[d^="M7.5 1"]), [role=main] [aria-label="Search in conversation"]',
	composer: '[role=main] [role=textbox][contenteditable=true]',
	gif: '[role=main] [role=button]:has(path[d^="M7.695"])',
	emoji: '[role=main] [role=button]:has(path[d^="M210.5,405"])',
	sticker: '[role=main] [role=button]:has(path[d^="M8.305"])',
	attachment: '[role=main] [role=button]:has(path[d^="M7 4.25"])',
	send: '[role=main] :is(button, [role=button])[aria-label="Send"]',
	settingsMenu: '[role=button][aria-haspopup=menu]',
	profileButton: '[role=banner] [role=button][aria-expanded]',
	menuItem,
	preferencesDialog,
};

export function getConversationLinks(): HTMLAnchorElement[] {
	const links = document.querySelectorAll<HTMLAnchorElement>(`${conversationList} [role=row] ${conversationLink}`);
	return [...links].filter(link => getConversationUrl(link));
}

export function getConversationUrl(link: HTMLAnchorElement): string | undefined {
	const href = link.getAttribute('href');
	if (href && URL.canParse(href, location.href)) {
		const url = new URL(href, location.href);
		if (isMessagesThreadUrl(url.href)) {
			return url.href;
		}
	}

	return undefined;
}
