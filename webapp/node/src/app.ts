import { Hono, type Context, type Next } from 'hono'
import { serve } from '@hono/node-server'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import ejs from 'ejs'
import Memcached from 'memcached'
import { createPool, Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import crypto from 'crypto'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Variables = {
  session: SessionData
  sessionId: string
}

const app = new Hono<{ Variables: Variables }>()
type AppContext = Context<{ Variables: Variables }>
type RenderParams = Record<string, unknown>
type CommentOptions = { allComments?: boolean }
type ParsedBodyValue = string | File | (string | File)[] | undefined
type ParsedBody = Record<string, ParsedBodyValue>

const POSTS_PER_PAGE = 20
const UPLOAD_LIMIT = 10 * 1024 * 1024
const IMAGE_DIR = path.resolve(__dirname, '../../public/image')

async function writeImage(id: number, ext: string, data: Buffer): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true })
  const filename = path.join(IMAGE_DIR, `${id}.${ext}`)
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true })
  }
}

const db: Pool = createPool({
  host: process.env.ISUCONP_DB_HOST || 'localhost',
  port: Number(process.env.ISUCONP_DB_PORT) || 3306,
  user: process.env.ISUCONP_DB_USER || 'root',
  password: process.env.ISUCONP_DB_PASSWORD,
  database: process.env.ISUCONP_DB_NAME || 'isuconp',
  connectionLimit: 1,
  charset: 'utf8mb4'
})

interface User {
  id: number
  account_name: string
  passhash: string
  authority: number
  del_flg: number
  created_at: Date
  csrfToken?: string
}

interface Post {
  id: number
  user_id: number
  imgdata?: Buffer
  body: string
  mime: string
  created_at: Date
  comment_count?: number
  comments?: Comment[]
  user?: User
}

interface Comment {
  id: number
  post_id: number
  user_id: number
  comment: string
  created_at: Date
  user?: User
}

interface CountRow {
  count: number
}

interface IdRow {
  id: number
}

interface PostRow extends RowDataPacket {
  id: number
  user_id: number
  body: string
  mime: string
  created_at: Date
  post_user_id: number
  post_user_account_name: string
  post_user_passhash: string
  post_user_authority: number
  post_user_del_flg: number
  post_user_created_at: Date
}

interface CommentRow extends RowDataPacket {
  id: number
  post_id: number
  user_id: number
  comment: string
  created_at: Date
  comment_count: number
  comment_user_id: number
  comment_user_account_name: string
  comment_user_passhash: string
  comment_user_authority: number
  comment_user_del_flg: number
  comment_user_created_at: Date
}

interface SessionData {
  userId?: number
  csrfToken?: string
  flashNotice?: string
}

const memcachedAddress = process.env.ISUCONP_MEMCACHED_ADDRESS || 'localhost:11211'
const memcached = new Memcached(memcachedAddress)
const SESSION_KEY_PREFIX = 'isuconp-node.session:'
const DEFAULT_SESSION_TTL = 24 * 60 * 60
const parsedTtl = Number(process.env.ISUCONP_SESSION_TTL)
const SESSION_TTL = Number.isFinite(parsedTtl) && parsedTtl > 0 ? Math.floor(parsedTtl) : DEFAULT_SESSION_TTL

function generateSessionId(): string {
  return crypto.randomBytes(16).toString('hex')
}

async function getSessionFromStore(sid: string): Promise<SessionData | undefined> {
  return new Promise((resolve) => {
    memcached.get(SESSION_KEY_PREFIX + sid, (err, data) => {
      if (err) {
        console.error('memcached get error', err)
        resolve(undefined)
        return
      }
      if (!data) {
        resolve(undefined)
        return
      }
      try {
        let raw: string
        if (typeof data === 'string') {
          raw = data
        } else if (Buffer.isBuffer(data)) {
          raw = data.toString('utf8')
        } else {
          resolve(undefined)
          return
        }
        resolve(JSON.parse(raw) as SessionData)
      } catch (e) {
        console.error('memcached parse error', e)
        resolve(undefined)
      }
    })
  })
}

