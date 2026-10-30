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

- Product direction (2026-10-31): public conversation first. Default Lobby / Messages / Contacts / Me; friendship is optional after interaction. No-identity reading and first-post identity setup are planned native capabilities, not implemented by the offline prototype. Keep existing encrypted private messaging as a later step.
