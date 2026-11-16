# Request to 3ook.com for a thumbnail size

Why this exists: the feed they built carries a cover for 2,114 of their 2,255
titles, and jimbocho now shows those covers. They are the full-resolution
images — around 1,550 px wide and 400 KB to 1 MB each — where the grid draws
them at about 160 px. A screenful of sixty cards is roughly 24 MB of image for
roughly 2 MB of visible pixels.

The feed has a `thumbnailUrl` field, which is why this is a small ask rather
than a new feature: it already exists and is already in every record. It just
holds the same image as `imageUrl`, addressed as `ar://` instead of `https://`
— the same object id in all 2,114 records that carry both.

Measured on ten covers taken from the feed:

| | |
|---|---|
| dimensions | 762×1074 to 1610×2480 px |
| weight | 97 KB to 1,022 KB, mean 414 KB |
| what jimbocho's grid draws | ~160 px wide, 2:3 |
| what its other covers weigh | 11.6 KB at 128×173, from Google Books |

Nothing here is urgent and nothing is broken. The covers work, and the grid
defers loading until a card scrolls into view, so a reader pays for what they
see rather than for all sixty at once. It is worth asking because the fix is
one field they already publish, and because it is their bandwidth as much as
anyone's.

Not sent by Claude. Review it, put your own name at the bottom, and send it
yourself.

---

## Draft

**Subject: A thumbnail size for the store feed**

The catalogue feed is working well — jimbocho.app now carries your 2,255
titles, including about 500 that no national registry holds, and the covers
come from it too.

One small thing would help, and I think it costs you less than it costs us.

### What we see

The covers in the feed are full-resolution: in a ten-record sample, 762×1074
up to 1610×2480 pixels, and 97 KB to 1,022 KB each, averaging 414 KB.

jimbocho draws a cover in a grid card about 160 pixels wide. So we are
fetching roughly ten times the pixels we display, and a screenful of sixty
cards is about 24 MB of image. At a 400 px-wide thumbnail — still twice what
a high-density screen needs — the same screenful would be around 2 MB.

For comparison, the covers we resolve from Google Books for the rest of the
catalogue are 128×173 and about 12 KB.

### What would help

**Make `thumbnailUrl` an actual thumbnail.**

The field is already in every record. In all 2,114 records that carry both,
`thumbnailUrl` and `imageUrl` resolve to the same object — the former as
`ar://`, the latter through the HTTPS gateway — so the name is there and only
the content differs from what it suggests.

Something in the region of 400 px wide, JPEG or WebP, would suit a grid well.
Keeping `imageUrl` exactly as it is matters: a book page shows a larger cover,
and that is the right source for it.

One smaller thing while you are in that field: `thumbnailUrl` is an `ar://`
URI, which browsers do not resolve. We read `imageUrl` instead for that
reason. If the thumbnail were published as an HTTPS URL, it would be usable
directly.

### What we would do with it

Use `thumbnailUrl` in the grid and `imageUrl` on the book page, which is what
the two field names already imply. No change to anything else in the feed.
