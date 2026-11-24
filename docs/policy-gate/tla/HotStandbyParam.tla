--------------------------- MODULE HotStandbyParam ---------------------------
(***************************************************************************)
(* Rule R-2: for max_connections, max_prepared_transactions,               *)
(* max_locks_per_transaction, max_wal_senders and max_worker_processes,    *)
(* a hot standby's running value must stay >= the primary's, or WAL replay  *)
(* pauses. This models one such setting moving Old -> New on a two-node    *)
(* cluster. conf = value written by ALTER SYSTEM; run = value in effect    *)
(* (changes only on restart).                                              *)
(*                                                                         *)
(* Spec        : unconstrained agent; TLC should FIND a Safe violation     *)
(*               (restart primary first when raising).                     *)
(* GuardedSpec : restarts gated by R-2; Safe holds AND Done is reached,    *)
(*               i.e. the guard never deadlocks the change.                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Old, New

Nodes == {"primary", "standby"}

VARIABLES conf, run
vars == <<conf, run>>

Init == /\ conf = [n \in Nodes |-> Old]
        /\ run  = [n \in Nodes |-> Old]

SetConf(n) == /\ conf[n] # New
              /\ conf' = [conf EXCEPT ![n] = New]
              /\ UNCHANGED run

Restart(n) == /\ run[n] # conf[n]
              /\ run' = [run EXCEPT ![n] = conf[n]]
              /\ UNCHANGED conf

Safe == run["standby"] >= run["primary"]

(* R-2 as a precondition: allow a restart only if the result is still Safe. *)
GuardedRestart(n) == /\ Restart(n)
                     /\ run'["standby"] >= run'["primary"]

Done == run = [n \in Nodes |-> New]

Next        == \E n \in Nodes : SetConf(n) \/ Restart(n)
GuardedNext == \E n \in Nodes : SetConf(n) \/ GuardedRestart(n)

Spec        == Init /\ [][Next]_vars
GuardedSpec == Init /\ [][GuardedNext]_vars /\ WF_vars(GuardedNext)

EventuallyDone == <>Done
=============================================================================
