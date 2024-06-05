<script>
	import Menu from '../../components/Menu.svelte';

	import SidePanel from '../../layouts/SidePanel.svelte';
</script>

<SidePanel>
	<div slot="menu">
		<Menu />
	</div>
	<div slot="content">
        <h1 class="mb-4 text-4xl font-extrabold leading-none tracking-tight text-gray-900 md:text-5xl lg:text-6xl dark:text-white">Rockets</h1>


<div class="max-w-sm bg-white border border-gray-200 rounded-lg shadow dark:bg-gray-800 dark:border-gray-700">
    <a href="#">
        <img class="rounded-t-lg" src="https://assets.editorial.aetnd.com/uploads/2009/11/joseph-stalin-gettyimages-464426375.jpg" alt="" />
    </a>
    <div class="p-5">
        <a href="#">
            <h5 class="mb-2 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">The People's Rocket</h5>
        </a>
        <p class="mb-3 font-normal text-gray-700 dark:text-gray-400">Dedicated to delivering excellence through central planning.</p>
        <p class="mb-3 font-normal text-gray-700 dark:text-gray-400">Created by PabloF7z</p>
        <a href="#" class="inline-flex items-center px-3 py-2 text-sm font-medium text-center text-white bg-blue-700 rounded-lg hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800">
            Read more
             <svg class="rtl:rotate-180 w-3.5 h-3.5 ms-2" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 10">
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M1 5h12m0 0L9 1m4 4L9 9"/>
            </svg>
        </a>
    </div>
</div>

    </div>
</SidePanel>
