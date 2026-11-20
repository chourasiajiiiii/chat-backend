# Chat Backend

A small chat backend in Node.js + TypeScript.

- **PostgreSQL** holds users, chats and who is a member of which chat.
- **Firebase Firestore** holds the messages, read receipts and each user's "last seen" message.

It supports 1:1 chats, sending and fetching messages in order, read receipts and last seen tracking. Group chats and message edit/delete (the optional part) are done too.

## Tech

- Node.js 22+, TypeScript with `strict` (plus `noUncheckedIndexedAccess`)
- Express 5
- PostgreSQL via `pg`, plain SQL migrations in `migrations/`
- Firebase Admin SDK for Firestore
- Zod for request validation
- Vitest + Supertest. The tests hit a real Postgres database and the Firestore emulator, nothing is mocked.

## Getting started

You need Node 22+, Docker (or any Postgres 13+), and Java 21+ if you want to run the Firestore emulator.

```bash
npm install
docker compose up -d          # postgres on :5432, creates chat_app and chat_app_test
cp .env.example .env
```

Then either point `.env` at a real Firebase project (`FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_PATH`), or use the emulator:

```bash
# .env
FIREBASE_PROJECT_ID=demo-chat-backend
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080

# separate terminal
npx firebase emulators:start --only firestore --project demo-chat-backend
```

Start the API:

```bash
npm run dev        # or: npm run build && npm start
```

