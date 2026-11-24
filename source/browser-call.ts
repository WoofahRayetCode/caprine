function startCall(): void {
	const {href, origin} = window.location;
	if (href !== 'about:blank' && origin !== 'https://www.facebook.com' && origin !== 'https://facebook.com') {
		return;
	}

	const observer = new MutationObserver(clickStartButton);
	const timeout = setTimeout(() => {
		observer.disconnect();
	}, 10_000);
	function clickStartButton(): void {
		const button = document.querySelector<HTMLElement>('._3quh._30yy._2t_');
		if (button) {
			clearTimeout(timeout);
			observer.disconnect();
			button.click();
		}
	}

	observer.observe(document, {subtree: true, childList: true});
	clickStartButton();
}

document.addEventListener('DOMContentLoaded', startCall, {once: true});
