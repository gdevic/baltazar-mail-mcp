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

AI access exists only in a copy built from this repository or downloaded from its releases, and loaded into your own browser by hand. Nobody gets it by installing or updating Baltazar Mail, from a store or from the app's own releases.

## What this is

It lets an AI assistant on your computer (Claude Code, or any client that speaks MCP) work with the mail in Baltazar Mail, for Yahoo™ Mail and Gmail™ alike: read and search messages, organise them, and prepare drafts. It never sends: only you press Send.

## How it is put together

An assistant starts the MCP server (`server/baltazar-mail-mcp.mjs`, one file, Node 22 or later, no dependencies). The server listens on `127.0.0.1:18417`. The mail tab, once AI access is switched on in its Settings, asks the server for work and answers it. The two pair with a code that Settings shows and that never travels; every message between them is signed.

The build here is an overlay. `tools/build.js` asks the app's own build for each edition, then lays four things over the result, in `dist/` here:

- **`ext/`** is added: `mcp.js` (the bridge in the page) and `mcpwire.js` (pairing and signing).
- **`server/`** is added as a folder: the assistant's server, so the extension's folder holds all that AI access needs. The manifest names nothing in it, so the browser loads nothing from it.
- **`glue/`** is appended: each file to the app's file of the same name. Appended to a module, the glue stands inside it and uses its functions by name. That is how AI access reaches the folder pane, the undo history and the composer while the app's source knows nothing of it.
- **The manifest** lets the pages reach the one local address, and says "with AI access" beside the version.

The build with AI access keeps the app's version and the extension's key, so it is the same extension as the app's own build: the browser holds one or the other, with the same settings and sign-in.

## Use

Steps 1 and 2 put the extension with AI access in place of the app's own, in one of two ways.

**From a release.** Each release here goes with the app's release of the same version and holds a ZIP of each edition: the app's own release ZIP with AI access laid over it, with the same version, the same key and the same folder inside. A ZIP is complete by itself: the server is in it, in `server/`, and nothing else has to be downloaded.

1. Download `baltazar-mail-yahoo-<version>-mcp.zip` or `baltazar-mail-gmail-<version>-mcp.zip` and unzip it over the folder Baltazar Mail is loaded from, replacing the files.
2. Click **Reload** on the extension's card in the browser's extensions page. It is the same extension, so settings, sign-in and address book stay; the card now shows the version as "<version> with AI access".

**From source.** The app's repository is expected beside this one, as `../baltazar-mail`; `BALTAZAR_MAIL_REPO` names another place.

1. Build: `node tools/build.js`
2. Load `dist/baltazar-mail-yahoo` or `dist/baltazar-mail-gmail` from here in place of the copy loaded from the app's own `dist/`. Built on the same machine, the two have the same key, so the browser takes one or the other as the same extension.

Then, either way:

3. In the mail tab: Settings, AI access, tick the box, press Copy.
4. In the folder the extension is loaded from, run `node server/baltazar-mail-mcp.mjs setup`. It takes the code from the clipboard, saves it, and adds the server to Claude Code. Do steps 3 and 4 once for each mailbox.

`node server/baltazar-mail-mcp.mjs status` says what is set up and which mailboxes answer; `remove` takes the server out of Claude Code and forgets the codes. The codes are kept in `%APPDATA%\baltazar-mail\pairing-codes` (`~/.config/baltazar-mail/` elsewhere).

Each edition's folder holds the same server, and one server works with both mailboxes. Claude Code starts the copy `setup` was last run from, by its path: after moving or renaming that folder, run `setup` again.

The mail tab must be open. With both mailboxes connected, a tool call names one with `account` (`yahoo`, `gmail`, or the address).

After the files in the folder are replaced, reload the extension, and start the assistant's server again (in Claude Code: `/mcp`, reconnect). A browser goes on running the page it loaded, and a mail tab that is older than the server would pass over what it does not know. The two therefore check each other: the tab tells the server what it can do, and the server refuses, with words that say to reload, a call the tab cannot honour; a tab refuses an argument it does not know; and a server refuses to pass a call through an older server that holds the port for another assistant, and says to restart that assistant.

To go back to Baltazar Mail without AI access, put the app's own files back in the folder (its release ZIP, or its own build) and reload.

Never commit `dist/` or `out/`: a build made on your machine carries what your own `local.json` files hold, such as an extension key or an OAuth client id. The release ZIPs are built on GitHub, where there are none.

## What an assistant can do

| Tool | What it does |
|---|---|
| `list_accounts`, `list_folders` | The connected mailboxes; a mailbox's folders with their counts |
| `list_messages`, `search_messages` | A folder's messages; a search in the app's own search language |
| `read_message`, `read_conversation` | A message's text and attachments list; its conversation as a tree |
| `read_composer` | The message you are writing, as it stands, saved or not: its sender, recipients, subject and text, with a mark where your caret is |
| `get_attachment` | Writes one attachment as a file under the system's temporary folder |
| `find_contacts` | People from the address book |
| `mark_messages`, `move_messages` | Read or unread, starred or not; a move to any folder, Trash included |
| `create_folder`, `rename_folder` | A new folder; another name for one of your own |
| `draft_message` | A new message, reply, reply to all or forward, saved to Drafts and left open in the composer; text added to the message you are writing; or a saved draft opened in the composer |

Every change shows in the mail tab at once and is an entry of its undo history, marked "AI:", which Undo takes back. Reading marks nothing as read.

