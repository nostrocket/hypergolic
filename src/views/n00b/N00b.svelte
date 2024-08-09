<script lang="ts">
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
	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
		<Card.Root class="flex h-full w-full flex-col">
			<Card.Header>
				<Card.Title>Proof of Work</Card.Title>
				<Card.Description>I have skills and I'm ready to work for sats.</Card.Description>
			</Card.Header>
			<img src="{base}/_work.png" alt="Proof of Work" />
			<Card.Content class="grid gap-4 !pt-2">
				<div>
					<ul class="ml-6 list-disc [&>li]:mt-2">
						<li>Solve problems for fun and profit</li>
						<li>No meetings, no scrum, no task assignment, no schedules</li>
						<li>Work only on what inspires you</li>
						<li>
							No interview process or CV's required, apply by sending a pull request to solve a
							small problem
						</li>
						<li>Get paid in Sats for every pull request</li>
					</ul>
				</div>
			</Card.Content>
			<Card.Footer class="mt-auto">
				<Button class="w-full">Apply Now</Button>
			</Card.Footer>
		</Card.Root>
		<Card.Root class="flex h-full w-full flex-col">
			<Card.Header>
				<Card.Title>Proof of Sats</Card.Title>
				<Card.Description>I have Sats, and I want a slice of a Rocket's satflow.</Card.Description>
			</Card.Header>
			<img src="{base}/_sats.png" width="100%" alt="Proof of Sats" />
			<Card.Content class="grid gap-4 !pt-2">
				<div>
					<ul class="ml-6 list-disc [&>li]:mt-2">
						<li>Nostrocket is the most efficient way (ever) to invest in emerging technologies</li>
						<li>
							Every Sat goes directly to a contributor for solving a problem in the critical path
							towards (more) revenue
						</li>
						<li>
							Revenue goes straight from the paying customer's wallet into your wallet as an equity
							holder
						</li>
						<li>No KYC, ever.</li>
					</ul>
				</div>
			</Card.Content>
			<Card.Footer class="mt-auto">
				<Button class="w-full">Read More</Button>
			</Card.Footer>
		</Card.Root>
		<Card.Root class="flex h-full w-full flex-col">
			<Card.Header>
				<Card.Title>Launch a new Rocket</Card.Title>
				<Card.Description
					>I'm working on my own project and I want other people to join me.</Card.Description
				>
			</Card.Header>
			<img src="{base}/_rocket.png" width="100%" alt="Launch a new Rocket" />
			<Card.Content class="grid gap-4 !pt-2">
				<div>
					<ul class="ml-6 list-disc [&>li]:mt-2">
						<li>
							Attract the people you need to make your project a success (despite your lack of
							funding)
						</li>
						<li>
							Nostrocket obsoletes the need for financial accounting, capital raising, compliance,
							business plans, etc.
						</li>
						<li>
							Nostrocket is radically meritocratic and fair to project creators, contributors, and
							investors, for the entire life of the project
						</li>
					</ul>
				</div>
			</Card.Content>
			<Card.Footer class="mt-auto">
				<CreateNewRocket />
			</Card.Footer>
		</Card.Root>
	</div>
</div>
