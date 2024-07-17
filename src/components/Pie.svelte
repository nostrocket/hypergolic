<script lang="ts">
	import { ndk } from '@/ndk.js';
	import { Chart } from 'flowbite-svelte';
	import { writable } from 'svelte/store';
	export let data:{pubkey: string; merits: number; sats: number}[]

	let pubkeys = Array.from(data,(x)=>x.pubkey)
	let options = {
		series: Array.from(data,(x)=>x.merits),
		colors: ['#9d174d', '#991b1b', '#6b21a8', '#1e40af'],
		chart: {
			height: 320,
			width: '100%',
			type: 'donut'
		},
		stroke: {
			colors: ['transparent'],
			lineCap: ''
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
								const sum = w.globals.seriesTotals.reduce((a, b) => {
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
			enabled: false
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

	let o = writable(options)

	$: {
		let usernames:string[] = []
		for (let pk of pubkeys) {
			let user = $ndk.getUser({pubkey:pk})
			if (user && user.profile && user.profile.name) {
				usernames.push(user.profile.name)
			} else {
				usernames.push(user.npub.substring(0, 10))
			}
		}
		o.update(existing=>{
			existing.labels = usernames
			return existing
		})
	}

	//     <Card>
	//     <div class="flex justify-between items-start w-full">
	//       <div class="flex-col items-center">
	//         <div class="flex items-center mb-1">
	//           <h5 class="text-xl font-bold leading-none text-gray-900 dark:text-white me-1">Merit Distribution</h5>

	//         </div>
	//       </div>

	//     </div>
	// </Card>
</script>

<Chart options={$o} class="py-6" />
