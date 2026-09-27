import Toy

/-!
# Hand cross-check of the trust profile

Not part of the `Toy` library (the root module does not import it, and Lake's default
target does not build it). Run it after `lake build`:

    lake env lean Check.lean

Every `#print axioms` line below must agree with the `axioms` field of the same node in
`expected/graph.json`, with two deliberate exceptions marked `lean4#15226` below: on
v4.35.0-rc3 `#print axioms` under-reports `Toy.Signed` and everything whose trust rests on it,
and the extractor must not. See `expected/README.md` for the comparison table.
-/

-- Toy.Axioms
#print axioms Toy.oracle
#print axioms Toy.usesOracle
#print axioms Toy.squareBound
#print axioms Toy.Certified
#print axioms Toy.Certified.mk
#print axioms Toy.Certified.rec
-- lean4#15226: prints "does not depend on any axioms"; the extractor reports [Toy.oracle],
-- which the next line (the constructor) confirms.
#print axioms Toy.Signed
#print axioms Toy.Signed.mk
#print axioms Toy.Signed.rec
#print axioms Toy.Bounded
#print axioms Toy.Bounded.mk
#print axioms Toy.Bounded.n
#print axioms Toy.Bounded.bound

-- Toy.Defs
#print axioms Toy.Color
#print axioms Toy.Color.red
#print axioms Toy.Color.green
#print axioms Toy.Color.blue
#print axioms Toy.Color.next
#print axioms Toy.Color.red_ne_green
#print axioms Toy.Point
#print axioms Toy.Point.mk
#print axioms Toy.Point.x
#print axioms Toy.Point.y
#print axioms Toy.HasSize
#print axioms Toy.HasSize.mk
#print axioms Toy.HasSize.size
#print axioms Toy.instHasSizePoint
#print axioms Toy.Grid
#print axioms Toy.quadruple
#print axioms Toy.quadruple_eq
#print axioms Toy.sumTo
#print axioms Toy.pick
#print axioms Toy.fastEqImpl
#print axioms Toy.fastEq
#print axioms Toy.collatz
#print axioms Toy.cMix
#print axioms Toy.secret

-- Toy.Lemmas
#print axioms Toy.lemma1
#print axioms Toy.lemma2
#print axioms Toy.cleanMain
#print axioms Toy.unfinished
#print axioms Toy.usesUnfinished
#print axioms Toy.bigPower
#print axioms Toy.pick_self
#print axioms Toy.sumTo_succ
#print axioms Toy.next_red
#print axioms Toy.certified_five
#print axioms Toy.certified_trivial
-- lean4#15226: inherits the under-reported entry of `Toy.Signed`; the extractor reports [Toy.oracle].
#print axioms Toy.signed_trivial
#print axioms Toy.boundedFive

-- Toy.Main
#print axioms Toy.everything
