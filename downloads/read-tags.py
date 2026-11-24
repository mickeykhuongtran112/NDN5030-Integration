"""Read EPC/TID on a trusted LAN using Python 3.11+ and websockets>=14."""
import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import ssl
import tempfile
import time
import uuid

from websockets.sync.client import connect


def remember(path, value, replace=False):
    if path.is_file() and path.read_text() == value:
        return
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        f.write(value)
        temp = Path(f.name)
    try:
        if replace:
            os.replace(temp, path)
        else:
            try:
                os.link(temp, path)
            except FileExistsError:
                if path.read_text() != value:
                    raise ValueError(f"Identity changed. Verify the device before replacing {path}.")
    finally:
        temp.unlink(missing_ok=True)


def read(args):
    # Bootstrap on a trusted LAN. The WSS handshake must present the exact
    # leaf we fetched. Only hello is sent before checking the persisted ID/pin.
    pem = ssl.get_server_certificate((args.host, args.port), timeout=5)
    der = ssl.PEM_cert_to_DER_cert(pem)
    pem_hash = hashlib.sha256(der).hexdigest()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.check_hostname = False  # This example identifies the board by its pinned certificate.
    tls.load_verify_locations(cadata=pem)
    address = f"[{args.host}]" if ":" in args.host else args.host
    uri = f"wss://{address}:{args.port}/v1/control"
    with connect(uri, ssl=tls, open_timeout=5, close_timeout=2, max_size=8192) as ws:
        if ws.socket.getpeercert(binary_form=True) != der:
            raise ValueError("Reader certificate changed during connection.")
        ids = itertools.count(1)
        deadline = time.monotonic() + 12
        operation = str(uuid.uuid4())
        active_session = None
        early_tags = []
        observed = set()

        def on_tag(data):
            if data.get("session_id") == active_session and data.get("board_id") == board and data.get("boot_id") == hello["boot_id"]:
                sequence = data["seq"]
                if sequence > 0 and sequence not in observed:
                    observed.add(sequence)
                    print(sequence, data.get("epc_hex"), data.get("tid_hex"))
        terminal = None

        def receive():
            nonlocal terminal
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Reader response or final tag watermark timed out.")
            message = json.loads(ws.recv(timeout=remaining))
            data = message.get("params", {})
            if message.get("method") == "inventory.tags":
                if active_session is None:
                    early_tags.append(data)
                else:
                    on_tag(data)
            if message.get("method") == "inventory.state" and data.get("start_op_id") == operation and data["state"] in ("finished", "unknown"):
                terminal = data
            return message

        def rpc(method, **params):
            request_id = next(ids)
            ws.send(json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)))
            while True:
                message = receive()
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(message["error"])
                    return message["result"]

        hello = rpc("hello")
        board = hello["board_id"]
        if hello.get("api_major") != 1 or hello.get("module_family") != "nation" or not board:
            raise ValueError("Unsupported reader.")
        args.trust_dir.mkdir(parents=True, exist_ok=True)
        def record(kind, key):
            return args.trust_dir / (kind + "-" + hashlib.sha256(key.encode()).hexdigest())
        endpoint_record = record("endpoint", uri)
        if args.board_id and board != args.board_id:
            raise ValueError(f"Expected {args.board_id}, received {board}.")
        if not args.board_id and endpoint_record.exists() and endpoint_record.read_text() != board:
            raise ValueError("A different reader now uses this IP. Select the board by ID.")
        remember(record("reader", board), pem_hash)
        remember(endpoint_record, board, replace=bool(args.board_id))
        print(board, rpc("reader.get_config"))
        while rpc("status.get")["state"] != "idle":
            time.sleep(.1)
        lease = rpc("lease.acquire")["lease_id"]
        # This bounded run fits inside the five-second lease.
        session = rpc("inventory.start", lease_id=lease, op_id=operation, mode="scenario",
                      antenna_sequence=[1], data="epc_tid", max_duration_ms=1200)
        active_session = session["session_id"]
        for data in early_tags:
            on_tag(data)
        while terminal is None or len(observed) < terminal["last_seq"]:
            receive()
        rpc("lease.release", lease_id=lease)
        if (terminal["outcome"] != "success" or terminal["state"] != "finished"
                or terminal["board_id"] != board or terminal["boot_id"] != hello["boot_id"]
                or terminal["session_id"] != active_session or max(observed, default=0) != terminal["last_seq"]
                or len(observed) != terminal["last_seq"] or terminal["reported_drops"] or terminal["input_errors"]):
            raise RuntimeError(f"Incomplete inventory: {terminal}")
        print(f"{board} {session['session_id']} finished, {len(observed)} observations")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--board-id")
    parser.add_argument("--trust-dir", type=Path, default=Path.home() / ".ndn5030-python")
    read(parser.parse_args())
