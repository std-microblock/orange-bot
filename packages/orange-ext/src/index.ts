import type { Context } from 'cordis'
import type {
  ActivePlatformSession, IMMessage, IMMessagePart, IMMessageSnapshot, IMPlatform,
  IMSticker, IMStickerProvider, JsonValue, PlatformSession, StickerProviderContext,
} from '@mtproto-relay/bridge'
import { providerBelongsToAccount } from '@mtproto-relay/bridge'
import z from 'schemastery'

/**
 * Orange bot extensions next to satori-exporter: reactions, merged-forward
 * bundle expansion, stickers, recall, and structured message lookup that
 * Satori's element model cannot express. Bearer-token protected JSON POST
 * endpoints under `path`.
 */
export interface Config {
  path: string
  token: string
  platformId: string
}

export const Config: z<Config> = z.object({
  path: z.string().default('/orange'),
  token: z.string().required(),
  platformId: z.string().default('qqnt'),
})

export const name = 'orange-ext'
export const inject = ['server', 'imPlatform', 'imSticker', 'satori']

const MAX_BODY = 64 * 1024
/** Largest sticker this route will inline as base64 (the CDN URL is preferred). */
const MAX_STICKER_BYTES = 12 * 1024 * 1024

/** Structural slice of `@satorijs/core`'s Bot: enough to dispatch custom events. */
interface SatoriBot {
  platform: string
  session(payload: Record<string, unknown>): unknown
  dispatch(session: unknown): void
}

