import { writable } from 'svelte/store';

export let zappers = writable(new Map<string, string>());
