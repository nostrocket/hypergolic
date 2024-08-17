import { writable } from 'svelte/store';

export let zappers = writable(new Map<string, string>());

export let attempts = writable(new Set<string>());
