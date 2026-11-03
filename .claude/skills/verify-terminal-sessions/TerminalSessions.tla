---------------------------- MODULE TerminalSessions ----------------------------
\* The Workbench books (Terminal Session rows and Tabs) against the shells that
\* monica-ptyd runs. Each action names the code it stands for; SKILL.md has the table.
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N, MaxDrops, MaxRestarts, MaxCrashes, Mutant

Ids == 1..N
Slots == {"pinned", "plain"}
Live == {"starting", "running"}
Mutants == {"none", "reconcileLosesUnsent", "closeSkipsTerminate",
            "reconcileKeepsTabless", "createIgnoresExit", "exitsDuringListDropped",
            "sendWithoutStartingCheck"}

VARIABLES
  row,       \* terminal_session.status, "none" when there is no row
  tab,       \* tab.terminalSessionId per Tab, 0 when the Tab does not exist
  cns,       \* createNotSent in terminal-session.ts
  waiting,   \* work awaiting ready(): create() and sendTerminate(), in promise order
  inflight,  \* requests sent on the connection whose answer has not come
  bconn,     \* the Backend's view: "down", "hello", "listing", "up"
  exitQ,     \* exitsDuringReconcile in workbench.ts
  toPtyd, fromPtyd, pconn, orphan,
  ptydReply, \* the answer dispatch() made, not yet on the outbox
  ptydUp, sess, killed,
  used, mayLose, drops, restarts, crashes

vars == <<row, tab, cns, waiting, inflight, bconn, exitQ, toPtyd, fromPtyd, pconn,
          orphan, ptydReply, ptydUp, sess, killed, used, mayLose, drops, restarts, crashes>>

Shown(s) == \E t \in Slots : tab[t] = s

Ascending(S) ==
  LET f[i \in 0..N] == IF i = 0 THEN <<>> ELSE IF i \in S THEN Append(f[i - 1], i) ELSE f[i - 1]
  IN f[N]

CreatesIn(q) == {q[i].id : i \in {j \in 1..Len(q) : q[j].op = "create"}}

\* Backend-side state as one record, so sequential code reads as composed operators.
B == [row |-> row, tab |-> tab, cns |-> cns, waiting |-> waiting, toPtyd |-> toPtyd, used |-> used]

SetB(b) == /\ row' = b.row /\ tab' = b.tab /\ cns' = b.cns
           /\ waiting' = b.waiting /\ toPtyd' = b.toPtyd /\ used' = b.used

\* PtydClient.notify / request: a frame written after ptyd stopped reading is lost.
Send(b, req) == IF pconn = "open" THEN [b EXCEPT !.toPtyd = Append(@, req)] ELSE b

\* terminal-session.ts start() / rebind(): a starting row, Create reserved after the transaction.
StartIn(b, t) ==
  IF b.used = N THEN b
  ELSE LET s == b.used + 1 IN
       [b EXCEPT !.row[s] = "starting", !.tab[t] = s, !.cns = @ \cup {s},
                 !.waiting = Append(@, [op |-> "create", id |-> s]), !.used = s]

\* layout.ts removeTab() + terminal-session.ts terminateRemoved().
RemoveTabIn(b, t) ==
  [b EXCEPT !.tab[t] = 0, !.waiting = Append(@, [op |-> "terminate", id |-> b.tab[t]])]

\* layout.ts settleEndedTabs(); pin.ts shouldRespawn() is taken as always true for exited and lost.
SettleSlot(b, t, ids) ==
  LET s == b.tab[t] IN
  IF s = 0 \/ s \notin ids \/ b.row[s] \in Live THEN b
  ELSE IF t = "pinned" /\ b.row[s] \in {"exited", "lost"} THEN StartIn(b, t)
  ELSE IF t = "plain" /\ b.row[s] = "exited" THEN RemoveTabIn(b, t)
  ELSE b

Settle(b, ids) == SettleSlot(SettleSlot(b, "pinned", ids), "plain", ids)

\* terminal-session.ts recordExit(): only a live row ends, then Reap.
RecordExitIn(b, s) ==
  Send([b EXCEPT !.row[s] = IF @ \in Live THEN "exited" ELSE @], [op |-> "reap", id |-> s])

