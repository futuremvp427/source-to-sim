#!/usr/bin/env python3
"""Bounded data-only auth/REST comparison. No account or order API exists here."""
from __future__ import annotations

import argparse
import base64
import collections
import copy
import datetime as dt
import hashlib
import io
import json
import logging
import math
import os
import re
import threading
import time
import zipfile
from pathlib import Path

from quality import MODEL, PROTOCOL, SLUG, canonical, compare_stream, digest, inspect_book
from probe import Journal, PublicClient, catalog, verify_journal

WS_URL = "wss://api.polymarket.us/v1/ws/markets"
WS_PATH = "/v1/ws/markets"
NUMERIC = re.compile(r"^[0-9]{1,24}(?:\.[0-9]{1,18})?$|^\.[0-9]{1,18}$")
STATES = {"MARKET_STATE_OPEN", "MARKET_STATE_PREOPEN", "MARKET_STATE_SUSPENDED",
          "MARKET_STATE_HALTED", "MARKET_STATE_EXPIRED", "MARKET_STATE_TERMINATED",
          "MARKET_STATE_MATCH_AND_CLOSE_AUCTION"}


def auth_headers(key_id, secret, timestamp_ms=None):
    """Only the fixed market-data GET handshake can be signed."""
    if not key_id or not secret:
        raise ValueError("missing_key_id" if not key_id else "missing_secret_key")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", key_id):
        raise ValueError("invalid_key_id_format")
    try:
        # Clipboard/line wrapping is not key material. Match the official SDK's
        # acceptance of Base64 whitespace, without ignoring labels/punctuation.
        raw = base64.b64decode("".join(secret.split()), validate=True)
        if len(raw) not in (32, 64):
            raise ValueError()
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        private = Ed25519PrivateKey.from_private_bytes(raw[:32])
    except Exception:
        raise ValueError("invalid_secret_key_format") from None
    stamp = str(int(time.time() * 1000) if timestamp_ms is None else timestamp_ms)
    if not re.fullmatch(r"[0-9]{13}", stamp):
        raise ValueError("invalid_timestamp_format")
    sig = base64.b64encode(private.sign((stamp + "GET" + WS_PATH).encode())).decode()
    return {"X-PM-Access-Key": key_id, "X-PM-Timestamp": stamp, "X-PM-Signature": sig}


def subscription(slugs):
    if not 1 <= len(slugs) <= 3 or len(set(slugs)) != len(slugs):
        raise ValueError("invalid_subscription_size")
    if not all(SLUG.fullmatch(s) for s in slugs):
        raise ValueError("invalid_market_slug")
    return {"subscribe": {"requestId": "pmus-data-only-1",
        "subscriptionType": "SUBSCRIPTION_TYPE_MARKET_DATA", "marketSlugs": slugs}}


def credential_shape(key_id, secret):
    """Booleans/decoded length only. No value, prefix, hash or signature."""
    out={"key_id_present":bool(key_id),"secret_key_present":bool(secret)}
    try:
        raw=base64.b64decode("".join(secret.split()),validate=True)
        out.update(secret_is_base64=True,secret_decoded_bytes=len(raw),
                   expected_32_or_64_bytes=len(raw) in (32,64))
    except Exception:
        out.update(secret_is_base64=False,expected_32_or_64_bytes=False)
    return out


def safe_market_data(value, slugs):
    """Whitelist market fields; never journal arbitrary messages/error text."""
    if not isinstance(value, dict) or value.get("marketSlug") not in slugs:
        raise ValueError("unsubscribed_market")
    if value.get("state") not in STATES:
        raise ValueError("invalid_market_state")
    timestamp = value.get("transactTime")
    if not isinstance(timestamp, str) or not re.fullmatch(r"[0-9TtZz:+.-]{20,40}", timestamp):
        raise ValueError("invalid_venue_timestamp")
    at = MODEL.stamp(timestamp)
    if not math.isfinite(at):
        raise ValueError("invalid_venue_timestamp")
    out = {k: value[k] for k in ("marketSlug", "state", "transactTime")}
    for side in ("bids", "offers"):
        levels = value.get(side)
        if not isinstance(levels, list) or len(levels) > 200:
            raise ValueError("invalid_book_shape")
        clean = []
        for level in levels:
            if not isinstance(level, dict) or not isinstance(level.get("px"), dict):
                raise ValueError("invalid_book_level")
            px, qty = level["px"].get("value"), level.get("qty")
            if not isinstance(px, str) or not isinstance(qty, str) or not NUMERIC.fullmatch(px) or not NUMERIC.fullmatch(qty) or level["px"].get("currency") != "USD":
                raise ValueError("invalid_price_or_quantity")
            clean.append({"px": {"value": px, "currency": "USD"}, "qty": qty})
        out[side] = clean
    return out