Migrations run automatically on startup (they're also available as `npm run migrate`).

## Tests

```bash
npm test
```

This starts the Firestore emulator, runs the suite against the `chat_app_test` database and shuts the emulator down again. Set `TEST_DATABASE_URL` if your test database lives somewhere else. The test setup refuses to run against a database whose name doesn't end in `_test`, because it truncates the tables.

If you already have the emulator running, `npm run test:only` skips starting it.

## API

All bodies are JSON. Ids for users and chats are UUIDs; message ids are Firestore document ids.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/user/create` | `{ name }` | helper to create users, not in the spec |
| POST | `/chat/create` | `{ userAId, userBId }` | returns `{ chatId, created }`. 201 when new, 200 when the chat already existed |
| POST | `/chat/:chatId/message/send` | `{ senderId, text }` | sender must be a member |
| GET | `/chat/:chatId/messages` | `?limit=50&before=<messageId>` | latest `limit` messages, oldest first. `before` pages back in history |
| POST | `/chat/:chatId/message/:messageId/read` | `{ userId }` | read receipt |
| POST | `/chat/:chatId/lastseen` | `{ userId, messageId }` | last seen message for that user |
| GET | `/chat/:chatId/lastseen` | | last seen of every current member |
| GET | `/user/:userId/chats` | | chats with member ids, most recently active first |
| POST | `/chat/group/create` | `{ createdBy, name, memberIds[] }` | creator becomes admin |
| GET | `/chat/:chatId` | | chat details with members and roles |
| POST | `/chat/:chatId/members/add` | `{ userId, memberIds[] }` | admin only |
| POST | `/chat/:chatId/members/remove` | `{ userId, memberId }` | admin removes anyone, a member can remove themselves |
| POST | `/chat/:chatId/rename` | `{ userId, name }` | admin only |
| POST | `/chat/:chatId/message/:messageId/edit` | `{ senderId, text }` | sender only |
| POST | `/chat/:chatId/message/:messageId/delete` | `{ senderId }` | sender only, soft delete |
| GET | `/health` | | |

Errors always look like this:

```json
{ "error": { "code": "validation_error", "message": "Request validation failed", "details": [{ "field": "userBId", "message": "Invalid UUID" }] } }
```

Status codes: 400 for bad input, 403 when the user isn't allowed (e.g. not a member of the chat), 404 for missing users/chats/messages, 409 when editing a deleted message.

### Quick walkthrough

```bash
curl -s -X POST localhost:3000/user/create -H 'Content-Type: application/json' -d '{"name":"Alice"}'
curl -s -X POST localhost:3000/user/create -H 'Content-Type: application/json' -d '{"name":"Bob"}'

curl -s -X POST localhost:3000/chat/create -H 'Content-Type: application/json' \
  -d '{"userAId":"<alice>","userBId":"<bob>"}'
# {"chatId":"...","created":true}

curl -s -X POST localhost:3000/chat/<chatId>/message/send -H 'Content-Type: application/json' \
  -d '{"senderId":"<alice>","text":"hey bob"}'

curl -s "localhost:3000/chat/<chatId>/messages?limit=50"

curl -s -X POST localhost:3000/chat/<chatId>/message/<messageId>/read -H 'Content-Type: application/json' \
  -d '{"userId":"<bob>"}'

curl -s -X POST localhost:3000/chat/<chatId>/lastseen -H 'Content-Type: application/json' \
  -d '{"userId":"<bob>","messageId":"<messageId>"}'

curl -s localhost:3000/user/<alice>/chats
```

A message looks like:

```json
{
  "id": "Xb3kq0yW1sJ2mVZp9TQe",
  "chatId": "0b6f2c1e-...",
  "senderId": "4f1d...",
  "text": "hey bob",
  "createdAt": "2026-11-20T06:12:41.502Z",
  "editedAt": null,
  "deleted": false,
  "readBy": { "9a7c...": "2026-11-20T06:12:44.118Z" }
}
```

## Data model

### PostgreSQL

```
users         (id, name, created_at)
chats         (id, type 'direct'|'group', name, direct_key unique, created_by, created_at, last_message_at)
chat_members  (chat_id, user_id, role 'admin'|'member', joined_at)   pk (chat_id, user_id)
```

### Firestore

```
chats/{chatId}/messages/{messageId}   senderId, text, createdAt, editedAt, deleted, deletedAt, readBy{userId: time}
chats/{chatId}/lastSeen/{userId}      userId, messageId, messageCreatedAt, updatedAt
```

The `chatId` in Firestore paths is the same id as the Postgres chat row, so the two line up without a separate mapping.

## How some of the trickier parts work

**One 1:1 chat per pair.** `chats.direct_key` stores the two user ids sorted (`"<smaller>:<bigger>"`) and has a unique index. Creating a chat is `insert ... on conflict (direct_key) do nothing` and then a select if nothing was inserted. Asking for A+B and B+A at the same moment ends up with one chat (there's a test that fires 10 requests in parallel).

**Message order.** `createdAt` is a Firestore server timestamp, so the order comes from the server clock rather than the client's clock. Messages are listed with `orderBy('createdAt')`. When a query orders by a single field, Firestore uses the document id to break ties, so two messages with the same timestamp still come back in a stable order. Paging with `before` uses a document cursor, so it never skips or repeats a message. This only needs Firestore's default single-field index.

My first version gave each message a `seq` number from a counter document, assigned in a transaction. It looked neat, but every send in a chat had to lock the same document. When I fired 55 messages at one chat in parallel, some failed with `Transaction lock timeout`. Now sending is one plain write with no shared document, and the tests send 100 messages into one chat at once.

**Read receipts.** Each message has a `readBy` map of `userId -> first time they read it`. Marking a message read again keeps the original time, and marking your own message is a no-op. A map is fine here since it's bounded by the number of chat members, and it comes back with the message for free.

**Last seen.** One document per user per chat. It only moves forward: if a request for an older message arrives after a newer one (e.g. out of order from a flaky client), the newer value is kept and the response says `updated: false`. "Older" is decided the same way the message list is ordered (timestamp, then id), so the two always agree.

**Keeping Postgres and Firestore in line.** Postgres is the source of truth for who is in a chat, so every write checks membership there before touching Firestore. After a message is saved, `chats.last_message_at` is updated in Postgres so the chat list can be sorted by activity. If that update fails, the error is logged rather than failing the send, since the message itself is already stored.

**Groups.** The creator is admin. Admins add/remove members and rename the group, and anyone can leave. If the last admin leaves, the member who has been in the group longest is promoted so the group isn't left without an admin. Membership changes lock the chat row so two of them can't interleave.

**Edit/delete.** Only the sender can do either. Delete is a soft delete: the text is cleared and `deleted: true` is set, so the message stays in place in the history with its read receipts.

## Things I'd add for production

- Authentication. User ids come in the request body because that's how the task describes the API. In a real app they would come from a verified token (e.g. Firebase Auth) and the body fields would go away.
- Real-time delivery. Clients can listen to `chats/{chatId}/messages` with Firestore listeners directly, with security rules based on membership. Right now `firestore.rules` denies all client access since everything goes through the API.
- Unread counts. Use a Firestore `count()` aggregation on messages newer than the user's `lastSeen.messageCreatedAt`.
- Rate limiting and request logging.

## Project structure

```
src/
  app.ts                 express app, error handling
  server.ts              entry point (runs migrations, starts server)
  config.ts              env validation
  validation.ts          shared zod schemas
  db/                    postgres pool, firestore client, migration runner
  repositories/          postgres queries (users, chats, members)
  services/messages.ts   firestore: messages, receipts, last seen
  services/access.ts     membership / admin checks
  routes/                http handlers
migrations/              sql files, applied in order
tests/                   integration tests
```