async function saveSessionToStore(sid: string, session: SessionData): Promise<void> {
  return new Promise<void>((resolve) => {
    memcached.set(SESSION_KEY_PREFIX + sid, JSON.stringify(session), SESSION_TTL, (err) => {
      if (err) {
        console.error('memcached set error', err)
      }
      resolve()
    })
  })
}

async function deleteSessionFromStore(sid: string): Promise<void> {
  return new Promise<void>((resolve) => {
    memcached.del(SESSION_KEY_PREFIX + sid, (err) => {
      if (err) {
        console.error('memcached delete error', err)
      }
      resolve()
    })
  })
}

const SESSION_COOKIE_NAME = 'sid'

async function destroySession(c: AppContext): Promise<void> {
  const sid = c.get('sessionId')
  if (sid) {
    await deleteSessionFromStore(sid)
  }
  setCookie(c, SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' })
}

app.use('*', async (c: AppContext, next: Next): Promise<void> => {
  const existingSid = getCookie(c, SESSION_COOKIE_NAME)
  const sessionFromStore = existingSid ? await getSessionFromStore(existingSid) : undefined
  let session = sessionFromStore
  let isSessionDirty = false
  let sessionId: string
  if (session) {
    sessionId = existingSid as string
  } else {
    sessionId = generateSessionId()
    session = {}
    isSessionDirty = true
    setCookie(c, SESSION_COOKIE_NAME, sessionId, { httpOnly: true, path: '/' })
  }
  const sessionTarget = session as SessionData
  // Dirty tracking only observes direct property replacements; nested mutations require
  // assigning a new object back onto the session to persist.
  const trackedSession = new Proxy(sessionTarget, {
    set(target, prop, value) {
      const current = Reflect.get(target, prop)
      if (current !== value) {
        isSessionDirty = true
      }
      return Reflect.set(target, prop, value)
    },
    deleteProperty(target, prop) {
      if (Reflect.has(target, prop)) {
        isSessionDirty = true
      }
      return Reflect.deleteProperty(target, prop)
    }
  }) as SessionData
  c.set('session', trackedSession)
  c.set('sessionId', sessionId)
  try {
    await next()
  } finally {
    const latestSession = c.get('session') as SessionData | undefined
    if (latestSession === trackedSession && isSessionDirty) {
      await saveSessionToStore(sessionId, sessionTarget)
    }
  }
})

function shellEscape(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function digest(src: string): string {
  const command = `printf "%s" ${shellEscape(src)} | openssl dgst -sha512 | sed 's/^.*= //'`
  const result = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const message = (result.stderr || '').toString().trim()
    throw new Error(`openssl failed: ${message}`)
  }
  return result.stdout.replace(/^.*= /, '').trim()
}

function validateUser(accountName: string, password: string): boolean {
  return /^[0-9a-zA-Z_]{3,}$/.test(accountName) && /^[0-9a-zA-Z_]{6,}$/.test(password)
}

function calculatePasshash(accountName: string, password: string): string {
  const salt = digest(accountName)
  return digest(`${password}:${salt}`)
}

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(src: string): string {
  return src.replace(/[&<>"']/g, (char) => escapeMap[char] || char)
}

function formatBody(body: string): string {
  return escapeHtml(body).replace(/\r?\n/g, '<br>')
}

async function tryLogin(accountName: string, password: string): Promise<User | undefined> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM users WHERE account_name = ? AND del_flg = 0', [accountName])
  const user = rows[0] as User
  if (!user) return undefined
  const passhash = calculatePasshash(accountName, password)
  if (passhash === user.passhash) return user
  return undefined
}

async function dbInitialize(): Promise<void> {
  const sqls = [
    'DELETE FROM users WHERE id > 1000',
    'DELETE FROM posts WHERE id > 10000',
    'DELETE FROM comments WHERE id > 100000',
    'UPDATE users SET del_flg = 0'
  ]
  await Promise.all(sqls.map((sql) => db.query<ResultSetHeader>(sql)))
  await db.query<ResultSetHeader>('UPDATE users SET del_flg = 1 WHERE id % 50 = 0')
}

function imageUrl(post: Pick<Post, 'id' | 'mime'>): string {
  let ext = ''
  switch (post.mime) {
    case 'image/jpeg':
      ext = '.jpg'
      break
    case 'image/png':
      ext = '.png'
      break
    case 'image/gif':
      ext = '.gif'
      break
  }
  return `/image/${post.id}${ext}`
}

function makePostFromRow(row: PostRow): Post {
  return {
    id: row.id,
    user_id: row.user_id,
    body: row.body,
    mime: row.mime,
    created_at: row.created_at,
    user: {
      id: row.post_user_id,
      account_name: row.post_user_account_name,
      passhash: row.post_user_passhash,
      authority: row.post_user_authority,
      del_flg: row.post_user_del_flg,
      created_at: row.post_user_created_at,
    },
  }
}

async function makePosts(posts: Post[], options: CommentOptions = {}): Promise<Post[]> {
  if (posts.length === 0) return posts

  const postsById = new Map<number, Post>()
  for (const post of posts) {
    post.comment_count = 0
    post.comments = []
    postsById.set(post.id, post)
  }

  const rankedComments = `
    SELECT
      c.id,
      c.post_id,
      c.user_id,
      c.comment,
      c.created_at,
      COUNT(*) OVER (PARTITION BY c.post_id) AS comment_count,
      ROW_NUMBER() OVER (
        PARTITION BY c.post_id
        ORDER BY c.created_at DESC
      ) AS comment_rank,
      u.id AS comment_user_id,
      u.account_name AS comment_user_account_name,
      u.passhash AS comment_user_passhash,
      u.authority AS comment_user_authority,
      u.del_flg AS comment_user_del_flg,
      u.created_at AS comment_user_created_at
    FROM comments AS c
    INNER JOIN users AS u
      ON u.id = c.user_id
    WHERE c.post_id IN (?)
  `
  const query = options.allComments
    ? `${rankedComments} ORDER BY c.post_id, c.created_at ASC`
    : `
      SELECT *
      FROM (${rankedComments}) AS ranked
      WHERE comment_rank <= 3
      ORDER BY post_id, comment_rank DESC
    `
  const [commentRows] = await db.query<CommentRow[]>(query, [posts.map((post) => post.id)])

  for (const row of commentRows) {
    const post = postsById.get(row.post_id)
    if (!post) continue
    post.comment_count = row.comment_count
    post.comments!.push({
      id: row.id,
      post_id: row.post_id,
      user_id: row.user_id,
      comment: row.comment,
      created_at: row.created_at,
      user: {
        id: row.comment_user_id,
        account_name: row.comment_user_account_name,
        passhash: row.comment_user_passhash,
        authority: row.comment_user_authority,
        del_flg: row.comment_user_del_flg,
        created_at: row.comment_user_created_at,
      },
    })
  }

  return posts
}

async function render(c: AppContext, view: string, params: RenderParams): Promise<Response> {
  const session = c.get('session') as SessionData
  const messages = { notice: session.flashNotice }
  session.flashNotice = undefined
  const html = await ejs.renderFile(path.join(__dirname, '../views', view), { ...params, messages, formatBody })
  return c.html(html)
}

async function getSessionUser(c: AppContext): Promise<User | undefined> {
  const session = c.get('session') as SessionData
  if (!session.userId) return undefined
  const [rows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `id` = ?', [session.userId])
  const user = rows[0] as User
  if (user) user.csrfToken = session.csrfToken
  return user
}

function ensureString(value: ParsedBodyValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (typeof first === 'string') return first
  }
  return ''
}

const hasFileConstructor = typeof File !== 'undefined'

function ensureFile(value: ParsedBodyValue): File | undefined {
  if (!hasFileConstructor) return undefined
  if (value instanceof File) return value
  if (Array.isArray(value)) {
    const first = value[0]
    if (first instanceof File) return first
  }
  return undefined
}

function ensureStringArray(value: ParsedBodyValue): string[] {
  if (typeof value === 'undefined') return []
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  if (typeof value === 'string') return [value]
  return []
}

app.get('/initialize', async (c: AppContext) => {
  try {
    await dbInitialize()
    await rm(IMAGE_DIR, { recursive: true, force: true })
    return c.text('OK')
  } catch (e) {
    console.error(e)
    return c.text(String(e), 500)
  }
})

app.get('/login', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'login.ejs', { me })
})

