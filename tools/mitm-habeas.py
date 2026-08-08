"""mitmproxy addon: separate Habeas's replayed requests from the site's own traffic.

    mitmdump -s tools/mitm-habeas.py --listen-port 8082
    mitmproxy -s tools/mitm-habeas.py --listen-port 8082

Turn on Settings → Advanced → "Mark Habeas requests" in the extension. Every request the runtime makes
then carries `X-Habeas-Debug: <source-id>/<n>`.

What this addon does with it:

  1. **Marks the flow** — comment `habeas ing-es/12`, plus flow metadata, so the UI shows it and
     `~c habeas` / `~hq "X-Habeas-Debug"` filter to exactly Habeas's calls.
  2. **Strips the header before forwarding.** The origin server never sees it. That matters: the whole
     premise of Habeas is that its traffic is the user's own traffic, and a marker the service can read
     would give that away. The tag exists for your proxy, not for them.
  3. **Answers the CORS preflight for it.** Habeas replays the SPA's custom headers, so a cross-origin
     call is preflighted; without this the browser would block the request whenever the API does not
     list `x-habeas-debug` in `Access-Control-Allow-Headers`. The addon adds it to the response and
     removes it from the outgoing `Access-Control-Request-Headers`, so a strict API stays happy and
     never learns the header was ever asked for.

Net effect: the marker is visible in your log, invisible to the service, and cannot break the source
you are debugging — which the header alone, without this addon, could.

Optional: `--set habeas_out=<path.jsonl>` appends one JSON line per Habeas request/response pair.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from mitmproxy import ctx, http

# mitmproxy dropped ctx.log in favour of stdlib logging (removed by v11); this works on both.
log = logging.getLogger(__name__)

HEADER = "X-Habeas-Debug"
HEADER_LC = HEADER.lower()
ACRH = "Access-Control-Request-Headers"
ACAH = "Access-Control-Allow-Headers"


def load(loader):
    loader.add_option(
        "habeas_out", Optional[str], None,
        "Append Habeas request/response pairs to this JSONL file (contains real data — delete it when done).",
    )
    loader.add_option(
        "habeas_compare", Optional[str], None,
        "Also log requests to this URL substring even when untagged, so the site's own call can be diffed "
        "against Habeas's replay of it. Header VALUES are never written — only names, plus a short digest "
        "for the few that carry secrets, which is enough to tell 'absent' from 'present but different'.",
    )
    loader.add_option(
        "habeas_keep_header", bool, False,
        "Forward X-Habeas-Debug to the origin instead of stripping it. Off by default: forwarding makes "
        "Habeas identifiable to the service, which is the one thing running in your own session avoids.",
    )


# Header values that must never reach a log file. A short digest still distinguishes "absent" from
# "present but different", which is all a replay diff needs.
SECRET_HEADERS = {"authorization", "cookie", "set-cookie", "x-csrf-token", "x-xsrf-token", "x-api-key"}


def _tag_of(flow: http.HTTPFlow) -> Optional[str]:
    return flow.request.headers.get(HEADER)


def _safe_headers(headers) -> dict:
    import hashlib
    out = {}
    for k, v in headers.items():
        if k.lower() in SECRET_HEADERS:
            out[k] = f"<{len(v)} chars, sha1:{hashlib.sha1(v.encode()).hexdigest()[:8]}>"
        else:
            out[k] = v
    return out


def _compare_hit(flow: http.HTTPFlow) -> bool:
    want = ctx.options.habeas_compare
    return bool(want) and want in flow.request.pretty_url


def request(flow: http.HTTPFlow) -> None:
    # A preflight does not carry our header; it ANNOUNCES it. Remember it and take it out of the
    # announcement, so a strict API is never asked to allow a header it has never heard of.
    if flow.request.method == "OPTIONS" and ACRH in flow.request.headers:
        asked = [h.strip() for h in flow.request.headers[ACRH].split(",")]
        if any(h.lower() == HEADER_LC for h in asked):
            flow.metadata["habeas_preflight"] = True
            kept = [h for h in asked if h.lower() != HEADER_LC]
            if kept:
                flow.request.headers[ACRH] = ", ".join(kept)
            else:
                del flow.request.headers[ACRH]
            flow.comment = "habeas preflight"
        return

    tag = _tag_of(flow)
    if not tag:
        return

    flow.metadata["habeas"] = tag
    source = tag.split("/")[0]
    flow.metadata["habeas_source"] = source
    flow.comment = f"habeas {tag}"
    flow.marked = ":triangular_flag_on_post:"

    if not ctx.options.habeas_keep_header:
        del flow.request.headers[HEADER]


def response(flow: http.HTTPFlow) -> None:
    # Put the header back into the preflight's allow-list so the browser lets the real request through.
    if flow.metadata.get("habeas_preflight") and flow.response is not None:
        allowed = flow.response.headers.get(ACAH, "")
        names = [h.strip() for h in allowed.split(",") if h.strip()]
        if not any(h.lower() == HEADER_LC for h in names):
            names.append(HEADER)
        flow.response.headers[ACAH] = ", ".join(names)
        return

    tag = flow.metadata.get("habeas")
    compare = _compare_hit(flow)
    if (not tag and not compare) or flow.response is None:
        return

    status = flow.response.status_code
    if tag and status >= 400:
        # The failures are the reason you are running this at all — make them impossible to scroll past.
        flow.marked = ":x:"
        flow.comment = f"habeas {tag} — HTTP {status}"
        log.warning(f"[habeas] {tag} {status} {flow.request.method} {flow.request.pretty_url}")

    out = ctx.options.habeas_out
    if not out:
        return
    try:
        with open(out, "a", encoding="utf-8") as fh:
            rec = {
                "by": "habeas" if tag else "site",   # untagged flows on a compared URL are the SPA's own
                "tag": tag,
                "source": flow.metadata.get("habeas_source"),
                "method": flow.request.method,
                "url": flow.request.pretty_url,
                "status": status,
                "reqHeaders": _safe_headers(flow.request.headers),
            }
            # Response bodies are the user's actual data. Only ever written for Habeas's own calls, and
            # never for a comparison flow, whose whole point is the request side.
            if tag:
                rec["resHeaders"] = dict(flow.response.headers)
                rec["resBody"] = flow.response.get_text(strict=False)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:  # a debugging aid must never break the flow it observes
        log.warning(f"[habeas] could not append to {out}: {e}")
