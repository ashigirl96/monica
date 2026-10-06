#!/usr/bin/env python3
"""Feedback loop: does a burst of PTY output leave the attached connection silently dead?

Starts the given tania-ptyd in a throwaway home, attaches one client that consumes frames with
an optional per-frame delay (stand-in for the Shell's per-frame cost), cats the fixture in the
session, then echoes a marker. RED = the marker never arrives while requests still succeed.
"""
import argparse, base64, json, os, shutil, socket, subprocess, sys, tempfile, threading, time

p = argparse.ArgumentParser()
p.add_argument("--ptyd", default="/Applications/tania.app/Contents/MacOS/tania-ptyd")
p.add_argument("--fixture", required=True)
p.add_argument("--settle", type=float, default=3.0)
p.add_argument("--policy", default=None, help="drop|resume, written to <home>/prototype-lag-policy")
p.add_argument("--delay-ms", type=float, default=0.0)
p.add_argument("--noise-sessions", type=int, default=0, help="other attached sessions printing continuously, like agent TUIs")
p.add_argument("--stall-ms", type=float, default=0.0, help="one-off stall of the reader when the burst starts")
args = p.parse_args()

home = tempfile.mkdtemp(prefix="tania-burst-", dir=os.environ.get("TMPDIR"))
zdot = os.path.join(home, "zdot"); os.makedirs(zdot)
if args.policy: open(os.path.join(home, "prototype-lag-policy"), "w").write(args.policy)
log = open(os.path.join(home, "ptyd.stderr"), "w+")
daemon = subprocess.Popen([args.ptyd, "--tania-home", home, "--foreground"], stderr=log, stdout=log)
sock_path = os.path.join(home, "ptyd.sock")
for _ in range(100):
    if os.path.exists(sock_path): break
    time.sleep(0.05)

s = socket.socket(socket.AF_UNIX); s.connect(sock_path)
rf = s.makefile("rb")
lock = threading.Lock(); pending = {}; frames = []; out = bytearray(); burst_seen = threading.Event()
next_id = [1]
pause_next = threading.Event(); stall_hit = []

def send(op, want_reply=True):
    with lock:
        rid = next_id[0]; next_id[0] += 1
    msg = dict(op);
    if want_reply: msg["id"] = rid
    ev = threading.Event(); pending[rid] = [ev, None]
    s.sendall((json.dumps(msg) + "\n").encode())
    if not want_reply: return None
    if not ev.wait(5): return "TIMEOUT"
    return pending[rid][1]

def reader():
    stalled = False
    for line in rf:
        m = json.loads(line)
        if m["type"] in ("ok", "err"):
            e = pending.get(m["id"]);
            if e: e[1] = m; e[0].set()
        elif m["type"] == "output":
            data = base64.b64decode(m["data"])
            frames.append(len(data))
            if m["session_id"] == "ts-burst": out.extend(data)
            if pause_next.is_set() and not stalled:
                stalled = True; stall_hit.append(time.time()); time.sleep(args.stall_ms / 1000)
            if args.delay_ms: time.sleep(args.delay_ms / 1000)

threading.Thread(target=reader, daemon=True).start()
send({"op": "hello", "version": 1})
sid = "ts-burst"
send({"op": "create", "session_id": sid, "cwd": home, "shell": "/bin/zsh", "rows": 50, "cols": 200,
      "env": [["ZDOTDIR", zdot], ["PS1", "$ "]]})
att = send({"op": "attach", "session_id": sid})
replay = base64.b64decode(att["replay"]) if isinstance(att, dict) and "replay" in att else b""
for i in range(args.noise_sessions):
    nid = f"ts-noise-{i}"
    send({"op": "create", "session_id": nid, "cwd": home, "shell": "/bin/zsh", "rows": 50, "cols": 200,
          "env": [["ZDOTDIR", zdot], ["PS1", "$ "]]})
    send({"op": "attach", "session_id": nid})
    send({"op": "write", "session_id": nid, "data": base64.b64encode(b"while :; do printf 'spinner %s\\r' $RANDOM; sleep 0.02; done\r").decode()}, want_reply=False)
time.sleep(0.5)
w = lambda t: send({"op": "write", "session_id": sid, "data": base64.b64encode(t.encode()).decode()}, want_reply=False)
if args.stall_ms: pause_next.set()
w(f"cat {args.fixture}\r")
time.sleep(args.settle)
marker = f"MARK{os.getpid()}"
w(f"echo {marker.lower()}_$((1+1)) | tr a-z A-Z\r")  # only the shell's output contains MARKxxx_2
deadline = time.time() + args.settle
expect = f"{marker}_2".encode()
while time.time() < deadline and expect not in out: time.sleep(0.05)
got_marker = expect in out
listed = send({"op": "list"})
attached = None
if isinstance(listed, dict):
    attached = [x["attached"] for x in listed.get("sessions", []) if x["session_id"] == sid]
log.flush(); log.seek(0); ptyd_log = log.read()
dropped = "dropping lagged connection" in ptyd_log
for l in ptyd_log.splitlines():
    if "lost" in l or "caught up on ts-burst" in l: print("  ptyd:", l)

print(f"policy={args.policy} noise={args.noise_sessions} delay_ms={args.delay_ms} stall_ms={args.stall_ms} frames={len(frames)} "
      f"max_frame={max(frames) if frames else 0} median_frame={sorted(frames)[len(frames)//2] if frames else 0} "
      f"bytes={len(out)} stall_hit={bool(stall_hit)}")
print(f"ptyd_dropped={dropped} marker_after_burst={got_marker} list_reply={'ok' if isinstance(listed, dict) else listed} attached={attached}")
tdir = os.path.join(home, "terminal-sessions")
disk = b""
for name in (f"{sid}.log.1", f"{sid}.log"):
    path = os.path.join(tdir, name)
    if os.path.exists(path): disk += open(path, "rb").read()
received = replay + bytes(out)
if os.environ.get("DUMP"): open(os.environ["DUMP"]+".recv","wb").write(received); open(os.environ["DUMP"]+".disk","wb").write(disk)
gapless = received.endswith(disk) if len(received) >= len(disk) else disk.endswith(received)
print(f"received={len(received)}B transcript_on_disk={len(disk)}B gapless_and_no_dup={gapless}")
verdict = "RED (connection silently dead after burst)" if (not got_marker and isinstance(listed, dict)) else ("RED (gap or duplicate)" if not gapless else "GREEN")
print(verdict)
send({"op": "terminate", "session_id": sid}, want_reply=False)
daemon.terminate(); daemon.wait(); shutil.rmtree(home, ignore_errors=True)
sys.exit(1 if verdict.startswith("RED") else 0)