def normalize_market_message(data):
    """Accept the two documented wire spellings; reject conflicting aliases."""
    if not isinstance(data, dict):
        return data
    if "market_data" not in data:
        return data
    if "marketData" in data:
        raise ValueError("conflicting_wire_aliases")
    md = dict(data["market_data"])
    for snake, camel in (("market_slug", "marketSlug"), ("transact_time", "transactTime")):
        if snake in md:
            if camel in md:
                raise ValueError("conflicting_wire_aliases")
            md[camel] = md.pop(snake)
    return {**{k: v for k, v in data.items() if k != "market_data"}, "marketData": md}


def inspect_stream(md, slug, now):
    """Venue time is never replaced by receipt, heartbeat or HTTP timestamps."""
    result = {"slug": slug, "usable": False, "issues": [], "transport": "authenticated_markets_websocket"}
    try:
        result["book_at"] = MODEL.stamp(md["transactTime"])
        result["book_age_seconds"] = now - result["book_at"]
        book = MODEL.book({"marketData": md}, slug, now, 60)
        for long in (True, False):
            MODEL.execute(book, long, "SELL", "10", "0.0695")
        levels = {side: [[str(p.normalize()), str(q.normalize())] for p, q in book[side]]
                  for side in ("bids", "offers")}
        result["book_fingerprint"] = digest({"slug": slug, **levels, "state": md.get("state")})
        result["usable"] = True
    except (ValueError, TypeError, KeyError, ArithmeticError):
        result["issues"] = ["invalid_stale_closed_or_insufficient_stream_book"]
    return result


class StreamState:
    def __init__(self, slugs, journal):
        self.slugs, self.journal = slugs, journal
        self.lock = threading.RLock()
        self.latest, self.counts = {}, collections.Counter()
        self.last_transport_at, self.connected, self.failure = None, False, None

    def ingest(self, data, at):
        with self.lock:
            self.last_transport_at = at
            self.counts["messages"] += 1
            try:
                data = normalize_market_message(data)
            except (ValueError, TypeError):
                self.counts["rejected_book_messages"] += 1
                return
            if not isinstance(data, dict):
                self.counts["invalid_messages"] += 1
                return
            if "error" in data:
                self.failure = "subscription_error"
                return
            if "heartbeat" in data:
                self.counts["heartbeats"] += 1
                return
            if "marketData" not in data:
                self.counts["non_full_book_messages"] += 1
                return
            try:
                md = safe_market_data(data["marketData"], self.slugs)
                book_at = MODEL.stamp(md["transactTime"])
            except (ValueError, TypeError, KeyError, ArithmeticError):
                self.counts["rejected_book_messages"] += 1
                return
            slug = md["marketSlug"]
            old = self.latest.get(slug)
            conflict = False
            if old:
                old_at = MODEL.stamp(old["body"]["transactTime"])
                if book_at < old_at:
                    self.counts["out_of_order_messages"] += 1
                    self.journal.add("stream_out_of_order", {"slug":slug, "received_at":at, "book_at":book_at})
                    return
                conflict = book_at == old_at and md != old["body"]
            ref = self.journal.add("stream_book", {"received_at":at, "market_data":md})
            self.latest[slug] = {"body":md, "received_at":at, "evidence":ref,
                                "integrity_issue": conflict or bool(old and old.get("integrity_issue") and book_at == old_at)}
            self.counts["full_book_messages"] += 1
            if inspect_stream(md, slug, at)["usable"] and not self.latest[slug]["integrity_issue"]:
                self.counts["fresh_executable_book_messages"] += 1

    def snapshot(self, slug, at):
        with self.lock:
            row = copy.deepcopy(self.latest.get(slug))
            live = self.connected and not self.failure and self.last_transport_at is not None and at-self.last_transport_at <= 30
        if row is None:
            return {"slug":slug,"usable":False,"issues":["no_full_stream_book"]}
        result = inspect_stream(row["body"], slug, at)
        result.update(evidence=row["evidence"],sample_received_at=row["received_at"])
        if row["integrity_issue"]:
            result["issues"].append("conflicting_book_at_same_venue_time")
        if not live:
            result["issues"].append("stream_disconnected_or_transport_stale")
        result["usable"] = not result["issues"]
        return result


def connect_market_stream(headers):
    import websocket
    websocket.enableTrace(False)
    logging.getLogger("websocket").disabled = True
    conn = websocket.create_connection(WS_URL, header=headers, timeout=8,
        redirect_limit=0, http_no_proxy=["api.polymarket.us"], enable_multithread=True)
    if conn.getstatus() != 101:
        conn.close()
        raise PermissionError("non_101_handshake_redirect_or_denial")
    conn.settimeout(1)
    return conn


