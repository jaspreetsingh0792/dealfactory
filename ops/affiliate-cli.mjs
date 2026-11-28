import { readFileSync } from "node:fs";
import { applyAffiliates } from "../web/lib/affiliate.js";

const input = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(applyAffiliates(input.offers || [], input.env || {})));