app.post('/login', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = (await c.req.parseBody()) as ParsedBody
  try {
    const user = await tryLogin(ensureString(body.account_name), ensureString(body.password))
    const session = c.get('session') as SessionData
    if (user) {
      session.userId = user.id
      session.csrfToken = crypto.randomBytes(16).toString('hex')
      return c.redirect('/')
    } else {
      session.flashNotice = 'アカウント名かパスワードが間違っています'
      return c.redirect('/login')
    }
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.get('/register', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  return render(c, 'register.ejs', { me })
})

app.post('/register', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (me) return c.redirect('/')
  const body = (await c.req.parseBody()) as ParsedBody
  const accountName = ensureString(body.account_name)
  const password = ensureString(body.password)
  const session = c.get('session') as SessionData
  if (!validateUser(accountName, password)) {
    session.flashNotice = 'アカウント名は3文字以上、パスワードは6文字以上である必要があります'
    return c.redirect('/register')
  }
  const [rows] = await db.query<RowDataPacket[]>('SELECT 1 FROM users WHERE `account_name` = ?', [accountName])
  if (rows[0]) {
    session.flashNotice = 'アカウント名がすでに使われています'
    return c.redirect('/register')
  }
  const passhash = calculatePasshash(accountName, password)
  await db.query('INSERT INTO `users` (`account_name`, `passhash`) VALUES (?, ?)', [accountName, passhash])
  const [meRow] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `account_name` = ?', [accountName])
  const newUser = meRow[0] as User
  session.userId = newUser.id
  session.csrfToken = crypto.randomBytes(16).toString('hex')
  return c.redirect('/')
})

