# Request to 3ook.com for a catalogue feed

Why this exists: jimbocho.app already links a book to its ebook on 3ook when
the two can be matched, and shows the live price from
`api.like.co/likernft/book/store/search?isbn=…`. The link half is built by
reading 3ook's sitemap and then all 1,908 store pages for the ISBN in their
JSON-LD — about 267 MB a rebuild, thirteen minutes, and only as fresh as the
last catalogue rebuild. A feed replaces that with one request, which is what
makes a daily refresh defensible rather than rude.

What was measured before asking, so the request is specific rather than
aspirational:

| | |
|---|---|
| books in 3ook's store | 1,908 |
| carrying a usable ISBN | 1,314 (69%) |
| of those, already in jimbocho | 930 |
| **without any ISBN** | **594**, of which 93% are absent from jimbocho entirely |
| matched books showing a *generated* cover on jimbocho | **245** |

The two sources agree on coverage: of 25 ISBNs from 3ook's largest publishers
that the scrape did not match, the per-ISBN API found none either. So the 594
are genuinely ISBN-less rather than hidden by the scrape, and they are mostly
self-published work and periodicals — 《破週報》, 科學月刊, 潘國靈《離》 —
which never entered a national bibliography and which jimbocho's registry
sources structurally cannot see.

Price is deliberately **not** requested. The existing per-ISBN endpoint already
serves it, cached 24 hours with open CORS, and a price baked into a build
artefact is wrong the moment it changes. That split is correct as it stands.

Not sent by Claude. Review it, put your own name at the bottom, and send it
yourself.

---

## Draft

**Subject: A catalogue feed for jimbocho.app**

jimbocho.app catalogues Hong Kong and Taiwan book metadata — 446,090 records
from the Books Registration Office, Taiwan's National Central Library, NBINet
and Open Library. Where a book is also sold on 3ook, the book page links to it
and shows your live price.

That link is currently built by reading your sitemap and then each of your
1,908 store pages for the ISBN in its JSON-LD. It works, but it is 267 MB a
run and can only be refreshed when the whole catalogue is rebuilt. A feed would
replace it with a single request and let the links refresh daily.

### What would help most

**A JSON file at a stable URL, listing every book currently for sale.**

```json
{
  "generatedAt": "2026-11-12T00:00:00Z",
  "licence": "…",
  "books": [
    {
      "url":         "https://3ook.com/store/0x0a4c…",
      "isbn":        "9789887992356",
      "title":       "離",
      "subtitle":    "",
      "authors":     ["潘國靈"],
      "publisher":   "…",
      "year":        2023,
      "language":    "zh",
      "cover":       "https://…/cover.jpg",
      "description": "…",
      "isListed":    true
    }
  ]
}
```

### The one detail that matters most

**Title, author and format as separate fields.** Your store listings render as
a single string — `離 - 潘國靈 - 電子版`, `觀 - 第 6 期 - 觀 - 電子版` — and
that string cannot be split back apart reliably from outside: the separator
appears inside titles, and the number of parts varies. You hold these pieces
separately already, so this is only a matter of not concatenating them.

Received as one string, every record we derive is malformed, none of them
match correctly against records we already hold, and the catalogue looks
broken. Received separately, they slot straight in.

### Why each field earns its place

| field | what it does |
|---|---|
| `url` | what the book page links to |
| `isbn` | the only reliable join between the two catalogues |
| `title`, `subtitle`, `authors` | matching, display, and the author search |
| `publisher` | jimbocho's browse is publisher-led — 312 publisher views are precomputed |
| `year`, `language` | the year and language filters |
| `cover` | **245 books we already match show a generated placeholder.** jimbocho resolves covers from Google Books and gets 13% across the whole catalogue; that is the measured ceiling, because most of this catalogue was never scanned. You have a real cover for everything you sell |
| `description` | shown on the book page where a record has none of its own |
| `isListed` | so a withdrawn book loses its link rather than linking to nothing |

### Three smaller asks

1. **`Last-Modified` or `ETag` on the URL**, so a refresh that finds nothing
   changed costs one conditional request.
2. **ISBNs filled in wherever one exists.** 594 of your titles carry none, and
   each one added becomes a link with no work on either side. You can tell
   which genuinely have no ISBN and which simply have not had it entered; we
   cannot.
3. **A licence or terms line in the feed itself**, naming what we may do with
   the fields. Every other source in the catalogue carries one, and this is the
   first that comes from a bookshop rather than a registry.

### Optional, and the nicest version

If you would rather not have us poll, a `repository_dispatch` to the jimbocho
repository whenever your catalogue changes would make this event-driven: links
and covers would appear within minutes of a book going on sale, and nothing
would run when nothing had changed. That needs a fine-grained token scoped to
that one repository and nothing else.

### What happens with it

The feed is read at build time and becomes a small file shipped with the site —
an ISBN-to-URL map, currently 78 KB, which the browser checks locally. A book
page therefore asks 3ook nothing unless the book is actually yours, and then
only for the live price. Nothing about what anyone reads on jimbocho is sent to
3ook for the other 445,000 books.

Separately and later, the same feed would be what a fuller import is built
from — the 507 titles you carry that no national registry has are exactly the
gap this catalogue cannot close on its own. That is a bigger conversation,
including about licensing, and nothing above depends on it.