A marker in the mail tab's header, before the account, always says that this copy has AI access and what its connection is doing: off, waiting, connected, or what stands in its way (another tab holds the connection, or the server has another code or another version). While an assistant's command is done it is filled, pulses and says what the assistant is doing ("AI is searching", "AI is writing a draft"), and it goes on saying so for a moment after. A click on it opens Settings scrolled to their end, where AI access is, with the focus on Copy, or on the switch while AI access is off. In a narrow window the marker gives up its words before the rest of the header loses its room.

A draft that stays open in the composer is shown as if typed: its text appears behind a caret marked "AI", in at most three seconds. That is a replay, since a draft reaches the tab whole: all of the text is in the message from the start and is saved as it is, and only its showing is held back. A key, a click, a turn of the mouse wheel or anything put into the composer shows the rest at once. A message written as plain text, and a system set to reduce motion, get the text at once.

While you write a message, an assistant can step in and write with you. Ask it to add to the message, and its text is typed into your own text as lines of its own, after the line your caret is in. An empty line takes the text and then follows it, so you go on writing below, and what the assistant adds next at the same place follows what it added before. With the caret inside a quoted original, the quote is split there, as Enter splits it, and the text stands between its two parts. With the caret at the very start of the message, which is where a message opens with it, or outside the message's text, in the subject for one, the text goes after your own, above the signature and the quoted original. Where the text belongs somewhere other than at your caret, the assistant names the line it follows (`after`). That is a line of your own text, never one of the signature or of a quoted or forwarded message, so nothing an outside sender wrote, seen or hidden, can be chosen as the place; words that no line of yours has, or more than one, add nothing. A link the assistant writes says where it leads: one whose words are an address other than the one it goes to gets the real address for its words.

What was added is an entry of the undo history, marked "AI:" like every other change: Undo takes the text out of the message again, with whatever you changed in it since, and Redo puts it back. The entry is for that message while you are writing it, and leaves the history when the composer closes; a quote that was split for the text stays split. To write what fits, an assistant can read the message as it stands (`read_composer`): its sender, recipients (Bcc among them), subject and attachments' names, your own words, the signature and the quoted original, with a mark where your caret is, and the text you have selected. It reads what is in the composer whether or not it was saved.

An assistant can also open a draft saved in Drafts, as your click on it there opens it, so that "open my draft and finish it" is one request. With one draft in Drafts it opens that one. With several, and none named, it opens none: it is given each draft's recipients, subject, date and how its text begins, and asks you which one you mean. A draft opened this way loads none of the remote pictures of the mail it quotes.

## What it is built not to do

- **Send.** No tool sends, and the page's side of the feature calls nothing that does. A draft waits for you.
- **Delete for good, or empty a folder.** A message moved to Trash is in Trash.
- **Delete a folder.**
- **Put away or change what you are writing.** A new message, reply or forward is refused while a message is open in the composer, and so is opening a saved draft; that holds also for a message you start while the assistant's is being prepared. An assistant can add to the message that is open (`draft_message` with the mode `continue`), and that is all it can do to it: its text goes into your own text as lines of its own, at your caret or after a line of yours that it names, and your own words, the recipients and the subject stay as they are. With your caret inside a quoted original, the quote is split there, as your own Enter would split it. A saved draft changes in that way only: opened in the composer (the mode `open_draft`) and added to there.

These limits are in what the tools can do at all, and tests hold them. They are not a guarantee. Mail is written by strangers, and an assistant reads it: every answer that holds mail says so and says that its text is information, never instructions, and text that a message's own inline styles take out of view (not shown, not visible, of no size or no opacity, or clipped to nothing) is left out. Text hidden in other ways, such as in the colour of its background, is not recognised. A message can still mislead an assistant into reading, moving, marking or drafting what you did not ask for, or into adding to a message you are writing, which you would then send as yours: read what was added before you send, and an assistant with other tools at hand can do more with what it read than this repository can foresee. This code has not had an independent security review.

## When the app changes

The build always uses the app's repository as it is now, so its changes need no merging here. Two things can go out of step, and both are reported:

- **A name the glue uses is gone.** Each glue file lists the app's names it uses (`uses:`); the build stops and names the missing ones.
- **A function the glue follows has changed.** The glue's actions do what `doSetRead`, `doSetStarred`, `doMove`, `startCompose` and a few others do, for messages that need not be in the list. Each glue file lists them (`watches:`), and the build reports any whose text differs from what `glue/watched.json` records. Compare the function with the glue, run the checks, then `node tools/build.js --reviewed`.

## Versions and releases

`VERSION` here is the app's version this repository goes with: `0.23.0` goes with Baltazar Mail 0.23.0. A release of this side alone, for the same app version, adds a number after a dash: `0.23.0-2`. The build says when the app beside it is another version, and the checks fail until `VERSION` here follows.

A release is made after the app's own release of that version, since it is built on the app's tag:

1. Run `node tools/check.js --app` against the app as released; fix the glue if the build reports a change.
2. Set `VERSION`, commit, push.
3. Run the Release workflow with the tag (`gh workflow run release.yml -f tag=v0.23.0`). It checks out the app at its tag of the same version, runs every check against it (this repository's, and the app's own browser suites against the build with AI access), and only then builds and publishes the two ZIPs with their SHA-256 files and a signed record of the build. It makes no package for a browser store.

## Checks

- `node tools/check.js` runs everything here: the overlay, the wire, the server, and both editions in a browser against the app's mocked mailboxes (about a minute and a half).
- `node tools/check.js --app` also runs the app's own tests against the build with AI access, which tells whether the glue disturbs the app.
- On GitHub the same checks run on every push here, against the app's `main`, and before every release, against the app's tag.