app.get('/logout', async (c: AppContext) => {
  await destroySession(c)
  return c.redirect('/')
})

app.get('/', async (c: AppContext) => {
  const startedAt = performance.now()

  try {
    const sessionUserStartedAt = performance.now()
    const me = await getSessionUser(c)
    const sessionUserMs = performance.now() - sessionUserStartedAt

    const postsSelectStartedAt = performance.now()
    const [postRows] = await db.query<RowDataPacket[]>(`
  SELECT
    p.id,
    p.user_id,
    p.body,
    p.created_at,
    p.mime,
    u.id AS post_user_id,
    u.account_name AS post_user_account_name,
    u.passhash AS post_user_passhash,
    u.authority AS post_user_authority,
    u.del_flg AS post_user_del_flg,
    u.created_at AS post_user_created_at
  FROM posts AS p
  INNER JOIN users AS u
    ON u.id = p.user_id
  WHERE u.del_flg = 0
  ORDER BY p.created_at DESC
  LIMIT ?
`, [POSTS_PER_PAGE])
    const postsSelectMs = performance.now() - postsSelectStartedAt

    const posts = (postRows as PostRow[]).map(makePostFromRow)

    const makePostsStartedAt = performance.now()
    const enriched = await makePosts(posts)
    const makePostsMs = performance.now() - makePostsStartedAt

    const renderStartedAt = performance.now()
    const response = await render(c, 'index.ejs', {
      posts: enriched,
      me,
      imageUrl,
    })
    const renderMs = performance.now() - renderStartedAt

    const totalMs = performance.now() - startedAt

    console.log(
      JSON.stringify({
        type: 'get-index-timing',
        sessionUserMs,
        postsSelectMs,
        makePostsMs,
        renderMs,
        totalMs,
      }),
    )

    response.headers.set(
      'Server-Timing',
      [
        `session-user;dur=${sessionUserMs.toFixed(2)}`,
        `posts-select;dur=${postsSelectMs.toFixed(2)}`,
        `make-posts;dur=${makePostsMs.toFixed(2)}`,
        `render;dur=${renderMs.toFixed(2)}`,
      ].join(', '),
    )

    return response
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.get('/:accountName{@[A-Za-z0-9_]+}', async (c: AppContext) => {
  try {
    const accountName = c.req.param('accountName')!.slice(1)
    const [urows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `account_name` = ? AND `del_flg` = 0', [accountName])
    const user = urows[0] as User
    if (!user) return c.text('not_found', 404)
    const [postRowData] = await db.query<PostRow[]>(`
      SELECT
        p.id,
        p.user_id,
        p.body,
        p.mime,
        p.created_at,
        u.id AS post_user_id,
        u.account_name AS post_user_account_name,
        u.passhash AS post_user_passhash,
        u.authority AS post_user_authority,
        u.del_flg AS post_user_del_flg,
        u.created_at AS post_user_created_at
      FROM posts AS p
      INNER JOIN users AS u
        ON u.id = p.user_id
      WHERE p.user_id = ?
        AND u.del_flg = 0
      ORDER BY p.created_at DESC
      LIMIT ?
    `, [user.id, POSTS_PER_PAGE])
    const posts = await makePosts(postRowData.map(makePostFromRow))
    const [commentCountRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM `comments` WHERE `user_id` = ?', [user.id])
    const commentCount = (commentCountRows[0] as CountRow | undefined)?.count ?? 0
    const [postIdRows] = await db.query<RowDataPacket[]>('SELECT `id` FROM `posts` WHERE `user_id` = ?', [user.id])
    const postIds = (postIdRows as IdRow[]).map((r) => r.id)
    const postCount = postIds.length
    let commentedCount = 0
    if (postCount > 0) {
      const [countRows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM `comments` WHERE `post_id` IN (?)', [postIds])
      commentedCount = (countRows[0] as CountRow | undefined)?.count ?? 0
    }
    const me = await getSessionUser(c)
    return render(c, 'user.ejs', { me, user, posts, post_count: postCount, comment_count: commentCount, commented_count: commentedCount, imageUrl })
  } catch (e) {
    console.error(e)
    return c.text('ERROR', 500)
  }
})

app.get('/posts', async (c: AppContext) => {
  const maxCreatedAtParam = c.req.query('max_created_at')
  let maxCreatedAt: Date | null = null
  if (typeof maxCreatedAtParam === 'string' && maxCreatedAtParam.length > 0) {
    const parsed = new Date(maxCreatedAtParam)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid max_created_at')
    }
    maxCreatedAt = parsed
  }
  const [postRows] = await db.query<PostRow[]>(`
    SELECT
      p.id,
      p.user_id,
      p.body,
      p.mime,
      p.created_at,
      u.id AS post_user_id,
      u.account_name AS post_user_account_name,
      u.passhash AS post_user_passhash,
      u.authority AS post_user_authority,
      u.del_flg AS post_user_del_flg,
      u.created_at AS post_user_created_at
    FROM posts AS p
    INNER JOIN users AS u
      ON u.id = p.user_id
    WHERE p.created_at <= ?
      AND u.del_flg = 0
    ORDER BY p.created_at DESC
    LIMIT ?
  `, [maxCreatedAt, POSTS_PER_PAGE])
  const posts = postRows.map(makePostFromRow)
  const me = await getSessionUser(c)
  const enriched = await makePosts(posts)
  return render(c, 'posts.ejs', { me, imageUrl, posts: enriched })
})

app.get('/posts/:id', async (c: AppContext) => {
  const id = c.req.param('id')
  const [postRows] = await db.query<PostRow[]>(`
    SELECT
      p.id,
      p.user_id,
      p.body,
      p.mime,
      p.created_at,
      u.id AS post_user_id,
      u.account_name AS post_user_account_name,
      u.passhash AS post_user_passhash,
      u.authority AS post_user_authority,
      u.del_flg AS post_user_del_flg,
      u.created_at AS post_user_created_at
    FROM posts AS p
    INNER JOIN users AS u
      ON u.id = p.user_id
    WHERE p.id = ?
      AND u.del_flg = 0
    LIMIT 1
  `, [id])
  const posts = postRows.map(makePostFromRow)
  const enriched = await makePosts(posts, { allComments: true })
  const post = enriched[0]
  if (!post) return c.text('not found', 404)
  const me = await getSessionUser(c)
  return render(c, 'post.ejs', { imageUrl, post, me })
})

app.post('/', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const file = ensureFile(body.file)
  if (!file) {
    session.flashNotice = '画像が必須です'
    return c.redirect('/')
  }
  let mime = file.type
  if (!(mime.includes('jpeg') || mime.includes('png') || mime.includes('gif'))) {
    session.flashNotice = '投稿できる画像形式はjpgとpngとgifだけです'
    return c.redirect('/')
  }
  if (file.size > UPLOAD_LIMIT) {
    session.flashNotice = 'ファイルサイズが大きすぎます'
    return c.redirect('/')
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  const [result] = await db.query<ResultSetHeader>('INSERT INTO `posts` (`user_id`, `mime`, `imgdata`, `body`) VALUES (?,?,?,?)', [me.id, mime, buffer, ensureString(body.body)])
  const insertId = result.insertId
  const ext = path.extname(imageUrl({ id: insertId, mime })).slice(1)
  if (ext) {
    try {
      await writeImage(insertId, ext, buffer)
    } catch (e) {
      console.error('failed to write image file', e)
    }
  }
  return c.redirect(`/posts/${encodeURIComponent(String(insertId))}`)
})

app.get('/image/:filename{[0-9]+\\.(png|jpg|gif)}', async (c: AppContext) => {
  try {
    const [idString, ext] = c.req.param('filename')!.split('.')
    const id = Number(idString)
    if (id === 0) {
      return new Response('', { status: 200 })
    }
    const [posts] = await db.query<RowDataPacket[]>('SELECT * FROM `posts` WHERE `id` = ?', [id])
    const post = (posts as Post[])[0]
    if (!post) return c.text('image not found', 404)
    if ((ext === 'jpg' && post.mime === 'image/jpeg') || (ext === 'png' && post.mime === 'image/png') || (ext === 'gif' && post.mime === 'image/gif')) {
      try {
        await writeImage(id, ext, post.imgdata!)
      } catch (e) {
        console.error('failed to write image file', e)
      }
      return new Response(new Uint8Array(post.imgdata!), { headers: { 'Content-Type': post.mime } })
    }
    return c.text('image not found', 404)
  } catch (e) {
    console.error(e)
    return c.text(String(e instanceof Error ? e.message : e), 500)
  }
})

app.post('/comment', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const postIdString = ensureString(body.post_id)
  if (!/^[0-9]+$/.test(postIdString)) return c.text('post_idは整数のみです')
  await db.query<ResultSetHeader>('INSERT INTO `comments` (`post_id`, `user_id`, `comment`) VALUES (?,?,?)', [Number(postIdString), me.id, ensureString(body.comment)])
  return c.redirect(`/posts/${encodeURIComponent(postIdString)}`)
})

app.get('/admin/banned', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/login')
  if (me.authority === 0) return c.text('authority is required', 403)
  const [userRows] = await db.query<RowDataPacket[]>('SELECT * FROM `users` WHERE `authority` = 0 AND `del_flg` = 0 ORDER BY `created_at` DESC')
  const users = userRows as User[]
  return render(c, 'banned.ejs', { me, users })
})

app.post('/admin/banned', async (c: AppContext) => {
  const me = await getSessionUser(c)
  if (!me) return c.redirect('/')
  if (me.authority === 0) return c.text('authority is required', 403)
  const body = (await c.req.parseBody()) as ParsedBody
  const session = c.get('session') as SessionData
  if (body.csrf_token !== session.csrfToken) return c.text('invalid CSRF Token', 422)
  const query = 'UPDATE `users` SET `del_flg` = ? WHERE `id` = ?'
  const ids = ensureStringArray(body.uid)
  await Promise.all(ids.map((id) => db.query<ResultSetHeader>(query, [1, id])))
  return c.redirect('/admin/banned')
})

app.use('/*', serveStatic({ root: '../public' }))

serve(
  { fetch: app.fetch, port: 8080 },
  (info: { port: number }) => {
    console.log(`server started on ${info.port}`)
  }
)
