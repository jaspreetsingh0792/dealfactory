"""dealfactory command line."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .config import load_settings
from .models import SCHEMA_MODELS, ProfileFact
from .pipeline import STAGES, load_needs, run_need
from .profile import load_profile
from .store import Store


def cmd_schemas(args, s) -> None:
    out = s.root / "schemas"
    out.mkdir(exist_ok=True)
    for name, model in SCHEMA_MODELS.items():
        (out / f"{name}.schema.json").write_text(json.dumps(model.model_json_schema(), indent=2))
    from .context import ShoppingContext
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema",
              "$id": "https://dealfactory.dev/spec/shopping-context.v1.schema.json",
              **ShoppingContext.model_json_schema()}
    for target in (s.root / "spec", s.root / "web" / "spec"):
        target.mkdir(parents=True, exist_ok=True)
        (target / "shopping-context.v1.schema.json").write_text(json.dumps(schema, indent=2))
    print(f"Wrote {len(SCHEMA_MODELS)} schemas to {out} and the Shopping Context schema to spec/ and web/spec/")


def _require_anthropic() -> None:
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
            or os.environ.get("ANTHROPIC_PROFILE") or any((Path.home() / ".config" / "anthropic").glob("*"))):
        raise SystemExit("No Anthropic credentials: cp .env.example .env and set ANTHROPIC_API_KEY "
                         "(or run `ant auth login`).")


def cmd_profile(args, s) -> None:
    from .inventory import with_imports
    store = Store(s.db_path)
    p = with_imports(load_profile(s.profile_path, s.user_id), store)
    store.close()
    print(f"Profile {s.profile_path} (version {p.version}): {len(p.facts)} facts, {len(p.owned_products)} owned products")
    un = p.unconfirmed()
    if un:
        print("\nUnconfirmed - please confirm or reject in environment.yaml:")
        for f in un:
            label = f.value if isinstance(f, ProfileFact) else f"{f.brand} {f.model}"
            print(f"  - {f.id}: {label}  [{f.source}, {f.confidence:.0%}]")


def cmd_doctor(args, s) -> None:
    ok = True
    def check(label, cond, hint=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"  {'✓' if cond else '✗'} {label}" + (f"  → {hint}" if not cond and hint else ""))
    print("DealFactory doctor")
    check("config.yaml", (s.root / "config.yaml").exists())
    check(f"profile at {s.profile_path}", s.profile_path.exists(),
          "cp examples/environment.example.yaml private/environment.yaml")
    check("needs.yaml", s.needs_path.exists())
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    check("Anthropic credentials (ANTHROPIC_API_KEY in .env)", has_key, "cp .env.example .env and add your key")
    gm = (s.private_dir / "gmail_token.json").exists()
    print(f"  {'✓' if gm else '·'} Gmail {'connected (read-only)' if gm else 'not connected (optional, Phase 2: dealfactory gmail auth)'}")
    check(".env is git-ignored", ".env" in (s.root / ".gitignore").read_text().split())
    check("private/ is git-ignored", "private/" in (s.root / ".gitignore").read_text().split())
    print(f"  model: {s.model} · retailers: {', '.join(s.default_retailers)}")
    sys.exit(0 if ok else 1)


def cmd_run(args, s) -> None:
    needs = load_needs(s.needs_path)
    if args.all:
        todo = [n for n in needs if n.status == "active"]
    else:
        ids = set(args.need)
        todo = [n for n in needs if n.id in ids]
        missing = ids - {n.id for n in todo}
        if missing:
            raise SystemExit(f"Unknown need id(s): {', '.join(sorted(missing))}. See needs.yaml.")
    if not todo:
        raise SystemExit("Nothing to run. Name a need id or use --all.")
    _require_anthropic()
    store = Store(s.db_path)
    failed = []
    try:
        for need in todo:
            print(f"▶ {need.id}: {need.text}")
            try:
                rd = run_need(s, need, store, only=args.stage, start_from=args.from_stage,
                              fresh_research=args.fresh_research)
                print(f"  outputs: {rd}")
            except Exception as e:  # keep going with other needs
                failed.append(need.id)
                print(f"  ✗ {need.id} failed: {e}", file=sys.stderr)
                if args.debug:
                    raise
        if not args.no_publish:
            from .publish import build_site
            out = build_site(s, store)
            print(f"Site: {out / 'index.html'}")
    finally:
        store.close()
    if failed:
        sys.exit(1)


def cmd_publish(args, s) -> None:
    from .publish import build_site
    store = Store(s.db_path)
    try:
        out = build_site(s, store, public=args.public)
    finally:
        store.close()
    print(f"Site written to {out}/index.html" + (" (public build: no private pages)" if args.public else ""))


def cmd_serve(args, s) -> None:
    import functools
    import http.server
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(s.site_dir))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as srv:
        print(f"Serving {s.site_dir} at http://127.0.0.1:{args.port}/ (Ctrl+C to stop)")
        srv.serve_forever()


def cmd_export(args, s) -> None:
    store = Store(s.db_path)
    print(json.dumps(store.export_user(s.user_id), indent=2, default=str))
    store.close()


def cmd_gmail(args, s) -> None:
    from .imports import gmail
    try:
        if args.action == "auth":
            path = gmail.authorize(s.private_dir)
            print(f"Connected (read-only). Token saved to {path} (git-ignored, mode 600).")
        elif args.action == "disconnect":
            removed = gmail.disconnect(s.private_dir)
            print(("Deleted the local Gmail token." if removed else "No local Gmail token.")
                  + " Also remove DealFactory at https://myaccount.google.com/permissions to revoke it at Google.")
        else:  # status
            creds = gmail.load_credentials(s.private_dir)
            print(f"Connected to Gmail, scopes: {', '.join(creds.scopes or gmail.SCOPES)}")
    except gmail.GmailError as e:
        raise SystemExit(str(e))


def _print_import(rep) -> None:
    print("\n".join(rep.lines()))
    if rep.log_path:
        print(f"Audit log (no email text): {rep.log_path}")
    print("Review with `dealfactory inventory`, then re-run needs with `dealfactory run --all --from fit`.")


def cmd_import(args, s) -> None:
    from .imports.run import import_documents
    store = Store(s.db_path)
    try:
        if args.source == "gmail":
            from .imports import gmail
            try:
                creds = gmail.load_credentials(s.private_dir)
            except gmail.GmailError as e:
                raise SystemExit(str(e))
            query = gmail.build_query(args.query or s.gmail.get("query"), args.since or s.gmail.get("since", "2y"))
            limit = args.max or int(s.gmail.get("max_messages", 150))
            reader = gmail.GmailReader(creds.token)
            if args.dry_run:
                ids = reader.list_ids(query, limit)
                done = store.imported_refs(s.user_id)
                new = [i for i in ids if gmail.gmail_ref(i) not in done]
                print(f"Query: {query}\n{len(ids)} matching messages, {len(new)} not imported yet. Nothing was read "
                      "or sent. Run without --dry-run to import.")
                return
            _require_anthropic()
            docs = reader.documents(query, limit, store.imported_refs(s.user_id))
        else:
            from .imports.documents import load_files
            paths = [Path(p).expanduser() for p in args.paths]
            missing = [str(p) for p in paths if not p.exists()]
            if missing:
                raise SystemExit(f"Not found: {', '.join(missing)}")
            _require_anthropic()
            docs = load_files(paths)
        rep = import_documents(s, store, docs)
        _print_import(rep)
        if not args.no_publish:
            from .publish import build_site
            build_site(s, store)
    finally:
        store.close()


def cmd_inventory(args, s) -> None:
    store = Store(s.db_path)
    try:
        act = args.action
        if act == "list":
            items = store.purchases(s.user_id)
            if not args.all:
                items = [p for p in items if p.status != "rejected"]
            if not items:
                print("Nothing imported yet. See `dealfactory import --help`.")
                return
            for p in items:
                price = f"€{p.unit_price:.2f}" if p.unit_price is not None else "price unknown"
                bm = " ".join(x for x in [p.brand or "?", p.model or "?"])
                print(f"[{p.status:11}] {p.id}\n    {p.order_date or '????-??-??'}  {p.merchant or '?'}  "
                      f"{p.product_name}  ({bm}; {p.category}/{p.kind}; {price}"
                      + ("; " + p.doc_type if p.doc_type in ("return", "cancellation") else "") + ")")
            print(f"\n{len(items)} items. Confirm / reject / edit / delete by id.")
        elif act in ("confirm", "reject"):
            store.set_purchase_status(s.user_id, args.ids, "confirmed" if act == "confirm" else "rejected")
            print(f"{act}ed {len(args.ids)} item(s).")
        elif act == "delete":
            store.delete_purchases(s.user_id, args.ids)
            print(f"Deleted {len(args.ids)} item(s). They won't come back from the same emails.")
        elif act == "edit":
            fields = {k: v for k, v in {"product_name": args.name, "brand": args.brand, "model": args.model,
                                        "variant": args.variant, "category": args.category, "kind": args.kind,
                                        "merchant": args.merchant, "order_date": args.date,
                                        "quantity": args.quantity, "unit_price": args.price}.items() if v is not None}
            if not fields:
                raise SystemExit("Nothing to change. Pass e.g. --model 'Roborock Q7 Max'.")
            store.edit_purchase(s.user_id, args.ids[0], fields)
            print(f"Updated {args.ids[0]} (marked confirmed).")
        elif act == "forget":
            if not args.yes:
                raise SystemExit("This deletes all imported purchases and the import log. Re-run with --yes.")
            store.forget_imports(s.user_id)
            print("Deleted all imported purchases and the import log.")
        if act != "list":
            from .publish import build_site
            build_site(s, store)
    except KeyError as e:
        raise SystemExit(e.args[0])
    finally:
        store.close()


def _profile_with_imports(s):
    from .inventory import with_imports
    store = Store(s.db_path)
    try:
        return with_imports(load_profile(s.profile_path, s.user_id), store)
    finally:
        store.close()


def cmd_context(args, s) -> None:
    from .context import export_context
    needs = load_needs(s.needs_path) if s.needs_path.exists() else []
    ctx = export_context(_profile_with_imports(s), needs)
    text = ctx.model_dump_json(indent=2, exclude_none=True)
    if args.out:
        Path(args.out).write_text(text)
        print(f"Wrote {args.out} (private facts left out). Import it in the web app or give it to your assistant.")
    else:
        print(text)


def cmd_mcp(args, s) -> None:
    from .mcp_server import serve
    serve(s, Path(args.context).expanduser() if args.context else None)


def cmd_web(args, s) -> None:
    import functools
    import http.server
    web = Path(__file__).resolve().parents[2] / "web"
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as srv:
        print(f"DealFactory web app at http://127.0.0.1:{args.port}/ (Ctrl+C to stop)")
        srv.serve_forever()


def cmd_forget(args, s) -> None:
    if not args.yes:
        raise SystemExit("This deletes everything stored about you in data/dealfactory.sqlite. Re-run with --yes.")
    store = Store(s.db_path)
    store.delete_user(s.user_id)
    store.close()
    print("Deleted all stored rows for this user. (private/environment.yaml and runs/ are files you control.)")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="dealfactory", description="Environment-aware shopping advisor")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doctor", help="check setup")
    sub.add_parser("schemas", help="write JSON schemas to schemas/")
    sub.add_parser("profile", help="show the loaded profile and facts to confirm")
    r = sub.add_parser("run", help="run the pipeline for needs")
    r.add_argument("need", nargs="*", help="need ids from needs.yaml")
    r.add_argument("--all", action="store_true", help="all active needs")
    g = r.add_mutually_exclusive_group()
    g.add_argument("--stage", choices=STAGES, help="re-run one stage on the latest run")
    g.add_argument("--from", dest="from_stage", choices=STAGES, help="re-run from this stage on the latest run")
    r.add_argument("--fresh-research", action="store_true", help="ignore the category research cache")
    r.add_argument("--no-publish", action="store_true")
    r.add_argument("--debug", action="store_true", help="show tracebacks")
    p = sub.add_parser("publish", help="rebuild the static site")
    p.add_argument("--public", action="store_true", help="omit private pages and facts")
    sv = sub.add_parser("serve", help="serve site/ on localhost")
    sv.add_argument("--port", type=int, default=8765)
    sub.add_parser("export", help="print everything stored about you (JSON)")
    f = sub.add_parser("forget", help="delete everything stored about you")
    f.add_argument("--yes", action="store_true")

    gm = sub.add_parser("gmail", help="connect Gmail (read-only) for purchase import")
    gm.add_argument("action", choices=["auth", "status", "disconnect"])

    im = sub.add_parser("import", help="import purchases from Gmail or receipt files")
    isub = im.add_subparsers(dest="source", required=True)
    ig = isub.add_parser("gmail", help="read purchase emails (read-only)")
    ig.add_argument("--since", help="Gmail newer_than, e.g. 6m, 1y, 3y (default from config.yaml)")
    ig.add_argument("--max", type=int, help="max messages this run")
    ig.add_argument("--query", help="override the purchase filter (Gmail search syntax)")
    ig.add_argument("--dry-run", action="store_true", help="only count matching messages")
    ig.add_argument("--no-publish", action="store_true")
    ifl = isub.add_parser("files", help="PDF receipts, .eml, .mbox (Google Takeout), .txt, .html")
    ifl.add_argument("paths", nargs="+")
    ifl.add_argument("--no-publish", action="store_true")

    inv = sub.add_parser("inventory", help="see, confirm, edit or delete imported purchases")
    inv.add_argument("action", nargs="?", default="list",
                     choices=["list", "confirm", "reject", "edit", "delete", "forget"])
    inv.add_argument("ids", nargs="*")
    inv.add_argument("--all", action="store_true", help="list: include rejected")
    inv.add_argument("--yes", action="store_true", help="forget: confirm")
    for opt in ["name", "brand", "model", "variant", "category", "merchant", "date"]:
        inv.add_argument(f"--{opt}")
    inv.add_argument("--kind", choices=["durable", "accessory", "consumable", "clothing", "service", "gift_card", "other"])
    inv.add_argument("--quantity", type=int)
    inv.add_argument("--price", type=float)
    cx = sub.add_parser("context", help="export your Shopping Context (open JSON format) for the web app or an AI")
    cx.add_argument("action", choices=["export"])
    cx.add_argument("-o", "--out")
    mc = sub.add_parser("mcp", help="run the MCP server (stdio) so Claude/ChatGPT/other assistants can use your context")
    mc.add_argument("--context", help="use a shopping-context.json (e.g. exported from the web app) instead of private/")
    wb = sub.add_parser("web", help="serve the public web app locally")
    wb.add_argument("--port", type=int, default=8766)
    args = ap.parse_args(argv)
    if args.cmd == "mcp" and args.context:  # works without a DealFactory checkout (web app users)
        return cmd_mcp(args, None)
    if args.cmd == "inventory" and args.action in ("confirm", "reject", "delete", "edit") and not args.ids:
        ap.error(f"inventory {args.action} needs at least one id (see `dealfactory inventory`)")
    s = load_settings()
    {"doctor": cmd_doctor, "schemas": cmd_schemas, "profile": cmd_profile, "run": cmd_run, "publish": cmd_publish,
     "serve": cmd_serve, "export": cmd_export, "forget": cmd_forget, "gmail": cmd_gmail, "import": cmd_import,
     "inventory": cmd_inventory, "context": cmd_context, "mcp": cmd_mcp, "web": cmd_web}[args.cmd](args, s)


if __name__ == "__main__":
    main()
