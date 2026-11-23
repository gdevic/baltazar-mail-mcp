# Baltazar Mail: AI access (MCP)

# EXPERIMENTAL. FOR PRIVATE USE ONLY. ENTIRELY AT YOUR OWN RISK.

> [!CAUTION]
> **This is an experiment, not a product.** It is meant only for people who know exactly what they are doing, on their own computer, with their own mail, and who take full responsibility for whatever happens.
>
> **Once you attach an AI assistant to a mailbox through MCP, anything can happen.** An assistant can misunderstand you, and a message written by a stranger can talk it into doing what you never asked for. The limits described below lower that risk. They do not remove it.
>
> There is no warranty, no support and no promise that it keeps working. If you are not sure whether this is for you, it is not: use [Baltazar Mail](https://github.com/gdevic/baltazar-mail) as it comes.

## Baltazar Mail itself is not affected

**Baltazar Mail is, and remains, safe to use.** That holds for every version of it: the packages in the browser stores, the released ZIPs, and any copy built from [its repository](https://github.com/gdevic/baltazar-mail).

- **It has no MCP code of any kind.** No server, no bridge, no switch for one, no hook waiting for one. Nothing in this repository is part of it.
- **Nothing here changes it.** This repository reads the app's repository and never writes to it. The app's source, its packages and what its documents promise are exactly what they are without this.
- **It keeps being checked for safety and security**, as its own repository records in `SECURITY.md`, `PRIVACY.md` and `docs/security-review.md`.

AI access exists only in a copy that you build yourself from this repository and load into your own browser by hand. Nobody gets it by installing or updating Baltazar Mail.

## What this is

It lets an AI assistant on your computer (Claude Code, or any client that speaks MCP) work with the mail in Baltazar Mail, for Yahoo™ Mail and Gmail™ alike: read and search messages, organise them, and prepare drafts. It never sends: only you press Send.

## How it is put together

An assistant starts the MCP server (`server/baltazar-mail-mcp.mjs`, one file, Node 22 or later, no dependencies). The server listens on `127.0.0.1:18417`. The mail tab, once AI access is switched on in its Settings, asks the server for work and answers it. The two pair with a code that Settings shows and that never travels; every message between them is signed.

The build here is an overlay. `tools/build.js` asks the app's own build for each edition, then lays three things over the result, in `dist/` here:

- **`ext/`** is added: `mcp.js` (the bridge in the page) and `mcpwire.js` (pairing and signing).
- **`glue/`** is appended: each file to the app's file of the same name. Appended to a module, the glue stands inside it and uses its functions by name. That is how AI access reaches the folder pane, the undo history and the composer while the app's source knows nothing of it.
- **The manifest** lets the pages reach the one local address, and says "with AI access" beside the version.

The build with AI access keeps the extension's key, so it has the same id as the app's own unpacked build: the browser holds one or the other, with the same settings and sign-in.

## Use

The app's repository is expected beside this one, as `../baltazar-mail`; `BALTAZAR_MAIL_REPO` names another place.

1. Build: `node tools/build.js`
2. In the browser's extension page, remove the copy loaded from the app's own `dist/` and load `dist/baltazar-mail-yahoo` or `dist/baltazar-mail-gmail` from here.
3. In the mail tab: Settings, AI access, tick the box, press Copy.
4. Run `node server/baltazar-mail-mcp.mjs setup`. It takes the code from the clipboard, saves it, and adds the server to Claude Code. Do steps 3 and 4 once for each mailbox.

`node server/baltazar-mail-mcp.mjs status` says what is set up and which mailboxes answer; `remove` takes the server out of Claude Code and forgets the codes. The codes are kept in `%APPDATA%\baltazar-mail\pairing-codes` (`~/.config/baltazar-mail/` elsewhere).

The mail tab must be open. With both mailboxes connected, a tool call names one with `account` (`yahoo`, `gmail`, or the address).

Never commit `dist/` or `out/`: a build carries what your own `local.json` files hold, such as an extension key or an OAuth client id.

## What an assistant can do

| Tool | What it does |
|---|---|
| `list_accounts`, `list_folders` | The connected mailboxes; a mailbox's folders with their counts |
| `list_messages`, `search_messages` | A folder's messages; a search in the app's own search language |
| `read_message`, `read_conversation` | A message's text and attachments list; its conversation as a tree |
| `get_attachment` | Writes one attachment as a file under the system's temporary folder |
| `find_contacts` | People from the address book |
| `mark_messages`, `move_messages` | Read or unread, starred or not; a move to any folder, Trash included |
| `create_folder`, `rename_folder` | A new folder; another name for one of your own |
| `draft_message` | A new message, reply, reply to all or forward, saved to Drafts and left open in the composer |

Every change shows in the mail tab at once and is an entry of its undo history, marked "AI:", which Undo takes back. Reading marks nothing as read.

## What it is built not to do

- **Send.** No tool sends, and the page's side of the feature calls nothing that does. A draft waits for you.
- **Delete for good, or empty a folder.** A message moved to Trash is in Trash.
- **Delete a folder**, or change a draft once it is saved.
- **Disturb what you are writing.** A draft is refused while a message is open in the composer.

These limits are in what the tools can do at all, and tests hold them. They are not a guarantee. Mail is written by strangers, and an assistant reads it: every answer that holds mail says so and says that its text is information, never instructions, and text a message hides from its reader with inline styles is left out. A message can still mislead an assistant into reading, moving, marking or drafting what you did not ask for, and an assistant with other tools at hand can do more with what it read than this repository can foresee. This code has not had an independent security review.

## When the app changes

The build always uses the app's repository as it is now, so its changes need no merging here. Two things can go out of step, and both are reported:

- **A name the glue uses is gone.** Each glue file lists the app's names it uses (`uses:`); the build stops and names the missing ones.
- **A function the glue follows has changed.** The glue's actions do what `doSetRead`, `doSetStarred`, `doMove`, `startCompose` and a few others do, for messages that need not be in the list. Each glue file lists them (`watches:`), and the build reports any whose text differs from what `glue/watched.json` records. Compare the function with the glue, run the checks, then `node tools/build.js --reviewed`.

## Checks

- `node tools/check.js` runs everything here: the overlay, the wire, the server, and both editions in a browser against the app's mocked mailboxes (about 40 seconds).
- `node tools/check.js --app` also runs the app's own tests against the build with AI access, which tells whether the glue disturbs the app.
