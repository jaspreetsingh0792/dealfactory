# Affiliate links

Affiliate links are **off** until Jaspreet sets a shop ID. DealFactory does not sign up for programs and does not submit forms. With no ID, every Open shop link is the plain retailer URL, unchanged.

When an ID is set, that shop's link is wrapped or tagged, labelled **Affiliate link** (Dutch: **Affiliatelink**), and marked `rel="sponsored nofollow noopener"`. The page says DealFactory may earn a commission at no extra cost, and that this never changes ranking or recommendations. There is no click counter, cookie, or fingerprint added by DealFactory.

Sort order uses the checked price and the product name only.

## Variables

Set these as GitHub Actions variables (or the environment of `ops/build_public.py`). Leave a variable empty to keep that shop plain. Values must be letters, numbers, `_` and `-` only. Do not commit real IDs.

| Variable | Meaning |
|---|---|
| `AFFILIATE_AWIN_PUBLISHER_ID` | Your Awin publisher id (`awinaffid`) |
| `AFFILIATE_DAISYCON_WEBSITE_ID` | Your Daisycon website id (`wi`) |
| `AFFILIATE_TRADETRACKER_AFFILIATE_ID` | Your TradeTracker affiliate id (`a`) |
| `AFFILIATE_AMAZON_NL_TAG` | Amazon.nl associates tag. Appended as `tag=` on `amazon.nl` URLs only |
| `AFFILIATE_COOLBLUE_NETWORK` | `awin`, `daisycon`, or `tradetracker` |
| `AFFILIATE_COOLBLUE_MERCHANT_ID` | Awin `awinmid`, Daisycon `si`, or TradeTracker campaign `c` |
| `AFFILIATE_COOLBLUE_MATERIAL_ID` | Daisycon `li` (optional) or TradeTracker material `m` (required for TradeTracker) |
| `AFFILIATE_BOL_NETWORK` | Same three network names |
| `AFFILIATE_BOL_MERCHANT_ID` | Merchant, program, or campaign id |
| `AFFILIATE_BOL_MATERIAL_ID` | Optional Daisycon material, required TradeTracker material |
| `AFFILIATE_INSTALPUNT_NETWORK` | Same three network names |
| `AFFILIATE_INSTALPUNT_MERCHANT_ID` | Merchant, program, or campaign id |
| `AFFILIATE_INSTALPUNT_MATERIAL_ID` | Optional Daisycon material, required TradeTracker material |
| `AFFILIATE_AQARA_NETWORK` | Same three network names |
| `AFFILIATE_AQARA_MERCHANT_ID` | Merchant, program, or campaign id |
| `AFFILIATE_AQARA_MATERIAL_ID` | Optional Daisycon material, required TradeTracker material |
| `AFFILIATE_BLAUWESTROOMSHOP_NETWORK` | Same three network names |
| `AFFILIATE_BLAUWESTROOMSHOP_MERCHANT_ID` | Merchant, program, or campaign id |
| `AFFILIATE_BLAUWESTROOMSHOP_MATERIAL_ID` | Optional Daisycon material, required TradeTracker material |

A network link is built only when the network name, the shop merchant id, and the network publisher id are all set. TradeTracker also needs the material id. Anything missing leaves that URL exactly as the retailer published it.

Wrappers:

- Awin: `https://www.awin1.com/cread.php?awinmid=MERCHANT&awinaffid=PUBLISHER&ued=ENCODED_URL`
- Daisycon: `https://ds1.nl/c/?wi=WEBSITE&si=MERCHANT&li=MATERIAL&dl=ENCODED_URL` (`li` omitted when the material id is empty)
- TradeTracker: `https://tc.tradetracker.net/?c=MERCHANT&m=MATERIAL&a=AFFILIATE&u=ENCODED_URL`
- Amazon.nl: the original URL plus `tag=AFFILIATE_AMAZON_NL_TAG`

The publish workflow reads these from GitHub Actions variables of the same names.