def safe_error(exc):
    status = getattr(exc, "status_code", None)
    if status in (401,403):
        return "authentication_denied_" + str(status)
    if status in (301,302,303,307,308):
        return "redirect_refused"
    if status == 429:
        return "handshake_rate_limited"
    # No exception text, handshake headers, request objects or keys are printed.
    return "connection_or_protocol_failure"


def read_stream(conn, state, stop_event):
    import websocket
    try:
        while not stop_event.is_set() and not state.failure:
            try:
                message = conn.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not message:
                state.failure = "stream_closed_early"
                break
            if len(message) > 2*1024*1024:
                state.failure = "stream_message_size_bound"
                break
            try:
                parsed = json.loads(message)
            except (ValueError, UnicodeError):
                state.counts["invalid_json_messages"] += 1
                continue
            state.ingest(parsed, time.time())
    except Exception:
        if not stop_event.is_set():
            state.failure = "stream_receive_failed"
    finally:
        state.connected = False


def select_markets(listing, now):
    if not listing["complete"]:
        raise ValueError("incomplete_public_catalog")
    eligible=[]
    for row in listing["markets"]:
        try:
            at=MODEL.stamp(row.get("gameStartTime"))
            slug=row.get("slug","")
            prefix=re.match(r"^aec-([a-z0-9]+)-",slug)
            # Test the sports used by the frozen study; nearer tennis matches
            # must not silently replace the intended football/basketball/hockey
            # and baseball market-data sample.
            supported=bool(prefix and prefix.group(1) in PROTOCOL["supported_leagues"])
            kind=row.get("sportsMarketType","")
            full_game=kind=="moneyline" or kind.endswith("_full_game_winner")
            if supported and full_game and MODEL.valid_open_market(row) and SLUG.fullmatch(slug) and now-21600 <= at <= now+86400:
                eligible.append((abs(at-now),row["slug"]))
        except (ValueError, TypeError, AttributeError):
            continue
    slugs=list(dict.fromkeys(slug for _,slug in sorted(eligible)))[:3]
    if not slugs:
        raise ValueError("no_open_catalog_sports_markets")
    return slugs


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--seconds",type=int,default=120)
    parser.add_argument("--market-plan",type=Path)
    parser.add_argument("--approved-market-data-only",action="store_true")
    parser.add_argument("--export-public-evidence-in-log",action="store_true")
    args=parser.parse_args(argv)
    if not args.approved_market_data_only or not 20 <= args.seconds <= 300:
        parser.error("Explicit data-only authorization and 20..300 second bound required")
    result={"kind":"market_data_connection_smoke","passed":False,
        "credentials_configured":False,"authenticated_handshake":False,
        "ready_for_new_paper_study":False,"full_24_hour_test_started":False,
        "orders_or_private_account_requests":0,"sampling_seconds_requested":args.seconds}
    journal,conn,worker,stop,state=None,None,None,threading.Event(),None
    started=None
    try:
        key=os.environ.get("PMUS_DATA_KEY_ID","").strip()
        secret=os.environ.get("PMUS_DATA_SECRET_KEY","").strip()
        result["credential_shape"]=credential_shape(key,secret)
        auth_headers(key,secret)  # Validate presence/format before any network use.
        result["credentials_configured"]=True
        journal=Journal(args.output,evidence_limit=16*1024*1024,body_limit=16*1024*1024)
        client=PublicClient(journal,deadline=time.time()+180)
        listing=catalog(client)
        slugs=select_markets(listing,time.time())
        if args.market_plan is not None:
            requested=list(json.loads(args.market_plan.read_bytes())["markets"])
            eligible={row["slug"] for row in listing["markets"] if MODEL.valid_open_market(row)}
            subscription(requested)  # Enforce the same bounded public market set.
            if not set(requested) <= eligible:
                raise ValueError("watch_plan_not_in_current_catalog")
            slugs=requested
        result["market_slugs"]=slugs
        # Secrets are used solely here. They are not journaled or printed.
        try:
            conn=connect_market_stream(auth_headers(key,secret))
        except Exception as exc:
            result["failure"]=safe_error(exc)
            return finish(args,result,journal)
        del key,secret
        result["authenticated_handshake"]=True
        state=StreamState(slugs,journal)
        state.connected=True
        conn.send(json.dumps(subscription(slugs)))
        worker=threading.Thread(target=read_stream,args=(conn,state,stop),daemon=True)
        worker.start()
        started=time.time()
        result["started_at"]=MODEL.iso(started)
        end=started+args.seconds
        client.deadline=end+8
        ticks=[]
        tick=0
        while time.time()<end and not state.failure:
            scheduled=started+tick*20
            if scheduled>time.time():
                stop.wait(min(scheduled-time.time(),max(0,end-time.time())))
            if time.time()>=end:
                break
            observations={}
            for slug in slugs:
                rest_response=client.get("https://gateway.polymarket.us/v1/markets/"+slug+"/book")
                at=time.time()
                rest=inspect_book(rest_response,slug,now=at)
                stream=state.snapshot(slug,at)
                observations[slug]={"rest":rest,"stream":stream,"comparison":compare_stream(rest,stream)}
                if not scheduled<=rest_response["received_at"]<scheduled+20:
                    observations[slug]["outside_observation_slot"]=True
            row={"tick":tick,"scheduled_at":scheduled,"finished_at":time.time(),"markets":observations}
            journal.add("stream_rest_comparison",row)
            ticks.append(row)
            tick=max(tick+1,math.ceil((time.time()-started)/20))
        result.update(finished_at=MODEL.iso(time.time()),actual_ticks=len(ticks),
            expected_ticks=math.ceil(args.seconds/20),counts=dict(state.counts),
            failure=state.failure)
        per_market={}
        for slug in slugs:
            rows=[t["markets"][slug] for t in ticks]
            per_market[slug]={"fresh_stream_ticks":sum(x["stream"]["usable"] and not x.get("outside_observation_slot",False) for x in rows),
                "fresh_rest_ticks":sum(x["rest"]["usable"] and not x.get("outside_observation_slot",False) for x in rows),
                "matched_fresh_pairs":sum(x["comparison"]["matched"] and not x.get("outside_observation_slot",False) for x in rows),
                "last_stream_book_at":next((x["stream"].get("book_at") for x in reversed(rows) if x["stream"].get("book_at") is not None),None),
                "last_rest_book_age_seconds":rows[-1]["rest"].get("book_age_seconds") if rows else None}
        result["markets"]=per_market
        result["passed"]=bool(not result["failure"] and len(ticks)==result["expected_ticks"] and all(x["fresh_stream_ticks"]>0 and x["matched_fresh_pairs"]>0 for x in per_market.values()))
        if not result["passed"] and not result["failure"]:
            result["failure"]="incomplete_fresh_stream_or_rest_comparison"
    except ValueError as exc:
        # Only known static validation codes are emitted, never input values.
        allowed_codes={"missing_key_id","missing_secret_key","invalid_key_id_format",
            "invalid_secret_key_format","incomplete_public_catalog","no_open_catalog_sports_markets",
            "watch_plan_not_in_current_catalog"}
        result["failure"]=str(exc) if str(exc) in allowed_codes else "validation_failed"
    except Exception as exc:
        result["failure"]=safe_error(exc)
    finally:
        stop.set()
        if worker is not None:
            worker.join(timeout=3)
        if conn is not None:
            try: conn.close(timeout=1)
            except Exception: pass
        if worker is not None and worker.is_alive():
            result["passed"]=False
            result["failure"]="reader_shutdown_failed"
    return finish(args,result,journal)


