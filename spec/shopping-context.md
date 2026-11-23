# Shopping Context v1

An open JSON format for *what I have and what I want to buy*, so any assistant or shopping tool can give
advice that fits the person's home and the things they already own. It's owned by the user and stored
on their side: a browser, a file or their own server.

Schema: [`shopping-context.v1.schema.json`](shopping-context.v1.schema.json) (JSON Schema 2020-12, generated
from `src/dealfactory/context.py`).

```json
{
  "format": "shopping-context",
  "version": 1,
  "updated_at": "2026-11-23T10:00:00Z",
  "generator": "dealfactory-web",
  "location": {"country": "NL", "city": "Utrecht", "currency": "EUR", "language": "nl"},
  "facts": [
    {"id": "home.type", "value": "apartment", "source": "stated", "status": "confirmed", "confidence": 1},
    {"id": "household.pets", "value": ["cat"], "source": "inferred", "status": "unconfirmed", "confidence": 0.6,
     "note": "mentioned cat hair in an earlier chat"}
  ],
  "owned": [
    {"id": "stroller-cybex-balios", "category": "stroller", "brand": "Cybex", "model": "Balios S Lux",
     "aliases": ["my stroller"], "source": "stated", "status": "confirmed"}
  ],
  "needs": [
    {"id": "fleece-footmuff", "text": "fleece footmuff for my stroller", "status": "active",
     "budget_max": 120, "currency": "EUR"}
  ]
}
```

## Rules

- **Location** is coarse: country (ISO 3166-1 alpha-2), optionally region and city. Never a street,
  postcode or coordinates.
- **Facts** use dotted ids (`home.*`, `household.*`, `ecosystems.*`, `preferences.*`, `constraints.*`, or
  your own). `value` is a string, number, boolean or list of strings.
- **Provenance** is attached to every fact and owned item.
  - `source` is one of `stated`, `email`, `receipt`, `inferred` or `example`.
  - `status` is one of `confirmed`, `unconfirmed` or `rejected`.
  - Anything an assistant fills in from memory is `inferred` + `unconfirmed` until the user confirms it.
- **Consumers** must not treat `unconfirmed` items as certain. They must ignore `rejected` items and
  `example` placeholders, and must not overwrite `confirmed` items when merging.
- **Needs** are written in the user's own words. Their ids are stable slugs.
- **Unknown fields** are ignored by readers, so the format can grow without breaking v1 readers.

## Guidance for assistants

Recommend things that work with `owned` and fit `facts`. Say which owned item a product is compatible
with, and how you know. Never invent products, specs, prices or links: every price and spec needs a page
you actually read, with the date. If you couldn't verify something, write "unknown". Keep sourced facts
separate from your own judgement.
