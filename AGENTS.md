# DSH Friends / DSH 搭子

- This repository is a standalone plugin for official DeepSeek Harness (DSH). WorkDSH is a compatible host, not a dependency.
- Current milestone: implement the native DSH plugin after the compact design prototype. Clearly distinguish verified Host/Client integration, local-relay testing and unverified public-network behavior.
- Integrate through public DSH bundle, Host/Client, sidebar and main-panel APIs. Never patch official packages or copy the official conversation UI.
- Preserve host theme, keyboard access, nested scrolling, narrow-window behavior and lifecycle cleanup.
- Profile discovery is explicitly opt-in. Never scan installations, publish credentials/workspaces/conversations, or treat nickname as verified identity.
- Private keys stay in a verified Host-side protected store; never put them in browser storage, frontend bundles, logs or messages. If no suitable protected store exists, stop identity persistence and document the gap.
- Use maintained Nostr implementations and official vectors, not custom cryptography. Network send/receive statuses must describe observable facts.
- Fixtures and simulated actions must remain visibly labelled. Tests use synthetic identities and data.
- Do not add paid infrastructure, analytics, automatic public announcements or public-relay write tests without task authorization.
- Update docs when the product, UI or wire protocol changes. Keep proposals separate from verified integration.

- Product direction (2026-10-31): public conversation first. Default Lobby / Messages / Contacts / Me; friendship is optional after interaction. No-identity reading and first-post identity setup are now implemented in the native plugin, with public-network acceptance records. Keep existing encrypted private messaging as a later step.

- Current package: 0.1.0-alpha.10. Public kind 9 lobby and NIP-42 private-subscription authentication are implemented. Preserve separate public/private subscriptions and Host-only challenge signing.
- Chat UI uses left/right bubbles with top navigation and top default-room tabs. The user approved an independent plum palette for the plugin; preserve the surrounding host UI. Do not regress to a wide log list or move reply controls away from their messages.
- Public acceptance scripts are opt-in and must never run as part of default tests/CI. Document exact host/platform/network scope; the two-physical-network and dataelement Desktop gates remain open.

- New macOS users use automatic local identity through the verified system Keychain adapter; random unlock secrets never enter argv, Client RPC or logs. Preserve locked legacy identities and keep their manual recovery optional. Never require identity for public history, browsing or settings. Do not claim automatic identity works on unverified OS providers.

- alpha.8 adds Windows DPAPI CurrentUser support; Windows execution and Desktop acceptance are pending. Never label a macOS-skipped Windows integration test as passed.

- Distribution: one version and one universal .tgz for macOS and Windows. OS-specific secure-store providers stay internal; distinguish implementation from platform acceptance in the shared installation guide, never publish separate OS-labelled plugin artifacts.

- alpha.9 adds Host-side static Windows system proxy / environment proxy routing and inline redacted connection diagnostics. PAC-only settings are unsupported and must not silently bypass the configured proxy. Windows field verification remains pending.

- alpha.10 default relay is relay.techflag.cn. Latest product requirement: persist aggregate operational statistics and HMAC deduplication identifiers, never chat content/private envelopes. Routing/discovery metadata may be memory-only and bounded. No offline server replay; preserve client-local received history. Public dashboard is read-only; never expose user/IP/key lists.

- Final history policy explicitly selected by user: public rooms cache at most 100 recent events each for up to 24 hours in memory, cleared on server restart. Never persist chat bodies/envelopes to disk/logs; private envelopes have no cache. Operational counters persist. Public disclosures must say chat is not persisted to disk, not that no chat is temporarily cached.
