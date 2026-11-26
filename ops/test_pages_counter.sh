#!/usr/bin/env bash
# Exercise the actual Pages worker with Wrangler's local D1 runtime.
set -euo pipefail
project=$(mktemp -d)
echo '[]' > "$project/traffic.json"
uv run --locked python ops/build_public.py "$project/public" --site-url https://dealfactory.example --traffic-file "$project/traffic.json"
python3 -c 'import sys; sys.path.insert(0,"ops"); from traffic import CREATE_TABLE; print(CREATE_TABLE)' > "$project/schema.sql"
cd "$project"
cat > wrangler.json <<'JSON'
{"name":"dealfactory-test","pages_build_output_dir":"public","compatibility_date":"2025-04-01","d1_databases":[{"binding":"TRAFFIC","database_name":"dealfactory-traffic","database_id":"00000000-0000-4000-8000-000000000001"}]}
JSON
wrangler=(npm exec --yes --package=wrangler@4 -- wrangler)
"${wrangler[@]}" d1 execute TRAFFIC --local --persist-to .state --file schema.sql
"${wrangler[@]}" pages dev public --ip 127.0.0.1 --port 8799 --persist-to .state > server.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
origin=http://127.0.0.1:8799
if ! curl -fsS --retry 15 --retry-all-errors --retry-delay 1 "$origin/" -o /dev/null; then
  cat server.log
  exit 1
fi
curl -fsS -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$origin/mcp" |
  jq -e '[.result.tools[].name] | contains(["verify_on_page","get_shopping_rules"])'
for event in view outbound; do
  result=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Origin: $origin" "$origin/events?page=footmuffs&event=$event&channel=rss")
  if [[ "$result" != 204 ]]; then cat server.log; exit 1; fi
done
"${wrangler[@]}" d1 execute TRAFFIC --local --persist-to .state --json \
  --command 'SELECT event,total FROM daily_events ORDER BY event' > results.json
jq -e '.[0].results == [{"event":"outbound/rss","total":1},{"event":"view/rss","total":1}]' results.json
