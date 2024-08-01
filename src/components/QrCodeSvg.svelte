<script lang="ts">
	import { drawSvgPath } from '$lib/helpers';
	import { Ecc, QrCode } from '$lib/qrcodegen';

	export let content;
	export let lightColor = 'white';
	export let darkColor = 'black';
	export const border = 2;

	const qrCode = QrCode.encodeText(content, Ecc.LOW);
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	version="1.1"
	viewBox={`0 0 ${qrCode.size + border * 2} ${qrCode.size + border * 2}`}
	stroke="none"
>
	<rect width="100%" height="100%" fill={lightColor} />
	<path d={drawSvgPath(qrCode, border)} fill={darkColor} />
</svg>
