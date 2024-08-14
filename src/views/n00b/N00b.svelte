<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import CreateNewRocket from '../../components/CreateNewRocket.svelte';

	const notifications = [
		{
			title: 'Your call has been confirmed.',
			description: '1 hour ago'
		},
		{
			title: 'You have a new message!',
			description: '1 hour ago'
		},
		{
			title: 'Your subscription is expiring soon!',
			description: '2 hours ago'
		}
	];
</script>

<div class="">
	<div class="flex flex-row flex-wrap gap-4">
		<div class="flex flex-col">
			<Card.Root class="max-w-80">
				<Card.Header>
					<Card.Title>Proof of Work</Card.Title>
					<Card.Description>I want to work for sats</Card.Description>
				</Card.Header>
				<img src="{base}/_work.png" />
				<Card.Content class="grid gap-4">
					<div>
						<ul class="ml-6 list-disc [&>li]:mt-2">
							<li>Solve problems for fun and profit</li>
							<li>No meetings, no scrum, no task assignment, no schedules</li>
							<li>Only work on fully open source projects</li>
							<li>
								No interview process! Apply by choosing a problem to solve and sending a pull
								request
							</li>
							<li>Get paid in Sats, or equity in the project's satflow</li>
						</ul>
					</div>
				</Card.Content>
				<Card.Footer>
					<Button
						on:click={() => {
							window.location.href = 'https://github.com/nostrocket/hypergolic/issues';
						}}
						class="w-full">View Problems</Button
					>
				</Card.Footer>
			</Card.Root>
		</div>
		<div class="flex flex-col">
			<Card.Root class="max-w-80">
				<Card.Header>
					<Card.Title>Proof of Sats</Card.Title>
					<Card.Description>I want to invest in the satflow of a Rocket</Card.Description>
				</Card.Header>
				<img src="{base}/_sats.png" width="100%" />
				<Card.Content class="grid gap-4">
					<div>
						<ul class="ml-6 list-disc [&>li]:mt-2">
							<li>
								Nostrocket is the most efficient way (ever) to invest in emerging technologies like
								nostr
							</li>
							<li>
								Your sats go directly to a contributor for work that has already been completed and
								solves a problem in the critical path to (more) revenue
							</li>
							<li>
								Nostrocket is non-custodial - revenue goes directly from the paying customer to your
								wallet as an equity holder
							</li>
							<li>No KYC (ever).</li>
						</ul>
					</div>
				</Card.Content>
				<Card.Footer>
					<Button
						on:click={() => {
							goto(`${base}/buymerits`);
						}}
						class="w-full">Let's GO!</Button
					>
				</Card.Footer>
			</Card.Root>
		</div>
		<div class="flex flex-col">
			<Card.Root class="max-w-80">
				<Card.Header>
					<Card.Title>Launch a new Rocket</Card.Title>
					<Card.Description
						>I have an open source project and I want to make it profitable</Card.Description
					>
				</Card.Header>
				<img src="{base}/_rocket.png" width="100%" />
				<Card.Content class="grid gap-4">
					<div>
						<ul class="ml-6 list-disc [&>li]:mt-2">
							<li>
								Attract the right people to make your project a success (despite your lack of
								funding)
							</li>
							<li>No financial accounting, capital raising, compliance, business plans, etc.</li>
							<li>
								Make your project socially scalable by becoming radically fair and meritocratic to
								all contributors and investors.
							</li>
							<li>
								Make your project immune to parasites by giving them nowhere to hide and nothing to
								leech from.
							</li>
						</ul>
					</div>
				</Card.Content>
				<Card.Footer>
					<CreateNewRocket />
				</Card.Footer>
			</Card.Root>
		</div>
	</div>
</div>
