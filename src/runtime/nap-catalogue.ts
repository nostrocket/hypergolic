/** Reviewed upstream registry; proposal status is separate from shell conformance. */
export const NAP_CATALOGUE_REVIEWED = '2026-10-06';
export const NAP_REGISTRY_REVISION = 'a040914b4bbd3a5cd8a14b0f316a723c968ebfb2';
export const NAP_CATALOGUE = Object.freeze([
  {
    "domain": "shell",
    "name": "NAP-SHELL",
    "status": "Active",
    "description": "Bootstrap handshake and capability negotiation (foundational \u2014 defines `shell.supports()`)",
    "source": "https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-SHELL.md",
    "revision": "a040914b4bbd3a5cd8a14b0f316a723c968ebfb2"
  },
  {
    "domain": "intent",
    "name": "NAP-INTENT",
    "status": "Active",
    "description": "Invoke a napplet by archetype (default-handler dispatch)",
    "source": "https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INTENT.md",
    "revision": "a040914b4bbd3a5cd8a14b0f316a723c968ebfb2"
  },
  {
    "domain": "inc",
    "name": "NAP-INC",
    "status": "Active",
    "description": "Inter-napplet communication",
    "source": "https://github.com/napplet/naps/pull/5",
    "revision": "8e1ec3bb1e0f467ed8556130bc8904877472c774"
  },
  {
    "domain": "theme",
    "name": "NAP-THEME",
    "status": "Active",
    "description": "Shell-provided theming",
    "source": "https://github.com/napplet/naps/pull/8",
    "revision": "acac69d90811d1891db5faa33d64716be97d0a76"
  },
  {
    "domain": "relay",
    "name": "NAP-RELAY",
    "status": "Draft",
    "description": "Relay proxy (subscribe, publish, query, publishEncrypted)",
    "source": "https://github.com/napplet/naps/pull/2",
    "revision": "0be8abce18beb46ca37bd4ddd042f58d30b4eedc"
  },
  {
    "domain": "identity",
    "name": "NAP-IDENTITY",
    "status": "Draft",
    "description": "Read-only user identity queries",
    "source": "https://github.com/napplet/naps/pull/12",
    "revision": "a040914b4bbd3a5cd8a14b0f316a723c968ebfb2"
  },
  {
    "domain": "storage",
    "name": "NAP-STORAGE",
    "status": "Draft",
    "description": "Scoped key-value storage",
    "source": "https://github.com/napplet/naps/pull/3",
    "revision": "f71e84ebca7474db260346cbfc2d88f41b4e421e"
  },
  {
    "domain": "keys",
    "name": "NAP-KEYS",
    "status": "Draft",
    "description": "Keyboard forwarding and action keybindings",
    "source": "https://github.com/napplet/naps/pull/9",
    "revision": "cecb64257e0ac29926bb746832a477c553ab307c"
  },
  {
    "domain": "media",
    "name": "NAP-MEDIA",
    "status": "Draft",
    "description": "Media session control and playback",
    "source": "https://github.com/napplet/naps/pull/10",
    "revision": "2b2d29e90c30b994bf5035a65b57e5fe7f08a9a2"
  },
  {
    "domain": "notify",
    "name": "NAP-NOTIFY",
    "status": "Draft",
    "description": "Shell-rendered notifications",
    "source": "https://github.com/napplet/naps/pull/11",
    "revision": "e14f5c9d6a6dd2a69ccf79668c4a3c1e955e1ac9"
  },
  {
    "domain": "resource",
    "name": "NAP-RESOURCE",
    "status": "Draft",
    "description": "Sandboxed resource fetching (https / blossom / nostr / data)",
    "source": "https://github.com/napplet/naps/pull/13",
    "revision": "a040914b4bbd3a5cd8a14b0f316a723c968ebfb2"
  },
  {
    "domain": "config",
    "name": "NAP-CONFIG",
    "status": "Draft",
    "description": "Per-napplet declarative configuration (JSON Schema-driven)",
    "source": "https://github.com/napplet/naps/pull/14",
    "revision": "448013e6d8cb8c75dce49576b3e7c0d46d960eac"
  },
  {
    "domain": "upload",
    "name": "NAP-UPLOAD",
    "status": "Draft",
    "description": "Shell-mediated file and blob upload (NIP-96, Blossom)",
    "source": "https://github.com/napplet/naps/pull/33",
    "revision": "a7cc17463cbf5d9cb87884b31071bc4fc826034c"
  },
  {
    "domain": "value",
    "name": "NAP-VALUE",
    "status": "Draft",
    "description": "Shell-mediated value transfer and zaps",
    "source": "https://github.com/napplet/naps/pull/30",
    "revision": "4128a72fbd38cbf430f147611721560b0025c362"
  },
  {
    "domain": "outbox",
    "name": "NAP-OUTBOX",
    "status": "Draft",
    "description": "Outbox-aware relay routing and queries",
    "source": "https://github.com/napplet/naps/pull/32",
    "revision": "4589a8f9a16d8aa29b3740e2b3b0cdca11e0976e"
  },
  {
    "domain": "cvm",
    "name": "NAP-CVM",
    "status": "Draft",
    "description": "Native ContextVM / MCP-over-Nostr bridge",
    "source": "https://github.com/napplet/naps/pull/31",
    "revision": "ad68a938236e9230324e377cd005008a315ff402"
  },
  {
    "domain": "link",
    "name": "NAP-LINK",
    "status": "Draft",
    "description": "Shell-mediated external link opening",
    "source": "https://github.com/napplet/naps/pull/53",
    "revision": "e25143355f6d416bfce73b12ec814f1c795ec16a"
  },
  {
    "domain": "pow",
    "name": "NAP-POW",
    "status": "Draft",
    "description": "NIP-13 proof-of-work miner (mine, mine-and-publish, queue, progress, hashrate)",
    "source": "https://github.com/napplet/naps/pull/39",
    "revision": "f9038243c1d99dc053c5407533d1fc2e58a34b9a"
  },
  {
    "domain": "display",
    "name": "NAP-DISPLAY",
    "status": "Draft",
    "description": "Runtime-controlled pixel displays (list, push)",
    "source": "https://github.com/napplet/naps/pull/97",
    "revision": "137acd0618c236bb78762246cf7ec8a8934640c7"
  },
  {
    "domain": "class",
    "name": "NAP-CLASS",
    "status": "Deferred",
    "description": "Napplet class authority (sub-track root)",
    "source": "https://github.com/napplet/naps/pull/16",
    "revision": "4828279800dc1696452abd329a24ddb37e292bc5"
  },
  {
    "domain": "connect",
    "name": "NAP-CONNECT",
    "status": "Deferred",
    "description": "User-gated direct network access",
    "source": "https://github.com/napplet/naps/pull/19",
    "revision": "ec81a3a4a1fc4da1ad2601215353b7f822e44b8f"
  },
  {
    "domain": "webrtc",
    "name": "NAP-WEBRTC",
    "status": "Proposed",
    "description": "Define runtime-owned WebRTC signaling",
    "source": "https://github.com/napplet/naps/pull/59",
    "revision": "5fae95dd2c8e59bd06c654e0845656add077dcda"
  },
  {
    "domain": "serial",
    "name": "NAP-SERIAL",
    "status": "Proposed",
    "description": "define portable serial access",
    "source": "https://github.com/napplet/naps/pull/61",
    "revision": "a3891d4bab8ec9418a1ebacba9e261b89b7297ee"
  },
  {
    "domain": "ble",
    "name": "NAP-BLE",
    "status": "Proposed",
    "description": "Define portable BLE GATT access",
    "source": "https://github.com/napplet/naps/pull/62",
    "revision": "e14de22a794d24c2431834105d50efd0bd89d459"
  },
  {
    "domain": "system",
    "name": "NAP-SYSTEM",
    "status": "Proposed",
    "description": "Define read-only runtime diagnostics",
    "source": "https://github.com/napplet/naps/pull/64",
    "revision": "b896ed2d49e432211d2851633162b5c3071cb9d4"
  },
  {
    "domain": "common",
    "name": "NAP-COMMON",
    "status": "Proposed",
    "description": "Define common social actions",
    "source": "https://github.com/napplet/naps/pull/67",
    "revision": "de603e205a9b498f252be9a5e8e6825c4648df39"
  },
  {
    "domain": "lists",
    "name": "NAP-LISTS",
    "status": "Proposed",
    "description": "Define safe NIP-51 list mutations",
    "source": "https://github.com/napplet/naps/pull/68",
    "revision": "72fddac5def8f9bcbedd01dd942c530d89e335e0"
  },
  {
    "domain": "count",
    "name": "NAP-COUNT",
    "status": "Proposed",
    "description": "Define runtime-mediated filter counts",
    "source": "https://github.com/napplet/naps/pull/69",
    "revision": "c7447f7e3e33e08dad0448851f750044ef75965f"
  },
  {
    "domain": "blossom",
    "name": "NAP-BLOSSOM",
    "status": "Proposed",
    "description": "Add low-level Blossom blob access",
    "source": "https://github.com/napplet/naps/pull/71",
    "revision": "ca1d7ba594e6790785dc770227085d8648d39631"
  },
  {
    "domain": "torrent",
    "name": "NAP-TORRENT",
    "status": "Proposed",
    "description": "Add runtime-mediated torrent jobs",
    "source": "https://github.com/napplet/naps/pull/72",
    "revision": "60de1346e00ce62bbca11d32365f43b741f8c1b0"
  },
  {
    "domain": "hashtree",
    "name": "NAP-HASHTREE",
    "status": "Proposed",
    "description": "Add runtime-mediated document trees",
    "source": "https://github.com/napplet/naps/pull/73",
    "revision": "4f848fc151c3884030fa4bb1cd20095668b502c0"
  },
  {
    "domain": "dm",
    "name": "NAP-DM",
    "status": "Proposed",
    "description": "Define generic runtime direct messages",
    "source": "https://github.com/napplet/naps/pull/74",
    "revision": "a0a48588b3c9caca9540cccec19635b85231a00f"
  },
  {
    "domain": "fs",
    "name": "NAP-FS",
    "status": "Proposed",
    "description": "define policy-bound virtual filesystem access",
    "source": "https://github.com/napplet/naps/pull/88",
    "revision": "b640cf337c0481f0f9a0216c00843f797a5c6df6"
  },
  {
    "domain": "capture",
    "name": "NAP-CAPTURE",
    "status": "Proposed",
    "description": "define shell-mediated microphone recording",
    "source": "https://github.com/napplet/naps/pull/94",
    "revision": "c0173c9f354c0ea590f6e6b3ed9c77e10f5e2b5d"
  },
  {
    "domain": "catalog",
    "name": "NAP-CATALOG",
    "status": "Proposed",
    "description": "Define runtime napplet discovery",
    "source": "https://github.com/napplet/naps/pull/95",
    "revision": "7573383ffe33b9ef7c57248ec84736cc93d8d184"
  }
].map(row => Object.freeze(row)));
