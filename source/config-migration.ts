export function removeLegacySettings(store: {has: (key: string) => boolean; delete: (key: string) => void}): void {
	for (const key of ['useWorkChat', 'keepMeSignedIn']) {
		if (store.has(key)) {
			store.delete(key);
		}
	}
}
