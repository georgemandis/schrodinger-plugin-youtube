# YouTube Plugin for Schrödinger

Copy a YouTube link, paste something more useful than the link.

- **Titled link**: `[Me at the zoo](https://youtu.be/jNQXAC9IVRw)`, and a real link when pasted into rich text
- **Details**: title, channel, length and link
- **Transcript**: the captions as readable paragraphs
- **Transcript with times**: one caption per line with its timestamp
- **Embed code**: the `<iframe>`

Works with `youtube.com/watch`, `youtu.be`, Shorts, live and embed links, and keeps a `?t=` start time. Only offered when the clip is a single YouTube link.

## Network access

This plugin contacts `www.youtube.com` and nothing else, and only when you paste. It sends the video id. For captions it prefers ones a person wrote over auto-generated ones.

## Settings

- **Transcript language**: a language code such as `en`, `es` or `ja`. Empty means your system language, then English, then whatever the video offers.

## Installation

Install from the Schrödinger Plugin Manager (Settings → Plugins → Browse).

To install manually or develop locally, symlink the plugin into your plugins directory:

```sh
ln -s "$(pwd)" ~/.schrodinger/plugins/youtube
```

Requires Schrödinger 0.2 or later.

## License

MIT