def finish(args,result,journal):
    chunks=[]
    if journal is None:
        # Configuration failures are evidence too. Never write key material.
        args.output.mkdir(parents=True, exist_ok=False)
        from durable import atomic_write
        atomic_write(args.output/"summary.json",canonical(result)+b"\n",immutable=True)
    if journal is not None:
        journal.close()
        result["evidence"]=verify_journal(journal.path)
        if args.export_public_evidence_in_log:
            # Public market-only proof, never headers, credentials or accounts.
            paths=[journal.path,*sorted((journal.root/"bodies").glob("*.xz"))]
            if sum(p.stat().st_size for p in paths)<=512*1024:
                buff=io.BytesIO()
                with zipfile.ZipFile(buff,"w",compression=zipfile.ZIP_STORED) as archive:
                    for p in paths:
                        if p.is_symlink():
                            raise ValueError("unexpected_evidence_symlink")
                        archive.writestr(str(p.relative_to(journal.root)),p.read_bytes())
                data=buff.getvalue()
                encoded=base64.b64encode(data).decode()
                chunks=[encoded[i:i+8000] for i in range(0,len(encoded),8000)]
                result["log_evidence"]={"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"chunks":len(chunks)}
            else:
                result["log_evidence"]={"exported":False,"reason":"public_log_size_cap"}
        (journal.root/"summary.json").write_bytes(canonical(result)+b"\n")
    print("PMUS_STREAM_SUMMARY_JSON="+json.dumps(result,sort_keys=True))
    for index,chunk in enumerate(chunks):
        print("PMUS_STREAM_EVIDENCE_CHUNK_"+str(index)+"="+chunk)
    return 0 if result["passed"] else 1


if __name__=="__main__":
    raise SystemExit(main())
