#!/usr/bin/env python3
"""PROTOTYPE (throwaway): does the real Shell lose its ptyd connection on a burst?

Joins the dev ptyd as a second, never-attaching connection, so the Shell stays the only reader of
output. Injects `cat <fixture>` into the target Terminal Session, optionally with other attached
sessions printing (agent-TUI stand-in) and CPU load, then asks ptyd whether the Shell is still
attached. RED = the Shell's attachment is gone (the Workbench is frozen).
"""
import argparse, base64, datetime, glob, json, os, socket, subprocess, sys, threading, time

p = argparse.ArgumentParser()
p.add_argument("--home", required=True)
p.add_argument("--target", required=True)
p.add_argument("--noise", nargs="*", default=[])
p.add_argument("--fixture", required=True)
p.add_argument("--repeat", type=int, default=1, help="cat the fixture this many times back to back")
p.add_argument("--cpu-load", type=int, default=0, help="number of busy-loop processes during the burst")
p.add_argument("--settle", type=float, default=4.0)
p.add_argument("--desktop-log", default=None)
p.add_argument("--shell-stall-ms", type=int, default=0, help="stall the Shell's reader once as the burst starts")
p.add_argument("--policy", default=None, help="drop|resume, written to <home>/prototype-lag-policy")
args = p.parse_args()

s = socket.socket(socket.AF_UNIX); s.connect(os.path.join(args.home, "ptyd.sock"))
rf = s.makefile("rb"); replies = {}; next_id = [1]

def reader():
    for line in rf:
        m = json.loads(line)
        if m["type"] in ("ok", "err") and m["id"] in replies:
            replies[m["id"]][1] = m; replies[m["id"]][0].set()
threading.Thread(target=reader, daemon=True).start()

def request(op):
    rid = next_id[0]; next_id[0] += 1
    replies[rid] = [threading.Event(), None]
    s.sendall((json.dumps({**op, "id": rid}) + "\n").encode())
    return replies[rid][1] if replies[rid][0].wait(5) else None

def write(sid, text):
    s.sendall((json.dumps({"op": "write", "session_id": sid, "data": base64.b64encode(text.encode()).decode()}) + "\n").encode())

def attached():
    r = request({"op": "list"})
    return {x["session_id"]: x["attached"] for x in r["sessions"]} if r else {}

def tail_from(path, offset):
    if not path or not os.path.exists(path): return []
    with open(path, "rb") as f:
        f.seek(offset); return f.read().decode(errors="replace").splitlines()

def size(path): return os.path.getsize(path) if path and os.path.exists(path) else 0

request({"op": "hello", "version": 1})
ptyd_log = os.path.join(args.home, "logs", f"ptyd_{datetime.date.today().isoformat()}.log")
offsets = (size(ptyd_log), size(args.desktop_log))

before = attached()
missing = [sid for sid in [args.target, *args.noise] if not before.get(sid)]
if missing:
    sys.exit(f"not attached by the Shell (show these Tabs first): {missing}")

# Write to the session's tty from outside: the bytes reach ptyd through the PTY master exactly like
# a command's output would, without depending on the user's zsh line editor.
pids = {x["session_id"]: x["pid"] for x in request({"op": "list"})["sessions"]}
def tty(sid):
    name = subprocess.run(["ps", "-o", "tty=", "-p", str(pids[sid])], capture_output=True, text=True).stdout.strip()
    return f"/dev/{name}"

stop_noise = threading.Event()
def noise(path):
    with open(path, "w") as f:
        i = 0
        while not stop_noise.is_set():
            f.write(f"\rspinner {i:08d} ⠋ thinking…"); f.flush(); i += 1; time.sleep(0.02)
noise_threads = [threading.Thread(target=noise, args=(tty(sid),), daemon=True) for sid in args.noise]
for t in noise_threads: t.start()
time.sleep(0.5)
load = [subprocess.Popen(["/usr/bin/yes"], stdout=subprocess.DEVNULL) for _ in range(args.cpu_load)]
target_tty = tty(args.target)
if args.policy:
    with open(os.path.join(args.home, "prototype-lag-policy"), "w") as f: f.write(args.policy)
if args.shell_stall_ms:
    with open(os.path.join(args.home, "prototype-stall-ms"), "w") as f: f.write(str(args.shell_stall_ms))
burst = subprocess.Popen(["/bin/sh", "-c", f'for i in $(seq {args.repeat}); do cat "$0"; done; echo BURST-DONE', args.fixture],
                         stdout=open(target_tty, "w"))
burst.wait()
time.sleep(args.settle)
for proc in load: proc.kill()
stop_noise.set()
time.sleep(0.6)
# One late frame closes the Shell reader's stats window, so it reports the burst.
with open(target_tty, "w") as f: f.write("\a")
time.sleep(0.5)
after = attached()

ptyd_lines = tail_from(ptyd_log, offsets[0])
desk_lines = [l for l in tail_from(args.desktop_log, offsets[1]) if "DEBUG-lag" in l]
dropped = [l for l in ptyd_lines if "dropping lagged" in l]
print(f"fixture={os.path.basename(args.fixture)}x{args.repeat} noise={len(args.noise)} cpu_load={args.cpu_load}")
print(f"shell_attached target={after.get(args.target)} noise={[after.get(n) for n in args.noise]}")
print("--- ptyd [DEBUG-lag] / drops")
for l in ptyd_lines:
    if "DEBUG-lag" in l or "dropping" in l: print("  " + l)
print("--- shell reader [DEBUG-lag]")
for l in desk_lines: print("  " + l)
transcript = os.path.join(args.home, "terminal-sessions", f"{args.target}.log")
with open(transcript, "rb") as f:
    f.seek(max(0, size(transcript) - 4096)); burst_reached_ptyd = b"BURST-DONE" in f.read()
print(f"burst_reached_ptyd={burst_reached_ptyd}")
if not burst_reached_ptyd:
    sys.exit("INVALID: the burst never reached ptyd")
verdict = "RED (Shell connection dropped: Workbench frozen)" if (dropped or not after.get(args.target)) else "GREEN"
print(verdict)
sys.exit(1 if verdict.startswith("RED") else 0)
