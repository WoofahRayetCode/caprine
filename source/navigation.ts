const facebookOrigin = 'https://www.facebook.com';
export const messagesUrl = `${facebookOrigin}/messages/`;

const facebookOrigins = new Set([facebookOrigin, 'https://facebook.com']);
const accountPath = /^\/(?:login(?:\.php)?|logout(?:\.php)?|checkpoint|two_step_verification|two_factor|recover|identify|security\/2fac\/setup)(?:\/|$)/;

function parseWebUrl(raw: string): URL | undefined {
	try {
		const url = new URL(raw);
		if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
			return url;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function classifyUrl(raw: string): 'messages' | 'account' | 'call' | 'external' {
	const url = parseWebUrl(raw);
	if (!url || !facebookOrigins.has(url.origin)) {
		return 'external';
	}

	if (/^\/messages(?:\/|$)/.test(url.pathname)) {
		return 'messages';
	}

	if (url.pathname === '/' || accountPath.test(url.pathname)) {
		return 'account';
	}

	if (/^\/(?:videocall|videochat|call)(?:\/|$)/.test(url.pathname)) {
		return 'call';
	}

	return 'external';
}

export function isMessagesUrl(raw: string): boolean {
	return classifyUrl(raw) === 'messages';
}

export function isMessagesThreadUrl(raw: string): boolean {
	return isMessagesUrl(raw) && /^\/messages\/(?:e2ee\/)?t\/[^/]+\/?$/.test(new URL(raw).pathname);
}

export function externalUrl(raw: string): string | undefined {
	const url = parseWebUrl(raw);
	if (!url) {
		return undefined;
	}

	if (url.pathname === '/l.php' && (url.origin === 'https://l.facebook.com' || url.origin === 'https://lm.facebook.com' || url.origin === 'https://l.messenger.com' || facebookOrigins.has(url.origin))) {
		return parseWebUrl(url.searchParams.get('u') ?? '')?.href;
	}

	return url.href;
}