function qqMessageSequenceFromMetadata(metadata?: Record<string, unknown>): number | undefined {
  const value = metadata?.qqMsgSeq
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function readJson(req: { body?: ReadableStream<Uint8Array> | null }): Promise<any> {
  const reader = req.body?.getReader()
  if (!reader) return {}
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('body too large') }
    chunks.push(Buffer.from(value))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('orange-ext')
  const prefix = config.path.replace(/\/$/, '')

  const binding = (): ActivePlatformSession => {
    const found = ctx.imPlatform.sessions.find((item) => item.session.platformId === config.platformId)
    if (!found) throw new Error(`platform ${config.platformId} is not active`)
    return found
  }

  const mediaUrl = async (platform: IMPlatform, session: PlatformSession, media: any) => {
    try { return (await platform.resolveMediaUrl?.(session, media))?.url } catch { return undefined }
  }

  // ---- stickers ------------------------------------------------------------
  /**
   * The sticker providers that belong to this account. The QQNT adapter exposes
   * the account's QQ 收藏表情 collection and the market packs through
   * `ctx.imSticker`, and none of that reaches Satori's element model — the
   * orange bot asks for it here instead.
   */
  const stickerProviders = (platform: IMPlatform, session: PlatformSession): IMStickerProvider[] => {
    const kind = platform.platformKind ?? session.platformId
    const found: IMStickerProvider[] = []
    for (const id of ctx.imSticker.ids) {
      const provider = ctx.imSticker.get(id)
      if (provider && providerBelongsToAccount(provider, session.platformId, kind)) found.push(provider)
    }
    return found
  }

  const stickerContext = (platform: IMPlatform, session: PlatformSession, conversationId?: string): StickerProviderContext => ({
    session,
    conversation: conversationId ? { id: String(conversationId) } : undefined,
    platformKind: platform.platformKind ?? session.platformId,
  })

  /**
   * One sticker as the bot needs it: the metadata for the panel, the native
   * reference that lets it be sent back as a real QQ 表情 (Satori's
   * `data-crossgram-sticker-*` attributes), and a direct CDN URL when the
   * provider can resolve one so the bytes never travel through this route.
   */
  const renderSticker = async (provider: IMStickerProvider, context: StickerProviderContext, sticker: IMSticker) => {
    let reference: JsonValue | undefined
    try {
      const plan = await provider.prepareSend?.(context, sticker)
      if (plan && plan.type === 'native') reference = plan.reference
    } catch {}
    let url: string | undefined
    try { url = (await provider.resolveAssetUrl?.(context, sticker))?.url } catch {}
    return {
      providerId: sticker.providerId,
      stickerId: sticker.stickerId,
      packId: sticker.packId,
      title: sticker.title,
      format: sticker.format,
      mimeType: sticker.mimeType,
      width: sticker.width,
      height: sticker.height,
      size: sticker.size,
      reference,
      url,
    }
  }

  /** Render one message (or bundle snapshot) into a JSON-friendly shape with resolved media URLs. */
  const render = async (platform: IMPlatform, session: PlatformSession, message: IMMessage | IMMessageSnapshot) => {
    const parts: any[] = []
    for (const part of message.content.parts as IMMessagePart[]) {
      // ponytail: consumers see one id space — the numeric QQ id. The raw NT uid
      // stays internal to the bridge; without a numeric mapping the uid passes through as-is.
      if (part.type === 'text') parts.push({ type: 'text', text: part.text, entities: part.entities?.map((entity) => entity.type === 'mention' && entity.numericId ? { ...entity, userId: entity.numericId } : entity) })
      else if (part.type === 'media') {
        parts.push({
          type: 'media', kind: part.media.kind, name: part.media.name, mimeType: part.media.mimeType,
          size: part.media.size, width: part.media.width, height: part.media.height,
          url: await mediaUrl(platform, session, part.media),
        })
      } else if (part.type === 'sticker') parts.push({ type: 'sticker', title: part.sticker.title ?? part.sticker.stickerId })
      else if (part.type === 'card') parts.push({ type: 'card', ...part.card })
      else if (part.type === 'message-bundle') {
        parts.push({ type: 'forward', id: part.bundle.id, title: part.bundle.title, preview: part.bundle.preview, locator: part.bundle.locator })
      }
    }
    const sender = message.sender
    const senderAvatar = sender?.avatar ? await mediaUrl(platform, session, sender.avatar) : undefined
    // ponytail: numeric QQ id first (matches exporter's satoriUser and admin
    // allowlists); the opaque NT uid only when the bridge has no mapping.
    const senderNumeric = typeof (sender as any)?.metadata?.qq === 'string' && (sender as any).metadata.qq ? (sender as any).metadata.qq : undefined
    return {
      id: message.id,
      senderAvatar,
      senderId: senderNumeric ?? message.senderId,
      senderName: sender ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || message.senderId : message.senderId,
      senderTitle: message.senderTitle,
      timestamp: message.timestamp * 1000,
      replyToId: message.replyToId,
      parts,
      recalled: message.recalled,
    }
  }

  const route = (method: string, handler: (body: any) => Promise<unknown>) => {
    ctx.server.post(`${prefix}/${method}`, async (req: any, res: any) => {
      if (req.headers.get('authorization') !== `Bearer ${config.token}`) {
        res.status = 401
        res.json({ error: 'unauthorized' })
        return
      }
      try {
        const body = await readJson(req)
        res.status = 200
        res.json({ ok: true, result: await handler(body) })
      } catch (error) {
        logger.warn('%s failed: %s', method, error instanceof Error ? error.message : String(error))
        res.status = 500
        res.json({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  /** {channelId, messageId} -> structured message incl. forward bundle locators. */
  route('message.get', async ({ channelId, messageId }) => {
    const { platform, session } = binding()
    if (!platform.getMessage) throw new Error('message lookup unsupported')
    const message = await platform.getMessage(session, { id: String(channelId) }, String(messageId))
    if (!message) throw new Error('message not found')
    return render(platform, session, message)
  })

  /** {locator} -> snapshots inside a merged-forward bundle (nested bundles keep their locator). */
  route('forward.get', async ({ locator }) => {
    const { platform, session } = binding()
    if (!platform.messageBundles) throw new Error('bundles unsupported')
    const snapshots = await platform.messageBundles.load(session, locator)
    return Promise.all(snapshots.map((snapshot) => render(platform, session, snapshot)))
  })

  /** {channelId, messageId, reactionKeys[]} -> sets this account's reactions on the message. */
  route('reaction.set', async ({ channelId, messageId, reactionKeys }) => {
    const { platform, session } = binding()
    if (!platform.setMessageReactions) throw new Error('reactions unsupported')
    const message = await platform.getMessage?.(session, { id: String(channelId) }, String(messageId))
    const seq = message ? qqMessageSequenceFromMetadata(message.metadata) : undefined
    const context = await platform.setMessageReactions(session, {
      conversationId: String(channelId),
      messageId: String(messageId),
      targetId: message?.sourceIds?.[0] ?? String(messageId),
      nativeSequence: seq === undefined ? undefined : String(seq),
    }, Array.isArray(reactionKeys) ? reactionKeys.map(String) : [])
    return { reactions: context.reactions }
  })

  /** {channelId, before?, limit?} -> history page, oldest first. */
  route('history.list', async ({ channelId, before, limit }) => {
    const { platform, session } = binding()
    if (!platform.getHistory) throw new Error('history unsupported')
    const count = Math.min(100, Math.max(1, Number(limit) || 50))
    const query = before ? { before: { id: String(before), timestamp: 0 }, limit: count } : { latest: true, limit: count }
    const page = await platform.getHistory(session, { id: String(channelId) }, query as any)
    const messages = [...page.messages].filter((m) => !m.recalled).sort((a, b) => a.timestamp - b.timestamp).slice(-count)
    return Promise.all(messages.map((message) => render(platform, session, message)))
  })

  /** {channelId} -> conversation info. */
  route('conversation.get', async ({ channelId }) => {
    const { platform, session } = binding()
    const conversation = await platform.getConversation?.(session, String(channelId))
    const avatar = conversation?.avatar ? await mediaUrl(platform, session, conversation.avatar) : undefined
    return conversation ? { id: conversation.id, kind: conversation.kind, title: conversation.title, avatar } : null
  })

  /**
   * {channelId} -> the members holding a privileged role (owner / administrator).
   * Satori's `guild.member.get` (which satori-exporter does implement) throws the
   * role away, so this is the only way a client can tell a 群主 / 群管理员 from an
   * ordinary 群友 on the userbot side. Only the privileged few are returned: a
   * 2000-member group's roster would otherwise have to travel in full.
   */
  route('member.roles', async ({ channelId }) => {
    const { platform, session } = binding()
    if (!platform.getConversationMembers || !platform.capabilities?.members?.list) throw new Error('member listing unsupported')
    const members: { id: string, role: string, name?: string }[] = []
    let cursor: string | undefined
    let total = 0
    // A very large group pages through 500 members at a time; stop rather than scan forever.
    for (let page = 0; page < 40; page++) {
      const result = await platform.getConversationMembers(session, { id: String(channelId) }, { cursor, limit: 500 })
      total = result.total ?? total
      for (const member of result.members) {
        if (member.role !== 'owner' && member.role !== 'administrator') continue
        members.push({ id: member.user.id, role: member.role, name: member.user.firstName ?? undefined })
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
    return { members, total }
  })

  // Live feed of every committed message, including this account's own outgoing ones
  // (satori-exporter drops those, but the userbot account is also the admin's account).
  // Rides the standard Satori event socket as a custom `orange-message` event. The
  // `_payload` field crosses the Satori wire untouched (underscore keys are exempt
  // from the snake_case transform), so the client reads the rendered shape as-is.
  // `bot-added` fires from the Bot constructor before `platform` is assigned, so a
  // cached reference cannot be filtered by platform at event time — resolve the
  // exporter bot from `ctx.bots` on every message instead.
  const qqBot = (): SatoriBot | undefined =>
    ((ctx as any).bots ?? []).find((candidate: SatoriBot) => candidate.platform === 'qq')

  let seen = 0
  route('debug', async () => ({ seen, bot: Boolean(qqBot()) }))
  ctx.on('im-platform/event-committed' as any, (session: PlatformSession, committed: any) => {
    seen++
    if (session.platformId !== config.platformId || committed.event.type !== 'message' || !committed.result?.created) return
    const bot = qqBot()
    if (!bot) { logger.warn('message skipped: no qq bot in ctx.bots'); return }
    const found = ctx.imPlatform.sessions.find((item) => item.session.platformSessionId === session.platformSessionId)
    if (!found) return
    const conversation = committed.event.conversation
    const message = committed.event.message
    void render(found.platform, session, message).then((rendered) => {
      bot?.dispatch(bot.session({
        type: 'orange-message',
        _payload: {
          conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
          message: rendered,
          outgoing: !!message.outgoing,
        },
      }))
    }).catch((error) => logger.warn('feed render failed: %s', error instanceof Error ? error.message : String(error)))
  }, { global: true } as any)

  /** {fromChannelId, messageIds[], toChannelId} -> merged (or single) native forward; used for tests and by the agent. */
  route('forward.send', async ({ fromChannelId, messageIds, toChannelId }) => {
    const { platform, session } = binding()
    if (!platform.forwardMessages) throw new Error('forward unsupported')
    const sent = await platform.forwardMessages(session, { id: String(fromChannelId) }, (messageIds as unknown[]).map(String), { id: String(toChannelId) })
    return sent.map((m) => ({ id: m.id }))
  })

  /** {} -> available reaction keys with titles. */
  route('reaction.catalog', async ({ channelId }) => {
    const { platform, session } = binding()
    const context = await platform.getAvailableReactions?.(session, { conversationId: String(channelId ?? '') })
    return (context?.available ?? []).map((item) => ({
      key: item.key,
      title: item.title,
      alt: item.presentation.type === 'emoji' ? item.presentation.emoticon : item.presentation.alt,
    }))
  })

  // ---- sticker routes ------------------------------------------------------
  /** {} -> every sticker pack this account can see (QQ 收藏表情 is the pack `qq-favorites`). */
  route('sticker.packs', async () => {
    const { platform, session } = binding()
    const context = stickerContext(platform, session)
    const packs: any[] = []
    for (const provider of stickerProviders(platform, session)) {
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const result = await provider.listPacks(context, { cursor, limit: 200 })
        for (const pack of result.packs) packs.push({ ...pack, providerId: pack.providerId ?? provider.capabilities?.ownerPlatformId ?? '' })
        cursor = result.nextCursor
        if (!cursor) break
      }
    }
    return { packs }
  })

  /**
   * {packId?} -> the account's saved/favorite stickers (default) or one pack's
   * contents. Each entry carries the native send reference, so the bot can hand
   * it straight back to Satori when it wants to send that exact 表情.
   */
  route('sticker.list', async ({ packId }) => {
    const { platform, session } = binding()
    const context = stickerContext(platform, session)
    const stickers: any[] = []
    const errors: string[] = []
    for (const provider of stickerProviders(platform, session)) {
      try {
        if (packId) {
          const pack = await provider.getPack(context, String(packId))
          if (!pack) continue
          for (const sticker of pack.stickers) stickers.push(await renderSticker(provider, context, sticker))
          continue
        }
        if (!provider.listSavedStickers) continue
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = await provider.listSavedStickers(context, { cursor, limit: 200 })
          for (const sticker of result.stickers) stickers.push(await renderSticker(provider, context, sticker))
          cursor = result.nextCursor
          if (!cursor) break
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { stickers, errors }
  })

  /** {providerId, stickerId} -> the sticker's bytes, base64 (fallback for URLs that will not load). */
  route('sticker.asset', async ({ providerId, stickerId }) => {
    const { platform, session } = binding()
    const context = stickerContext(platform, session)
    const provider = ctx.imSticker.get(String(providerId))
    if (!provider) throw new Error(`unknown sticker provider ${providerId}`)
    const sticker = await provider.getSticker(context, String(stickerId))
    if (!sticker) throw new Error(`sticker ${stickerId} not found`)
    const asset = await provider.openAsset(context, sticker)
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of asset.source.stream()) {
      size += chunk.byteLength
      if (size > MAX_STICKER_BYTES) throw new Error('sticker too large to inline')
      chunks.push(chunk)
    }
    return {
      mimeType: asset.mimeType,
      size: asset.size ?? size,
      width: asset.width,
      height: asset.height,
      data: Buffer.concat(chunks).toString('base64'),
    }
  })

  /** {channelId, messageIds[]} -> recall our own messages (撤回所有人). */
  route('message.recall', async ({ channelId, messageIds }) => {
    const { platform, session } = binding()
    if (!platform.deleteMessages) throw new Error('recall unsupported')
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(String).filter(Boolean).slice(0, 10)
    if (!ids.length) throw new Error('messageIds required')
    await platform.deleteMessages(session, { id: String(channelId) }, ids, { forEveryone: true })
    return { recalled: ids }
  })
}