OnExitIn(b, s) == Settle(RecordExitIn(b, s), {s})

RECURSIVE Replay(_, _)
Replay(b, q) == IF q = <<>> THEN b ELSE Replay(OnExitIn(b, Head(q)), Tail(q))

\* terminal-session.ts reconcile() on the List answer, then the rest of workbench.ts connect().
Reconcile(snap) ==
  LET newRow == [s \in Ids |->
        IF row[s] \notin Live THEN row[s]
        ELSE IF snap[s] = "none"
             THEN IF s \in cns /\ Mutant # "reconcileLosesUnsent" THEN row[s] ELSE "lost"
        ELSE IF snap[s] = "tomb" THEN "exited"
        ELSE "running"]
      toTerminate == {s \in Ids : snap[s] = "live" /\
                        (row[s] \notin Live \/ (~Shown(s) /\ Mutant # "reconcileKeepsTabless"))}
      toReap == {s \in Ids : snap[s] = "tomb"}
      reaps == [i \in 1..Cardinality(toReap) |-> [op |-> "reap", id |-> Ascending(toReap)[i]]]
      terms == [i \in 1..Cardinality(toTerminate) |->
                  [op |-> "terminate", id |-> Ascending(toTerminate)[i]]]
      b1 == [B EXCEPT !.row = newRow, !.toPtyd = IF pconn = "open" THEN @ \o reaps ELSE @,
                      !.waiting = @ \o terms]
      b2 == IF Mutant = "exitsDuringListDropped" THEN b1 ELSE Replay(b1, exitQ)
  IN Settle(b2, Ids)

\* Microtasks run before the Backend handles any more I/O or requests.
MustFlush == bconn = "up" /\ waiting # <<>>

----------------------------------------------------------------------------------
Init ==
  /\ row = [s \in Ids |-> "none"] /\ tab = [t \in Slots |-> 0]
  /\ cns = {} /\ waiting = <<>> /\ inflight = <<>> /\ bconn = "down" /\ exitQ = <<>>
  /\ toPtyd = <<>> /\ fromPtyd = <<>> /\ pconn = "closed" /\ orphan = FALSE
  /\ ptydReply = <<>> /\ ptydUp = FALSE /\ sess = [s \in Ids |-> "none"] /\ killed = {}
  /\ used = 0 /\ mayLose = {} /\ drops = 0 /\ restarts = 0 /\ crashes = 0

\* tab.open, runspace.create, task run: layout.ts openTab() commits.
OpenTab(t) ==
  /\ ~MustFlush /\ tab[t] = 0 /\ used < N
  /\ SetB(StartIn(B, t))
  /\ UNCHANGED <<ptydReply, inflight, bconn, exitQ, fromPtyd, pconn, orphan, ptydUp, sess, killed,
                 mayLose, drops, restarts, crashes>>

\* The caller's transaction throws after openTab(): the row is gone, the reservation is not.
OpenTabRolledBack ==
  /\ ~MustFlush /\ used < N
  /\ LET s == used + 1 IN
     /\ cns' = cns \cup {s} /\ waiting' = Append(waiting, [op |-> "create", id |-> s])
     /\ used' = s
  /\ UNCHANGED <<ptydReply, row, tab, inflight, bconn, exitQ, toPtyd, fromPtyd, pconn, orphan, ptydUp,
                 sess, killed, mayLose, drops, restarts, crashes>>

\* tab.close (Ctrl+T d, runspace.remove, task close): layout.ts closeTab() commits.
CloseTab ==
  /\ ~MustFlush /\ tab["plain"] # 0
  /\ IF Mutant = "closeSkipsTerminate"
       THEN tab' = [tab EXCEPT !["plain"] = 0] /\ UNCHANGED waiting
       ELSE tab' = RemoveTabIn(B, "plain").tab /\ waiting' = RemoveTabIn(B, "plain").waiting
  /\ UNCHANGED <<ptydReply, row, cns, inflight, bconn, exitQ, toPtyd, fromPtyd, pconn, orphan, ptydUp,
                 sess, killed, used, mayLose, drops, restarts, crashes>>

\* tab.respawn (New shell): layout.ts respawnTab() on a Tab whose session ended.
RespawnTab(t) ==
  /\ ~MustFlush /\ tab[t] # 0 /\ row[tab[t]] \notin Live /\ used < N
  /\ SetB(StartIn(B, t))
  /\ UNCHANGED <<ptydReply, inflight, bconn, exitQ, fromPtyd, pconn, orphan, ptydUp, sess, killed,
                 mayLose, drops, restarts, crashes>>

\* terminal-session.ts create() and sendTerminate() resume once ready() resolves.
Flush ==
  /\ MustFlush
  /\ LET w == Head(waiting) IN
     /\ waiting' = Tail(waiting)
     /\ IF w.op = "create"
          THEN /\ cns' = cns \ {w.id}
               /\ IF row[w.id] = "starting" \/ Mutant = "sendWithoutStartingCheck"
                    THEN /\ toPtyd' = Send(B, w).toPtyd /\ inflight' = Append(inflight, w)
                         /\ mayLose' = IF pconn = "open" THEN mayLose ELSE mayLose \cup {w.id}
                    ELSE UNCHANGED <<toPtyd, inflight, mayLose>>
          ELSE /\ toPtyd' = Send(B, w).toPtyd /\ inflight' = Append(inflight, w)
               /\ UNCHANGED <<cns, mayLose>>
  /\ UNCHANGED <<ptydReply, row, tab, bconn, exitQ, fromPtyd, pconn, orphan, ptydUp, sess, killed, used,
                 drops, restarts, crashes>>

\* workbench.ts connect(): openDaemon() opens the socket, spawning ptyd if none answers.
Connect ==
  /\ bconn = "down" /\ (pconn = "closed" \/ orphan) /\ toPtyd = <<>> /\ ptydReply = <<>>
  /\ ptydUp' = TRUE /\ pconn' = "open" /\ orphan' = FALSE /\ fromPtyd' = <<>>
  /\ bconn' = "hello"
  /\ UNCHANGED <<ptydReply, row, tab, cns, waiting, inflight, exitQ, toPtyd, sess, killed, used, mayLose,
                 drops, restarts, crashes>>

\* ptyd.ts openDaemon() setHandlers() after hello, then connect() sends List.
HelloDone ==
  /\ ~MustFlush /\ bconn = "hello"
  /\ bconn' = "listing" /\ toPtyd' = Send(B, [op |-> "list", id |-> 0]).toPtyd
  /\ UNCHANGED <<ptydReply, row, tab, cns, waiting, inflight, exitQ, fromPtyd, pconn, orphan, ptydUp, sess,
                 killed, used, mayLose, drops, restarts, crashes>>

\* PtydClient.receive() -> dispatch() -> the Backend's handlers.
Receive ==
  /\ ~MustFlush /\ bconn \in {"hello", "listing", "up"} /\ fromPtyd # <<>>
  /\ LET m == Head(fromPtyd) IN
     /\ fromPtyd' = Tail(fromPtyd)
     /\ CASE bconn = "hello" ->
               UNCHANGED <<row, tab, cns, waiting, inflight, bconn, exitQ, toPtyd, used>>
          [] bconn = "listing" /\ m.type = "exit" ->
               /\ exitQ' = Append(exitQ, m.id)
               /\ UNCHANGED <<row, tab, cns, waiting, inflight, bconn, toPtyd, used>>
          [] bconn = "listing" /\ m.type = "list" ->
               /\ SetB(Reconcile(m.snap)) /\ bconn' = "up" /\ exitQ' = <<>>
               /\ UNCHANGED inflight
          [] bconn = "up" /\ m.type = "exit" ->
               /\ SetB(OnExitIn(B, m.id))
               /\ UNCHANGED <<inflight, bconn, exitQ>>
          [] bconn = "up" /\ m.type = "reply" ->
               /\ inflight' = Tail(inflight)
               /\ row' = IF m.op = "create" /\ (row[m.id] = "starting" \/ Mutant = "createIgnoresExit")
                           THEN [row EXCEPT ![m.id] = IF m.ok THEN "running" ELSE "failed"]
                           ELSE row
               /\ UNCHANGED <<tab, cns, waiting, bconn, exitQ, toPtyd, used>>
  /\ UNCHANGED <<ptydReply, pconn, orphan, ptydUp, sess, killed, mayLose, drops, restarts, crashes>>

\* PtydClient.shutdown() -> workbench.ts onClose() / connect() throws; reconnect() retries.
BackendSeesClose ==
  /\ ~MustFlush /\ bconn \in {"hello", "listing", "up"} /\ pconn = "closed" /\ fromPtyd = <<>>
  /\ LET retried == SelectSeq(inflight, LAMBDA r : r.op = "terminate") IN
     waiting' = waiting \o retried
  /\ bconn' = "down" /\ inflight' = <<>> /\ exitQ' = <<>>
  /\ UNCHANGED <<ptydReply, row, tab, cns, toPtyd, fromPtyd, pconn, orphan, ptydUp, sess, killed, used,
                 mayLose, drops, restarts, crashes>>

\* The Backend stops or dies; the desktop starts a new one with the same DB.
BackendRestart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ cns' = {} /\ waiting' = <<>> /\ inflight' = <<>> /\ exitQ' = <<>> /\ bconn' = "down"
  /\ mayLose' = mayLose \cup cns
  /\ orphan' = (pconn = "open")
  /\ fromPtyd' = <<>>
  /\ UNCHANGED <<ptydReply, row, tab, toPtyd, pconn, ptydUp, sess, killed, used, drops, crashes>>

\* crates/terminal-daemon daemon/connection.rs dispatch() on one connection thread.
PtydServe ==
  /\ ptydUp /\ pconn = "open" /\ toPtyd # <<>> /\ ptydReply = <<>>
  /\ LET r == Head(toPtyd)
         Reply(msg) == <<msg>>
     IN
     /\ toPtyd' = Tail(toPtyd)
     /\ CASE r.op = "create" ->
               \/ /\ sess[r.id] = "none" /\ sess' = [sess EXCEPT ![r.id] = "live"]
                  /\ ptydReply' = Reply([type |-> "reply", op |-> "create", id |-> r.id, ok |-> TRUE])
                  /\ UNCHANGED mayLose
               \/ /\ sess' = sess /\ mayLose' = mayLose \cup {r.id}
                  /\ ptydReply' = Reply([type |-> "reply", op |-> "create", id |-> r.id, ok |-> FALSE])
             /\ UNCHANGED killed
          [] r.op = "terminate" ->
               /\ UNCHANGED mayLose
               /\ killed' = IF sess[r.id] = "live" THEN killed \cup {r.id} ELSE killed
               /\ ptydReply' = Reply([type |-> "reply", op |-> "terminate", id |-> r.id, ok |-> TRUE])
               /\ UNCHANGED sess
          [] r.op = "reap" ->
               /\ UNCHANGED mayLose
               /\ sess' = IF sess[r.id] = "tomb" THEN [sess EXCEPT ![r.id] = "none"] ELSE sess
               /\ UNCHANGED <<ptydReply, killed>>
          [] r.op = "list" ->
               /\ UNCHANGED mayLose
               /\ ptydReply' = Reply([type |-> "list", snap |-> sess])
               /\ UNCHANGED <<sess, killed>>
  /\ UNCHANGED <<row, tab, cns, waiting, inflight, bconn, exitQ, fromPtyd, pconn, orphan, ptydUp,
                 used, drops, restarts, crashes>>

\* connection.rs serve_connection() puts the answer on the outbox outside the table lock,
\* so an Exit from on_exit() can reach the Backend first.
PtydReplies ==
  /\ ptydReply # <<>>
  /\ fromPtyd' = IF orphan THEN fromPtyd ELSE fromPtyd \o ptydReply
  /\ ptydReply' = <<>>
  /\ UNCHANGED <<row, tab, cns, waiting, inflight, bconn, exitQ, toPtyd, pconn, orphan, ptydUp,
                 sess, killed, used, mayLose, drops, restarts, crashes>>

\* The shell ends (exit, Ctrl-D, or the SIGHUP of Terminate); daemon/state.rs on_exit() broadcasts Exit.
ShellExits(s) ==
  /\ sess[s] = "live"
  /\ sess' = [sess EXCEPT ![s] = "tomb"] /\ killed' = killed \ {s}
  /\ fromPtyd' = IF pconn = "open" /\ ~orphan THEN Append(fromPtyd, [type |-> "exit", id |-> s])
                 ELSE fromPtyd
  /\ UNCHANGED <<ptydReply, row, tab, cns, waiting, inflight, bconn, exitQ, toPtyd, pconn, orphan, ptydUp,
                 used, mayLose, drops, restarts, crashes>>

\* ptyd's side of the connection ends: unread requests and unsent messages are dropped.
PtydDropsConn ==
  /\ pconn = "open" /\ drops < MaxDrops
  /\ drops' = drops + 1
  /\ pconn' = "closed" /\ orphan' = FALSE /\ toPtyd' = <<>> /\ fromPtyd' = <<>>
  /\ ptydReply' = <<>>
  /\ mayLose' = mayLose \cup CreatesIn(toPtyd)
  /\ UNCHANGED <<row, tab, cns, waiting, inflight, bconn, exitQ, ptydUp, sess, killed, used,
                 restarts, crashes>>

\* ptyd dies (crash, or openDaemon() replacing it): every shell and tombstone goes with it.
PtydCrash ==
  /\ ptydUp /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ ptydUp' = FALSE /\ sess' = [s \in Ids |-> "none"] /\ killed' = {}
  /\ pconn' = "closed" /\ orphan' = FALSE /\ toPtyd' = <<>> /\ fromPtyd' = <<>>
  /\ ptydReply' = <<>>
  /\ mayLose' = mayLose \cup {s \in Ids : row[s] \in Live} \cup CreatesIn(toPtyd)
  /\ UNCHANGED <<row, tab, cns, waiting, inflight, bconn, exitQ, used, drops, restarts>>

Next ==
  \/ \E t \in Slots : OpenTab(t) \/ RespawnTab(t)
  \/ OpenTabRolledBack \/ CloseTab \/ Flush
  \/ Connect \/ HelloDone \/ Receive \/ BackendSeesClose \/ BackendRestart
  \/ PtydServe \/ PtydReplies \/ PtydDropsConn \/ PtydCrash
  \/ \E s \in Ids : ShellExits(s)

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------------
TypeOK ==
  /\ Mutant \in Mutants
  /\ row \in [Ids -> Live \cup {"none", "exited", "lost", "failed"}]
  /\ tab \in [Slots -> Ids \cup {0}]
  /\ sess \in [Ids -> {"none", "live", "tomb"}]
  /\ bconn \in {"down", "hello", "listing", "up"}

\* Nothing is on its way between the Backend and ptyd, and nothing is waiting to be sent.
Settled ==
  /\ bconn = "up" /\ pconn = "open" /\ ~orphan
  /\ waiting = <<>> /\ inflight = <<>> /\ toPtyd = <<>> /\ fromPtyd = <<>> /\ ptydReply = <<>>
  /\ \A s \in killed : sess[s] # "live"

\* Every shell ptyd runs is shown by a Tab whose row says it is live.
NoHiddenShell == Settled => \A s \in Ids : sess[s] = "live" => (row[s] \in Live /\ Shown(s))

\* Every row that says its shell is live has that shell in ptyd.
NoDeadTab == Settled => \A s \in Ids : row[s] \in Live => sess[s] = "live"

\* A row is lost only after its shell died with ptyd, or its Create was dropped or refused unheard.
LostOnlyWhenLost == \A s \in Ids : row[s] = "lost" => s \in mayLose

\* An ended row never comes back to life.
EndedStaysEnded == [][\A s \in Ids : row[s] \in {"exited", "lost", "failed"} => row'[s] = row[s]]_row

=============================================================================
