import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { QQOfficialClient, CrossgramClient, qqImageCaption, type OutboundPart } from '../src/satori.ts'

const image: OutboundPart = { type: 'image', src: 'https://example.com/image.png' }
const body: OutboundPart = { type: 'markdown', text: '**说明** [链接](https://example.com)' }

test('single image precedes a plain caption, keeps links and quote, without mutation', () => {
  const quote: OutboundPart = { type: 'quote', messageId: 'quoted' }
  const parts = [quote, body, image]
  assert.deepEqual(qqImageCaption(parts), [quote, image, { type: 'text', text: '说明 链接 https://example.com' }])
  assert.deepEqual(parts, [quote, body, image])
})

test('unsupported combinations retain their exact original parts', () => {
  const cases: OutboundPart[][] = [
    [body], [image], [{ type: 'text', text: '  ' }, image],
    [body, image, image], [body, image, { type: 'file', src: '/file' }],
    [{ type: 'at', userId: 'user' }, body, image],
    [body, image, { type: 'buttons', buttons: [] }],
    [{ type: 'markdown', text: '<qqbot-at-user id="user" />说明' }, image],
    [{ type: 'text', text: '<@user>说明' }, image],
    [body, { type: 'image', src: '' }],
  ]
  for (const parts of cases) assert.equal(qqImageCaption(parts), parts)
})

test('QQ serializer sends image then plain caption; userbot serializer stays unchanged', async () => {
  const cfg = { endpoint: 'http://unused.invalid', token: 'not-a-real-token' }
  for (const platform of ['qq', 'cg'] as const) {
    const client = platform === 'qq'
      ? new QQOfficialClient('qq', cfg, () => {})
      : new CrossgramClient('cg', cfg, () => {})
    let request: any
    client.ext = async (_method, args) => { request = args; return [{ id: 'sent' }] as any }
    client.api = async (_method, args) => { request = args; return [{ id: 'sent' }] as any }
    assert.deepEqual(await client.send('channel', false, [body, image]), ['sent'])
    const content = request.content
    if (platform === 'qq') {
      assert.match(content, /^<img[^>]+\/>说明/)
      assert.doesNotMatch(content, /qq:markdown/)
    } else {
      assert.equal(content, '🤖 说明 链接 https://example.com<img src="https://example.com/image.png"/>')
      assert.ok(content.indexOf('<img') > 0)
    }
  }
})

// Opt-in wire test against the installed adapter, with only its OpenAPI mocked.
// QQ_ADAPTER_PATH=/absolute/path/to/@satorijs/adapter-qq node --experimental-transform-types --test test/*.test.ts
const adapterPath = process.env.QQ_ADAPTER_PATH
const require = createRequire(import.meta.url)
test('real QQ encoder emits one content+media message for group and C2C', { skip: !adapterPath }, async () => {
  const { QQMessageEncoder } = require(adapterPath!)
  for (const direct of [false, true]) {
    const sent: any[] = []
    const uploads: any[] = []
    const session = (event: any = {}) => {
      const message = event.message ?? {}
      return {
        event: { ...event, message },
        get messageId() { return message.id },
        set messageId(id) { message.id = id },
        channelId: event.channel?.id,
        isDirect: event.channel?.type === 1,
        app: { serial: async () => false, emit: () => {} },
        transform: async (elements: any) => elements,
      }
    }
    const upload = async (_id: string, data: any) => { uploads.push(data); return { file_info: 'uploaded-image' } }
    const send = async (_id: string, data: any) => { sent.push(data); return { id: `message-${sent.length}`, timestamp: new Date().toISOString() } }
    const bot = {
      session,
      config: { uploadThreshold: Infinity, retryWhen: [] },
      ctx: { http: { isLocal: async () => false } },
      http: { isError: () => false },
      internal: {
        sendFilePrivate: upload, sendFileGuild: upload,
        sendPrivateMessage: direct ? send : () => assert.fail('wrong route'),
        sendMessage: direct ? () => assert.fail('wrong route') : send,
      },
    }
    const passive = Object.assign(session({ channel: { id: 'channel', type: direct ? 1 : 0 }, message: { id: 'trigger' } }), { timestamp: Date.now(), userId: 'channel' })
    const client = new QQOfficialClient('qq', { endpoint: 'http://unused.invalid', token: '' }, () => {})
    client.ext = async (_method, args: any) => {
      const encoder = new QQMessageEncoder(bot, args.channelId, undefined, { session: passive })
      return await encoder.send(args.content) as any
    }
    // Original order reproduces the split in the real encoder.
    await new QQMessageEncoder(bot, 'channel', undefined, { session: passive }).send('说明<img src="https://example.com/image.png"/>')
    assert.equal(sent.length, 2)
    sent.length = 0
    uploads.length = 0
    assert.deepEqual(await client.send('channel', direct, [body, image]), ['message-1'])
    assert.equal(sent.length, 1)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].srv_send_msg, false)
    assert.equal(sent[0].msg_type, 7)
    assert.equal(sent[0].content, '说明 链接 https://example.com')
    assert.deepEqual(sent[0].media, { file_info: 'uploaded-image' })
    assert.equal(sent[0].msg_id, 'trigger')
    assert.equal(sent[0].msg_seq, 3)
    assert.equal(sent[0].markdown, undefined)
  }
})
