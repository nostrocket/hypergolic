<script lang="ts">
	import { ndk } from '@/ndk.js';
	import { Chart } from 'flowbite-svelte';
	import type { ApexOptions } from 'apexcharts';
	import { writable } from 'svelte/store';
	import { Toaster } from '$lib/components/ui/sonner';

	export let data: { pubkey: string; merits: number; sats: number }[];
	export let hoveredPubkey: string | null = null;

	let pubkeys = Array.from(data, (x) => x.pubkey);
	let chartInstance: ApexCharts;
	let options: ApexOptions = {
		series: Array.from(data, (x) => x.merits),
		colors: [
			'#f43f5e',
			'#ec4899',
			'#14b8a6',
			'#f97316',
			'#a855f7',
			'#0ea5e9',
			'#22c55e',
			'#eab308',
			'#71717a',
			'#f2f2f2'
		],
		chart: {
			height: 320,
			width: '100%',
			type: 'donut',
			events: {
				mounted: function (chartContext, config) {
					chartInstance = chartContext;
				}
			}
		},
		stroke: {
			colors: ['transparent'],
			lineCap: undefined
		},
		plotOptions: {
			pie: {
				donut: {
					labels: {
						show: true,
						name: {
							show: true,
							fontFamily: 'Inter, sans-serif',
							offsetY: 20
						},
						total: {
							showAlways: false,
							show: false,
							label: 'Merit Distribution',
							fontFamily: 'Inter, sans-serif',
							formatter: function (w) {
								const sum = w.globals.seriesTotals.reduce((a: number, b: number) => {
									return a + b;
								}, 0);
								return `${sum}`;
							}
						},
						value: {
							show: true,
							fontFamily: 'Inter, sans-serif',
							offsetY: -20,
							formatter: function (value) {
								return value + '';
							}
						}
					},
					size: '40%'
				}
			}
		},
		grid: {
			padding: {
				top: -2
			}
		},
		labels: ['Direct', 'Sponsor', 'Affiliate', 'Email marketing'],
		dataLabels: {
			enabled: true
		},
		legend: {
			show: false,
			position: 'bottom',
			fontFamily: 'Inter, sans-serif'
		},
		yaxis: {
			labels: {
				formatter: function (value) {
					return value + '';
				}
			}
		},
		xaxis: {
			labels: {
				formatter: function (value) {
					return value + '';
				}
			},
			axisTicks: {
				show: false
			},
			axisBorder: {
				show: false
			}
		}
	};

	let o = writable(options);

	$: {
		let usernames: string[] = [];
		for (let pk of pubkeys) {
			let user = $ndk.getUser({ pubkey: pk });
			if (user && user.profile && user.profile.name) {
				usernames.push(user.profile.name);
			} else {
				usernames.push(user.npub.substring(0, 10));
			}
		}
		o.update((existing) => {
			existing.labels = usernames;
			return existing;
		});
	}

	$: {
		if (chartInstance && hoveredPubkey !== null) {
			const index = data.findIndex((item) => item.pubkey === hoveredPubkey);
			if (index !== -1) {
				chartInstance.toggleDataPointSelection(index);
			}
		}
	}
</script>

<div class="relative h-full w-full">
	<Chart options={$o} class="py-6" bind:chart={chartInstance} />
	<div class="absolute -top-10 left-1/2 z-20 w-[356px] -translate-x-1/2 transform">
		<Toaster position="top-center" id="purchase" duration={3000} />
	</div>
</div>
