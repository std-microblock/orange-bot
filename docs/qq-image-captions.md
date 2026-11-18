# QQ single-image captions

For the official QQ bot, a send containing one image and non-empty text is now
encoded as one media message with a plain caption. `say` already supplies both
parts together; the QQ serializer puts the image before the caption because the
QQ adapter flushes pending text when it encounters an image. The adapter then
sends `msg_type: 7` with both `content` and `media` in one request.

- Markdown captions use the existing plain-text conversion, preserving link
  targets. They are not rich Markdown messages.
- Native plain-text quote handling is retained. The existing Markdown/mention
  quote policy still applies to sends that are not normalized.
- Mentions (including raw QQ mention markup), buttons, files, and multiple images
  keep the existing send path and may still produce separate messages. The media
  request has a single `media` field, not an image array; this change does not
  promise an album or arbitrary rich-media composition.
- Text-only, image-only, userbot and other platform sends are unchanged.
- Upload, passive reply sequence, API limits, audit and retry remain delegated
  to the bridge and adapter; there is no new direct API request or resend fallback.

## Validation

From `packages/dsh-plugin-orange`, run `pnpm run test:qq-caption` with Node 24.
The wire test is opt-in: set `QQ_ADAPTER_PATH` to an installed
`@satorijs/adapter-qq` entry point (validated with 4.14.0). It runs the **real**
encoder with mocked OpenAPI methods; no credentials, service or live message is
needed. It reproduces the old two-request behavior, then asserts one media
request containing the caption, upload metadata, and passive-reply sequence,
for both group and C2C routing. Without that variable the wire test is explicitly
skipped, not counted as verified. This does not prove QQ server acceptance or a
particular client layout; a deployed live canary is still required for that.
