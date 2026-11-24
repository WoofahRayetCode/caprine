const assert = require('node:assert/strict');
const {test} = require('node:test');
const {classifyUrl, externalUrl, isMessagesThreadUrl, messagesUrl} = require('../dist-js/navigation');
const {removeLegacySettings} = require('../dist-js/config-migration');

test('keeps Messenger and Facebook sign-in redirects in Caprine', () => {
	assert.equal(messagesUrl, 'https://www.facebook.com/messages/');
	for (const path of ['/messages/', '/messages/t/123', '/login.php?next=%2Fmessages%2F', '/login/device-based/regular/login/', '/checkpoint/123', '/two_step_verification/', '/recover/initiate/', '/logout.php', '/']) {
		assert.ok(['messages', 'account'].includes(classifyUrl(`https://www.facebook.com${path}`)), path);
	}
});

test('separates chat, call, and external destinations', () => {
	assert.equal(classifyUrl('https://facebook.com/messages'), 'messages');
	assert.equal(classifyUrl('https://www.facebook.com/videocall/?call_id=123'), 'call');
	for (const url of ['http://www.facebook.com/messages/', 'https://www.facebook.com:444/messages/', 'https://www.facebook.com.evil.test/messages/', 'https://www.facebook.com/messages-other', 'https://www.facebook.com/login-helper', 'https://www.facebook.com/profile.php', 'https://user@www.facebook.com/messages/', 'file:///foo', 'not a URL']) {
		assert.equal(classifyUrl(url), 'external', url);
	}
});

test('opens only web links and safely unwraps Facebook link redirects', () => {
	assert.equal(externalUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Ftest'), 'https://example.com/test');
	assert.equal(externalUrl('https://example.com/path'), 'https://example.com/path');
	for (const url of ['https://l.facebook.com/l.php', 'https://l.facebook.com/l.php?u=file%3A%2F%2F%2FC%3A%2Ffile', 'data:text/plain,test', 'about:blank', 'not a URL']) {
		assert.equal(externalUrl(url), undefined, url);
	}
});

test('accepts concrete thread URLs for desktop notifications', () => {
	assert.equal(isMessagesThreadUrl('https://www.facebook.com/messages/t/123'), true);
	assert.equal(isMessagesThreadUrl('https://www.facebook.com/messages/e2ee/t/123/'), true);
	assert.equal(isMessagesThreadUrl(messagesUrl), false);
	assert.equal(isMessagesThreadUrl('https://example.com/messages/t/123'), false);
});

test('removes retired mode and checkbox settings without resetting other preferences', () => {
	const profile = {
		useWorkChat: true,
		keepMeSignedIn: false,
		theme: 'dark',
		zoomFactor: 1.25,
	};
	const store = {
		has: key => Object.hasOwn(profile, key),
		delete(key) {
			delete profile[key];
		},
	};
	removeLegacySettings(store);
	removeLegacySettings(store);
	assert.deepEqual(profile, {theme: 'dark', zoomFactor: 1.25});
});
