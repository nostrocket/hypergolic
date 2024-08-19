import { onMount } from 'svelte';

export function pasteImage(node: HTMLTextAreaElement) {
	const handlePaste = (event: ClipboardEvent) => {
		const clipboardData = event.clipboardData;
		if (!clipboardData) return;

		const items = clipboardData.items;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) {
					// Create a URL for the image file
					const imageUrl = URL.createObjectURL(file);
					// Insert the image URL into the textarea
					node.value += `\n![Image](${imageUrl})\n`;
				}
				event.preventDefault();
			}
		}
	};

	// Attach the paste event listener
	node.addEventListener('paste', handlePaste);

	// Clean up the event listener on unmount
	return {
		destroy() {
			node.removeEventListener('paste', handlePaste);
		}
	};
}
